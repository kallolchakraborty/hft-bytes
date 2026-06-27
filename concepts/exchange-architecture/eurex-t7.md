---
type: reference
title: "Eurex T7"
description: "EBS (Enhanced Broadcast Solution): market data publish-subscribe.. Packet structure: SBE header (8 bytes: BlockLength, TemplateID,"
tags: ["phase-8"]
difficulty: intermediate
timestamp: "2026-06-27T03:06:09.429Z"
phase: 8
phaseName: "Exchange Architecture"
category: "Phase 8 - Exchange Architecture"
subcategory: "exchange-architecture"
language: "cpp"
artifact-id: "ZHFT_EUREX_T7"
---
## Key Learning Points

- **EBS (Enhanced Broadcast Solution)**: Eurex's market data protocol — a publish-subscribe model over UDP multicast. Each instrument has its own multicast group. Market data updates are incremental (SBE-encoded) with periodic snapshots for full book rebuild. EBS is separate from the order entry protocol (T7 uses a different TCP session for orders). For HFT: subscribe to both incremental and snapshot feeds; use the snapshot to validate your incremental book state every N seconds
- **Packet structure**: SBE header (8 bytes: BlockLength, TemplateID, SchemaID, Version) followed by the message body. TemplateID identifies the message type (e.g., 1002 = EnterOrder, 1003 = ModifyOrder). The SBE schema is defined in an XML file provided by Eurex — compile it with the SBE tool to generate C++ structs. The fixed SBE layout means zero-parse decoding: memcpy the wire buffer directly into the struct. For HFT: pre-allocate decode buffers on the stack (no heap allocation in the hot path)
- **Nanosecond timestamps**: TransactTime field is nanoseconds since epoch (not milliseconds like some exchanges). Eurex uses PTP-synchronized clocks — hardware timestamping at the NIC gives sub-microsecond accuracy. For timestamp ordering across venues: convert all timestamps to nanoseconds before comparison. Eurex's nanosecond precision enables more accurate latency measurement than millisecond-resolution exchanges
- **Mass quotes**: only available for registered market makers (quote providers). Max leg count: 50 per quote message. Mass quotes update multiple instruments simultaneously — critical for options market making where you need to quote across strikes and expiries atomically. The quote must be submitted within a strict time window (measured from the market data timestamp that triggered it). Late quotes are rejected. For HFT: build the mass quote message in pre-allocated memory and send it in a single write() call to minimize latency
- **Session recovery**: Eurex uses sequence numbers per message stream (order entry and market data have separate streams). On disconnect, the session enters recovery mode — you request retransmission from the last acknowledged sequence number. Eurex sends a RetransmitResponse with the retransmitted messages. Critical: during recovery, do NOT send new orders until you've replayed all retransmitted messages and your book state is consistent. Order state can change during the gap (fills, cancels) — reprocessing in the wrong order causes position mismatches
- **Order lifecycle**: EnterOrder (template 1002) → OrderAccepted → ModifyOrder/DeleteOrder → Fill/PartialFill/CancelReject. Each state transition is acknowledged. The exchange rejects orders that violate risk limits (fat-finger checks, position limits). Eurex has a "self-trade prevention" rule — matching your own orders at the same price level triggers a cancel. For HFT: monitor RejectCode in OrderRejected messages — common codes: 10001 (price collar), 10002 (size limit), 10003 (self-trade)

## Usage

```bash

T7Session t7;
t7.connect("10.0.0.2", 9200);
t7.login("user", "pass");
t7.enterOrder({...});
auto exec = t7.receive();
```

## Source Code

