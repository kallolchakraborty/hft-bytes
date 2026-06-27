---
type: reference
title: "Session Recovery"
description: "Sequence number gap detection: when MsgSeqNum (tag 34) jumps. Resend request (FIX tag 35=2): send BeginSeqNo (7) and EndSeqNo"
tags: ["recovery"]
difficulty: advanced
timestamp: "2026-06-27T03:06:09.432Z"
phase: 8
phaseName: "Exchange Architecture"
category: "Phase 8 - Exchange Architecture"
subcategory: "exchange-architecture"
language: "cpp"
artifact-id: "ZHFT_SESSION_RECOVERY"
---
## Key Learning Points

- Sequence number gap detection: when MsgSeqNum (tag 34) jumps
- Resend request (FIX tag 35=2): send BeginSeqNo (7) and EndSeqNo
- Gap fill rules: exchange responds with sequence-gap messages
- PossDupFlag (43=Y): retransmitted message. Compare by ExecID
- PossResend (tag 97=Y): application-level resend (not session).
- Recovery vs Reset on Logon: Tag 141 (ResetSeqNumFlag).

## Usage

```bash

SessionRecovery recovery(session, order_store);
if (recovery.detectGap()) recovery.requestResend(seq);
recovery.handleGapFill(gap_msg);
```

## Source Code

```cpp
#include <algorithm>
#include <bit>
#include <cstdint>
#include <cstring>
#include <map>
#include <string_view>
#include <unordered_set>
#include <vector>

// ---------------------------------------------------------------------------
// Session recovery state machine
// ---------------------------------------------------------------------------
enum class RecoveryState : uint8_t {
  Normal,
  GapDetected,
  AwaitingResend,
  GapFillInProgress,
  RecoveryComplete,
};

struct SessionRecoveryState {
  RecoveryState state = RecoveryState::Normal;
  uint64_t expected_seq = 1;
  uint64_t gap_begin = 0;
  uint64_t gap_end   = 0;
  uint64_t resend_attempts = 0;
  bool     reset_on_logon = false; // Tag 141
};

// ---------------------------------------------------------------------------
// Gap fill request handler
// ---------------------------------------------------------------------------
class GapFillRequestHandler {
public:
  struct GapFillMessage {
    uint64_t seq;
    uint64_t begin_seq;
    uint64_t end_seq;
    bool     poss_dup;    // Tag 43
    bool     poss_resend; // Tag 97
    bool     gap_fill;    // Tag 123 = Y
  };

  // Detect sequence gap
  bool detectGap(uint64_t received_seq, uint64_t expected_seq,
                 uint64_t &gap_begin, uint64_t &gap_end) {
    if (received_seq > expected_seq) {
      gap_begin = expected_seq;
      gap_end = received_seq - 1;
      return true;
    }
    // Duplicate: received_seq < expected_seq
    // Should check PossDupFlag before rejecting
    return false;
  }

  // Process a gap fill message
  void processGapFill(const GapFillMessage &msg) {
    // Validate gap fill range
    // TRADEOFF: If gap fill covers too wide a range (> 1000 msgs),
    // request a snapshot instead to speed recovery
    if (msg.end_seq - msg.begin_seq > 1000) {
      requestSnapshot();
      return;
    }

    if (msg.gap_fill) {
      // GapFill message (tag 35=4) — just advance seq numbers,
      // no application processing
      advanceSequences(msg.begin_seq, msg.end_seq);
    } else {
      // Sequence-delivered message with PossDupFlag — check for
      // duplicate before processing
      if (msg.poss_dup) {
        auto key = (msg.begin_seq << 32) ^ msg.end_seq;
        if (seen_messages_.count(key)) return; // duplicate
        seen_messages_.insert(key);
      }
      // Process normally
    }
  }

  // Handle resend request response: store all incoming messages
  // to fill the detected gap
  bool isGapFilled(uint64_t gap_begin, uint64_t gap_end) const {
    for (uint64_t s = gap_begin; s <= gap_end; s++) {
      if (!received_messages_.count(s)) return false;
    }
    return true;
  }

private:
  std::unordered_set<uint64_t> seen_messages_;
  std::map<uint64_t, bool> received_messages_;

  void advanceSequences(uint64_t from, uint64_t to) {
    // Just update sequence counter, no app-level processing
  }

  void requestSnapshot() {
    // Request market data snapshot (MDP or EBS snapshot)
    // instead of processing thousands of gap fill messages
  }
};

// ---------------------------------------------------------------------------
// Session recovery orchestration
// ---------------------------------------------------------------------------
class SessionRecovery {
public:
  void onLogon(bool reset_flag) {
    state_.reset_on_logon = reset_flag;
    if (reset_flag) {
      // Reset: start seq at 1
      state_.expected_seq = 1;
      state_.state = RecoveryState::RecoveryComplete;
    } else {
      // Recover: resume from last persisted seq
      state_.expected_seq = loadLastSeq();
      state_.state = RecoveryState::Normal;
    }
  }

  void onMessage(uint64_t seq, bool poss_dup, bool poss_resend) {
    // Check duplicate
    if (poss_dup || poss_resend) {
      if (processed_.count(seq)) {
        return; // already processed — safe to ignore
      }
    }

    // Gap detection
    if (seq > state_.expected_seq) {
      state_.state = RecoveryState::GapDetected;
      state_.gap_begin = state_.expected_seq;
      state_.gap_end = seq - 1;
      requestResend(state_.gap_begin, state_.gap_end);
      return;
    }

    state_.expected_seq = seq + 1;
    state_.state = RecoveryState::Normal;
  }

  void requestResend(uint64_t from, uint64_t to) {
    state_.resend_attempts++;
    // TRADEOFF: limit resend attempts to 3 to avoid infinite loops
    if (state_.resend_attempts > 3) {
      // Escalate: session reset or disconnect
      initiateSessionReset();
      return;
    }
    // Build and send ResendRequest (tag 35=2)
    // with BeginSeqNo=from, EndSeqNo=to
    // (to==0 means all subsequent)
  }

  void processGapFillMessages() {
    // Apply stored gap fill messages
    state_.state = RecoveryState::GapFillInProgress;

    if (handler_.isGapFilled(state_.gap_begin, state_.gap_end)) {
      state_.state = RecoveryState::RecoveryComplete;
      state_.resend_attempts = 0;
    }
  }

private:
  SessionRecoveryState state_;
  GapFillRequestHandler handler_;
  std::unordered_set<uint64_t> processed_;

  uint64_t loadLastSeq() {
    // From mmap journal
    return 1;
  }

  void initiateSessionReset() {
    // Disconnect and reconnect with ResetSeqNumFlag=Y
  }
};
```
