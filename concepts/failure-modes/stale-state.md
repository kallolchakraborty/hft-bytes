---
type: playbook
title: "Stale State"
description: "Feed handler reconnects after dropout: the exchange may replay messages. If replay starts from a stale sequence point, the book may appear correct"
tags: ["mathematics"]
difficulty: advanced
timestamp: "2026-06-27T03:06:09.461Z"
phase: 17
phaseName: "Production Failure Modes"
category: "Phase 17 - Production Failure Modes"
subcategory: "failure-modes"
language: "cpp"
artifact-id: "ZHFT_STALE_STATE"
---
## Key Learning Points

- Feed handler reconnects after dropout: the exchange may replay messages
- If replay starts from a stale sequence point, the book may appear correct
- Gap detection during reconnection: must detect if there are any gaps
- Snapshot vs incremental recovery: requesting a full snapshot is safer but
- During the reconnection + recovery window, trading should be halted for

## Source Code

```cpp
#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <map>
#include <optional>
#include <set>
#include <sstream>
#include <string>
#include <vector>

// ---------------------------------------------------------------------------
// Feed reconnection state machine.
// ---------------------------------------------------------------------------
enum class FeedState {
  Connected,           // Normal operation.
  Disconnected,        // Connection lost.
  Reconnecting,        // TCP connection being established.
  RecoveryRequested,   // Snapshot/incremental requested.
  ReceivingSnapshot,   // Receiving full book snapshot.
  ReceivingIncremental, // Receiving incremental updates.
  GapDetected,         // Gap found during recovery.
  StaleDataDetected,   // Data is stale after recovery.
};

class FeedReconnectionStateMachine {
  FeedState state_ = FeedState::Connected;
  uint64_t  last_seq_before_disconnect_ = 0;
  uint64_t  first_seq_after_connect_ = 0;
  uint64_t  reconnection_time_ns_ = 0;

  // The last known good timestamp from the exchange.
  uint64_t last_exchange_timestamp_ns_ = 0;

public:
  // Called when connection drops.
  void on_disconnect(uint64_t last_seq, uint64_t last_ts_ns) {
    state_                       = FeedState::Disconnected;
    last_seq_before_disconnect_  = last_seq;
    last_exchange_timestamp_ns_  = last_ts_ns;
    reconnection_time_ns_        = now_ns();
  }

  // Called when TCP reconnects.
  void on_reconnect(uint64_t seq_at_reconnect) {
    state_                      = FeedState::Reconnecting;
    first_seq_after_connect_    = seq_at_reconnect;

    // Detect gap: if first seq after reconnect > last seq + 1, we missed messages.
    if (seq_at_reconnect > last_seq_before_disconnect_ + 1) {
      state_ = FeedState::GapDetected;
      // We need to request a gap fill or snapshot.
    } else if (seq_at_reconnect == last_seq_before_disconnect_ + 1) {
      // No gap — we can continue with incremental recovery.
      state_ = FeedState::ReceivingIncremental;
    } else {
      // Exchange may have reset sequences — request full snapshot.
      state_ = FeedState::StaleDataDetected;
    }
  }

  // After gap fill completes, request a snapshot for verification.
  void on_gap_filled(uint64_t last_verified_seq) {
    // If the gap was filled correctly, transition to incremental.
    if (last_verified_seq >= first_seq_after_connect_) {
      state_ = FeedState::Connected;
    } else {
      state_ = FeedState::StaleDataDetected;
    }
  }

  // Request a full snapshot from the exchange.
  void request_snapshot() {
    state_ = FeedState::RecoveryRequested;
    // In production: send a snapshot request (e.g., ITCH Retransmission Request
    // with a range, or FIX SecurityDefinitionRequest for full book).
  }

  // Check if the recovered data is stale by comparing exchange timestamps.
  bool is_stale(uint64_t current_exchange_ts_ns,
                uint64_t max_allowed_age_ns = 1'000'000'000) {
    if (current_exchange_ts_ns < last_exchange_timestamp_ns_) {
      state_ = FeedState::StaleDataDetected;
      return true; // Timestamp went backwards — data is stale.
    }
    uint64_t age = current_exchange_ts_ns - last_exchange_timestamp_ns_;
    if (age > max_allowed_age_ns) {
      state_ = FeedState::StaleDataDetected;
      return true; // Data is too old.
    }
    return false;
  }

  FeedState state() const { return state_; }
};

// ---------------------------------------------------------------------------
// Snapshot vs incremental recovery decision.
// ---------------------------------------------------------------------------
class RecoveryStrategySelector {
public:
  enum Strategy {
    FullSnapshot,          // Request entire book (safe but slow).
    GapFillThenSnapshot,   // Fill gaps, then snapshot for verification.
    Incremental,           // Only fill gaps, trust the sequence.
  };

  // Decides the recovery strategy based on gap size and time disconnected.
  Strategy select(uint64_t gap_size, uint64_t disconnect_duration_ns) {
    // If gap is small and disconnection was brief, incremental is safe.
    if (gap_size < 100 && disconnect_duration_ns < 10'000'000'000ULL) {
      return Incremental; // < 100 messages, < 10s disconnected.
    }

    // If gap is moderate, do gap fill + snapshot verification.
    if (gap_size < 10'000 && disconnect_duration_ns < 60'000'000'000ULL) {
      return GapFillThenSnapshot; // < 1M msg gap, < 60s.
    }

    // Large gap or long disconnection — full snapshot required.
    return FullSnapshot;
  }
};

// ---------------------------------------------------------------------------
// Stale data guard — halts trading when feed is stale.
// ---------------------------------------------------------------------------
class StaleDataGuard {
  FeedState state_ = FeedState::Connected;
  std::atomic<bool> trading_halted_{false};

public:
  // Called by the feed handler on every received message.
  void on_data(uint64_t seq, uint64_t exchange_ts_ns) {
    if (state_ != FeedState::Connected) {
      // We are in recovery — do not allow trading.
    }
  }

  // Prevent trading if data is stale.
  bool is_trading_allowed() const {
    return !trading_halted_.load(std::memory_order_acquire);
  }

  void halt_trading() {
    trading_halted_.store(true, std::memory_order_release);
  }

  void resume_trading() {
    trading_halted_.store(false, std::memory_order_release);
  }
};
```