```cpp
#include <algorithm>
#include <bit>
#include <cstdint>
#include <cstring>
#include <span>
#include <string_view>
#include <vector>

// ---------------------------------------------------------------------------
// T7 SBE message header
// ---------------------------------------------------------------------------
struct alignas(8) T7SbeHeader {
  uint16_t block_length;
  uint16_t template_id;
  uint16_t schema_id;
  uint16_t version;
};

static_assert(sizeof(T7SbeHeader) == 8);

// ---------------------------------------------------------------------------
// Key T7 message templates
// ---------------------------------------------------------------------------

// Logon (template 100)
struct alignas(8) T7LogonRequest {
  static constexpr uint16_t kTemplateId = 100;
  T7SbeHeader header{40, kTemplateId, 1, 0};
  char    username[20];
  char    password_hash[32]; // SHA-256 hash
  uint8_t session_mode;      // 0=normal, 1=recovery
  uint64_t request_time;
};

// Enter New Order (template 1002)
struct alignas(8) T7EnterOrder {
  static constexpr uint16_t kTemplateId = 1002;
  T7SbeHeader header{56, kTemplateId, 1, 0};
  char     cl_ord_id[20];
  uint64_t order_id;         // 0 = exchange assigns
  char     symbol[12];
  uint64_t quantity;
  uint64_t display_qty;      // Iceberg: displayed portion
  uint64_t min_qty;          // Minimum acceptable fill qty
  double   price;            // 0 for market order
  double   stop_price;       // 0 if not stop
  uint8_t  side;             // 1=buy, 2=sell
  uint8_t  ord_type;         // 1=market, 2=limit, 3=stop, 4=stop_limit
  uint8_t  time_in_force;    // 0=day, 1=GTC, 3=IOC, 4=FOK, 6=GTD
  uint64_t transact_time;    // Nanoseconds since epoch
  uint32_t maturity_date;    // For futures (YYYYMMDD packed)
  uint8_t  cancel_on_disconnect; // 0=no, 1=yes
};

// Modify Order (template 1003)
struct alignas(8) T7ModifyOrder {
  static constexpr uint16_t kTemplateId = 1003;
  T7SbeHeader header{40, kTemplateId, 1, 0};
  uint64_t order_id;
  uint64_t quantity;
  uint64_t display_qty;
  double   price;
  double   stop_price;
  uint8_t  time_in_force;
  uint64_t transact_time;
};

// Delete Order (template 1004)
struct alignas(8) T7DeleteOrder {
  static constexpr uint16_t kTemplateId = 1004;
  T7SbeHeader header{16, kTemplateId, 1, 0};
  uint64_t order_id;
  uint64_t transact_time;
};

// Mass Cancel (template 1005)
struct alignas(8) T7MassCancel {
  static constexpr uint16_t kTemplateId = 1005;
  T7SbeHeader header{24, kTemplateId, 1, 0};
  uint8_t  cancel_type; // 0=symbol, 1=side, 2=all, 3=strategy
  char     symbol[12];  // empty if cancel_type=2
  uint8_t  side;        // 0=both, 1=buy, 2=sell
  uint64_t transact_time;
};

// ---------------------------------------------------------------------------
// T7 Session
// ---------------------------------------------------------------------------
class T7Session {
public:
  void connect(const char *host, uint16_t port) {
    // TCP connect with TCP_NODELAY, SO_KEEPALIVE
  }

  void login(const char *user, const char *password) {
    T7LogonRequest req;
    std::memcpy(req.username, user, std::min(strlen(user), size_t(19)));
    // SHA-256 password hash
    req.request_time = getNanoseconds();
    send(reinterpret_cast<const uint8_t *>(&req), sizeof(req));
  }

  void enterOrder(const T7EnterOrder &ord) {
    send(reinterpret_cast<const uint8_t *>(&ord), sizeof(ord));
  }

  void modifyOrder(const T7ModifyOrder &mod) {
    send(reinterpret_cast<const uint8_t *>(&mod), sizeof(mod));
  }

  void deleteOrder(uint64_t order_id) {
    T7DeleteOrder del;
    del.order_id = order_id;
    del.transact_time = getNanoseconds();
    send(reinterpret_cast<const uint8_t *>(&del), sizeof(del));
  }

  void massCancel(uint8_t type, std::string_view symbol = {}) {
    T7MassCancel mc;
    mc.cancel_type = type;
    if (!symbol.empty())
      std::memcpy(mc.symbol, symbol.data(), std::min(symbol.size(), size_t(11)));
    mc.transact_time = getNanoseconds();
    send(reinterpret_cast<const uint8_t *>(&mc), sizeof(mc));
  }

private:
  int fd_ = -1;
  uint64_t seq_ = 1;

  void send(const uint8_t *data, size_t len) {
    // Write with sequence number tracking
    // TRADEOFF: use writev() for zero-copy when combining
    // header + body from non-contiguous memory
    ::write(fd_, data, len);
  }

  static uint64_t getNanoseconds() {
    struct timespec ts;
    ::clock_gettime(CLOCK_REALTIME, &ts);
    return ts.tv_sec * 1'000'000'000ULL + ts.tv_nsec;
  }
};
```
