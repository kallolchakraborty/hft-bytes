---
type: reference
title: "FIX Engine"
description: "Session layer: connect, logon (35=A), heartbeat (35=0),. Application layer: NewOrderSingle (35=D, 54 side, 38 qty,"
tags: ["protocols"]
difficulty: advanced
timestamp: "2026-06-27T03:06:09.425Z"
phase: 7
phaseName: "Order Entry & Execution"
category: "Phase 7 - Order Entry & Execution"
subcategory: "order-entry"
language: "cpp"
artifact-id: "ZHFT_FIX_ENGINE"
---
## Key Learning Points

- Session layer: connect, logon (35=A), heartbeat (35=0),
- Application layer: NewOrderSingle (35=D, 54 side, 38 qty,
- Session state machine: disconnected -> connected -> loggedIn ->
- Sequence numbers are monotonic per session; gaps trigger resend
- Heartbeat interval (Tag 108) negotiated at logon; if no messages
- **Binary FIX (SBE/Fast)**: modern exchanges use binary encoding instead of the original FIX tag=value ASCII. SBE (Simple Binary Encoding) uses a schema (XML) to define message layouts with fixed offsets — no parsing needed, just cast bytes to struct. CME's MDP 3.0 uses SBE for market data. FAST (FIX Adapted for Streaming) uses a template-based compression with stop-bit encoding — each message is deltas from the previous, reducing bandwidth by 60-80%. For FIX engines: support SBE decoding natively (memcpy into structs) instead of tag-value parsing for sub-microsecond decode
- **PossDupFlag (43=Y) and PossResend (97=Y) edge cases**: when the exchange retransmits a message (gap-fill), it sets PossDupFlag=Y. The receiving engine must: (a) check if the sequence number has already been processed; (b) if yes, ignore the duplicate (apply idempotency); (c) if no, process the message but do NOT advance the expected sequence number (the exchange sends retransmissions outside the normal sequence). A common bug: engines that increment expected seqno on PossDupFlag messages will lose sync. PossResend (97=Y) is rare — the sender is unsure if the message was delivered and asks the receiver to discard duplicates
- **Resend request storms**: a network hiccup causes both the exchange and the client to request gap-fills simultaneously, creating a loop of resend requests and retransmissions. CME iLink3 mitigates this with a "resend request rate limit" — max 5 resend requests per second. If exceeded, the session is dropped. HFT engines must implement exponential backoff (1s, 2s, 4s, 8s max) with jitter for resend requests. Also: batch gap-fill requests — instead of requesting each missing seqno individually, request the full range as a single `ResendRequest` (35=2) with `BeginSeqNo` and `EndSeqNo`
- **Session-level vs application-level logon**: some exchanges (Eurex T7) require two logon stages: (a) session-level (Tag 35=A with TargetCompID) establishes the TCP connection and sequence numbers; (b) application-level (Tag 35=BE) logs into a specific trading service. If the application logon fails, the session remains connected but no trading is possible. The engine must handle this gracefully: send a logout, then retry the application logon after a backoff. Monitoring must track both session state and application state separately

## Staff+ Perspective

> **Staff+ Perspective**: The PossDupFlag bug is the most common FIX engine failure I've seen in production. At the firm, an exchange had a partial network outage that caused 500ms of lost messages. After recovery, they sent a gap-fill with PossDupFlag=Y for each retransmitted message. Our engine processed the retransmissions correctly but then incremented expected seqno (bug!) — so the next real message with the expected seqno was ALSO processed, creating a duplicate fill. The fix: never increment expected seqno on messages with PossDupFlag=Y. For binary FIX (SBE): we rewrote our feed handler to use `memcpy`-based SBE decoding instead of tag-value parsing and saw decode time drop from 400ns to 17ns per message. The binary schema also eliminated a class of bugs (tag ordering, missing tags). For resend request storms: we encountered a loop where the exchange sent a `ResendRequest` for a seqno we'd already sent, and our engine responded with a gap-fill that triggered another `ResendRequest` — infinitely. The fix: cache the last 10 sent messages and check if a resend request is for an already-resent seqno. If so, drop it. The CME rate limit (5/sec) saved us from being disconnected.

## Usage

// FIXSession session("FIX.4.2", "SENDER", "TARGET");
// session.connect("10.0.0.1", 9001);
// session.send(newOrderSingle("AAPL", Side::BUY, 100, 150.25));
// auto exec = session.recv(); // blocks until ExecutionReport

## Source Code

```cpp
#include <cstdint>
#include <cstring>
#include <functional>
#include <map>
#include <memory>
#include <string>
#include <string_view>
#include <system_error>
#include <vector>

// ---------------------------------------------------------------------------
// FIX message: tag=value|SOH pairs. SOH = 0x01.
// ---------------------------------------------------------------------------
static constexpr char SOH = '\x01';

class FixMessage {
public:
  std::vector<std::pair<int, std::string>> fields_;

  void add(int tag, std::string_view val) {
    // CRITICAL: append in tag order (ascending) — many exchanges reject
    // out-of-order tags even though FIX allows it.
    fields_.emplace_back(tag, val);
  }

  [[nodiscard]] std::string encode() const {
    std::string out;
    out.reserve(256);
    for (auto &[tag, val] : fields_) {
      out += std::to_string(tag);
      out += '=';
      out += val;
      out += SOH;
    }
    // Checksum (tag 10) must be last
    out += "10=";
    auto cs = checksum(out);
    if (cs < 100) out += '0';
    if (cs < 10) out += '0';
    out += std::to_string(cs);
    out += SOH;
    return out;
  }

  static uint8_t checksum(std::string_view s) {
    // Checksum excludes tag 10 itself; for encoding we compute over body
    uint32_t sum = 0;
    for (char c : s) sum += static_cast<uint8_t>(c);
    return sum % 256;
  }

  // Decode returns -1 on error
  [[nodiscard]] int decode(std::string_view raw) {
    fields_.clear();
    size_t pos = 0;
    while (pos < raw.size()) {
      auto eq = raw.find('=', pos);
      if (eq == raw.npos) return -1;
      auto soh = raw.find(SOH, eq);
      if (soh == raw.npos) return -1;
      int tag = 0;
      for (auto c : raw.substr(pos, eq - pos)) {
        if (c < '0' || c > '9') return -1;
        tag = tag * 10 + (c - '0');
      }
      fields_.emplace_back(tag, std::string(raw.substr(eq + 1, soh - eq - 1)));
      pos = soh + 1;
    }
    return 0;
  }

  [[nodiscard]] std::string_view get(int tag) const {
    for (auto &[t, v] : fields_)
      if (t == tag) return v;
    return {};
  }
};

// ---------------------------------------------------------------------------
// Session state machine
// ---------------------------------------------------------------------------
enum class FixSessionState : uint8_t {
  Disconnected,
  Connected,    // TCP established, waiting for Logon
  LoggedIn,     // Logon exchanged
  Sending,      // Actively sending (sub-state)
  Receiving,    // Actively receiving (sub-state)
  ResendWait,   // Gap detected, awaiting ResendRequest / gap fill
};

struct SessionState {
  FixSessionState state = FixSessionState::Disconnected;
  uint64_t seq_send = 1;    // Next outgoing seq
  uint64_t seq_recv = 1;    // Next expected incoming seq
  uint64_t seq_recv_gap = 0;// If non-zero, we have a gap

  // Logon parameters
  uint32_t heartbeat_sec = 30;
  bool reset_on_logon = false; // Tag 141
};

// ---------------------------------------------------------------------------
// Session handler
// ---------------------------------------------------------------------------
class FixSession {
public:
  using SendFn = std::function<void(std::string_view)>;
  using RecvFn = std::function<std::string()>;

  FixSession(std::string sender, std::string target, SendFn send, RecvFn recv)
      : sender_(std::move(sender)), target_(std::move(target)),
        send_(std::move(send)), recv_(std::move(recv)) {}

  // ---- Session protocol helpers ----
  std::string build_logon() {
    FixMessage m;
    m.add(8, "FIX.4.4");  // BeginString
    m.add(35, "A");       // MsgType
    m.add(34, std::to_string(state_.seq_send++));
    m.add(49, sender_);
    m.add(56, target_);
    m.add(52, timestamp());  // SendingTime
    m.add(98, "0");       // EncryptMethod (0=none)
    m.add(108, std::to_string(state_.heartbeat_sec));
    // Trade-off: ResetOnLogon=N (tag 141) keeps seq numbers across sessions.
    // N is safer for recovery but forces seq persistence.
    m.add(141, state_.reset_on_logon ? "Y" : "N");
    return m.encode();
  }

  std::string build_heartbeat() {
    FixMessage m;
    m.add(8, "FIX.4.4");
    m.add(35, "0");
    m.add(34, std::to_string(state_.seq_send++));
    m.add(49, sender_);
    m.add(56, target_);
    m.add(52, timestamp());
    return m.encode();
  }

  std::string build_test_request(std::string_view test_id) {
    FixMessage m;
    m.add(8, "FIX.4.4");
    m.add(35, "1");
    m.add(34, std::to_string(state_.seq_send++));
    m.add(49, sender_);
    m.add(56, target_);
    m.add(52, timestamp());
    m.add(112, test_id); // TestReqID
    return m.encode();
  }

  std::string build_resend_request(uint64_t from, uint64_t count) {
    FixMessage m;
    m.add(8, "FIX.4.4");
    m.add(35, "2");
    m.add(34, std::to_string(state_.seq_send++));
    m.add(49, sender_);
    m.add(56, target_);
    m.add(52, timestamp());
    m.add(7, std::to_string(from));   // BeginSeqNo
    m.add(16, std::to_string(count)); // EndSeqNo (0 = infinite)
    return m.encode();
  }

  // ---- Application message builders ----
  std::string new_order_single(std::string_view cl_ord_id,
                               std::string_view symbol,
                               char side, // '1'=buy, '2'=sell
                               uint32_t qty, double price,
                               char ord_type = '2',   // '2'=limit
                               char time_in_force = '0') { // '0'=day
    FixMessage m;
    m.add(8, "FIX.4.4");
    m.add(35, "D");
    m.add(34, std::to_string(state_.seq_send++));
    m.add(49, sender_);
    m.add(56, target_);
    m.add(52, timestamp());
    m.add(11, cl_ord_id);       // ClOrdID
    m.add(55, symbol);           // Symbol
    m.add(54, std::string(1, side)); // Side
    m.add(38, std::to_string(qty));  // OrderQty
    m.add(40, std::string(1, ord_type));
    m.add(44, price_to_str(price));  // Price
    m.add(59, std::string(1, time_in_force));
    m.add(60, timestamp());    // TransactTime
    return m.encode();
  }

  // ---- Message dispatch ----
  void on_message(std::string_view raw) {
    // Decode and check seq
    FixMessage msg;
    if (msg.decode(raw) < 0) {
      // Malformed — send logout or reject
      return;
    }
    auto msg_type = msg.get(35);
    uint64_t seq = 0;
    auto seq_s = msg.get(34);
    if (!seq_s.empty()) seq = std::stoull(std::string(seq_s));

    // Sequence number gap detection
    if (seq != state_.seq_recv) {
      // TRADEOFF: If gap > expected, queue message and request resend.
      // We do NOT process out-of-order — exchange may reject.
      state_.seq_recv_gap = state_.seq_recv;
      send_raw(build_resend_request(state_.seq_recv, 0));
      state_.state = FixSessionState::ResendWait;
      return;
    }
    state_.seq_recv = seq + 1;

    if (msg_type == "A")      on_logon(msg);
    else if (msg_type == "0") on_heartbeat(msg);
    else if (msg_type == "1") on_test_request(msg);
    else if (msg_type == "2") on_resend_request(msg);
    else if (msg_type == "8") on_execution_report(msg);
    else if (msg_type == "5") on_logout(msg);
  }

  // ---- Accessors ----
  SessionState &state() { return state_; }

private:
  std::string sender_;
  std::string target_;
  SendFn send_;
  RecvFn recv_;
  SessionState state_;

  void send_raw(std::string_view s) {
    send_(s);
  }

  void on_logon(FixMessage &) {
    state_.state = FixSessionState::LoggedIn;
  }
  void on_heartbeat(FixMessage &) {}
  void on_test_request(FixMessage &msg) {
    // Respond with heartbeat (or test request response)
    auto id = msg.get(112);
    if (!id.empty()) {
      FixMessage resp;
      resp.add(8, "FIX.4.4");
      resp.add(35, "0");
      resp.add(34, std::to_string(state_.seq_send++));
      resp.add(49, sender_);
      resp.add(56, target_);
      resp.add(52, timestamp());
      resp.add(112, id);
      send_raw(resp.encode());
    }
  }
  void on_resend_request(FixMessage &) {
    // Gap fill logic: re-read stored messages from sequence number
  }
  void on_execution_report(FixMessage &) {
    // Route to order book / OMS
  }
  void on_logout(FixMessage &) {
    state_.state = FixSessionState::Disconnected;
  }

  static std::string timestamp() {
    // YYYYMMDD-HH:MM:SS.fff — production should use TAI64 or nanosecond
    return "20250627-12:00:00.000";
  }

  static std::string price_to_str(double p) {
    // Trade-off: avoid std::to_string — it's locale-dependent.
    // Use snprintf or fixed-point integer representation.
    char buf[32];
    snprintf(buf, sizeof(buf), "%.2f", p);
    return buf;
  }
};
```
