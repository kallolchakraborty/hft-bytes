---
type: playbook
title: "Partial Fill"
description: "Partial fill received but no further execution: was the rest of the. Iceberg orders: exchange returns a partial fill for the visible portion"
tags: ["phase-17"]
difficulty: advanced
timestamp: "2026-06-27T03:06:09.460Z"
phase: 17
phaseName: "Production Failure Modes"
category: "Phase 17 - Production Failure Modes"
subcategory: "failure-modes"
language: "cpp"
artifact-id: "ZHFT_PARTIAL_FILL"
---
## Key Learning Points

- Partial fill received but no further execution: was the rest of the
- Iceberg orders: exchange returns a partial fill for the visible portion
- Partial fill + cancel race: a fill arrives at the same time as the cancel
- The only safe approach: after a partial fill with no further message,

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
// Partial fill state resolver.
// ---------------------------------------------------------------------------
// Tracks each order's fill state and detects ambiguous situations.
// ---------------------------------------------------------------------------
struct OrderFillState {
  uint64_t    order_id;
  uint32_t    ordered_qty;
  uint32_t    total_filled_qty;
  uint32_t    last_fill_qty;
  uint64_t    last_fill_time_ns;
  bool        cancel_sent;       // Did we send a cancel?
  bool        cancel_acked;      // Did the exchange confirm cancellation?
  bool        received_done;     // Did we receive a "Done" / ExecutionReport with ExecType=D?
  uint64_t    open_timeout_ns;   // If no further message by this time, query exchange.

  // Computed state.
  enum class Ambiguity {
    None,          // Order is fully resolved.
    PartialNoDone, // Partial fill received but no Done/ExecType=D (still working?).
    FillCancelRace,// Fill and cancel ack arrived in same processing window.
    Iceberg,       // Iceberg order — remaining qty is unknown.
  };

  Ambiguity detect_ambiguity(uint64_t now_ns) const {
    bool partially_filled = total_filled_qty > 0 &&
                            total_filled_qty < ordered_qty;

    if (!partially_filled) return Ambiguity::None;

    // If we received a cancel ack after the fill, we don't know if the fill
    // happened before or after the cancel.
    if (cancel_acked && last_fill_time_ns > 0) {
      // If fill and cancel ack are within the same 100µs window, it's a race.
      auto fill_ack_gap = now_ns - last_fill_time_ns;
      if (fill_ack_gap < 100'000) { // 100µs window.
        return Ambiguity::FillCancelRace;
      }
    }

    // If partial fill received but no Done/CancelAck, the rest may be working.
    if (!received_done && !cancel_sent) {
      // The order is still working on the exchange.
      return Ambiguity::PartialNoDone;
    }

    // If cancel was sent but not yet acked, and we got a partial fill.
    if (cancel_sent && !cancel_acked) {
      return Ambiguity::FillCancelRace;
    }

    return Ambiguity::None;
  }
};

// ---------------------------------------------------------------------------
// Remaining order query manager — sends order status requests.
// ---------------------------------------------------------------------------
class RemainingOrderQueryManager {
  // Orders where we need to query the exchange for current state.
  std::map<uint64_t, OrderFillState> pending_queries_;

public:
  // Schedule a status query for an ambiguous order.
  void query_remaining(uint64_t order_id) {
    // In production: send OrderStatusRequest (FIX 35=H, MsgType=H).
    // Store the request so we can match the response.
  }

  // Process the exchange's response to our status query.
  struct StatusResponse {
    uint64_t    order_id;
    uint32_t    cum_qty;     // Cumulative filled quantity.
    uint32_t    leaves_qty;  // Remaining open quantity.
    std::string ord_status;  // "NEW", "PARTIALLY_FILLED", "FILLED", "CANCELLED"
  };

  enum class Resolution {
    FullyFilled,
    StillWorking,
    Cancelled,
    Unknown,
  };

  Resolution resolve(const StatusResponse &resp) {
    if (resp.ord_status == "FILLED" || resp.leaves_qty == 0) {
      return Resolution::FullyFilled;
    }
    if (resp.ord_status == "CANCELLED") {
      return Resolution::Cancelled;
    }
    if (resp.ord_status == "PARTIALLY_FILLED" || resp.ord_status == "NEW") {
      return Resolution::StillWorking;
    }
    return Resolution::Unknown;
  }
};

// ---------------------------------------------------------------------------
// Fill/Cancel race detector.
// ---------------------------------------------------------------------------
class FillCancelRaceDetector {
  // When a cancel is sent, the order enters a "race window".
  // Any fill received during this window is ambiguous.
  struct RaceWindow {
    uint64_t order_id;
    uint64_t cancel_sent_ns;
    uint64_t race_window_end_ns;  // Cancel is confirmed after this time.
  };

  std::map<uint64_t, RaceWindow> active_races_;

public:
  // Called when we send a cancel.
  void on_cancel_sent(uint64_t order_id) {
    uint64_t now = now_ns();
    active_races_[order_id] = {
        .order_id          = order_id,
        .cancel_sent_ns    = now,
        .race_window_end_ns = now + 10'000'000, // 10ms race window.
    };
  }

  // Called when we receive a fill.
  // Returns true if the fill could be from before the cancel took effect.
  bool is_in_race_window(uint64_t order_id) {
    auto it = active_races_.find(order_id);
    if (it == active_races_.end()) return false;
    return now_ns() < it->second.race_window_end_ns;
  }

  // Called when we receive a cancel ack — race window closes.
  void on_cancel_acked(uint64_t order_id) {
    active_races_.erase(order_id);
  }

private:
  uint64_t now_ns() const {
    return std::chrono::duration_cast<std::chrono::nanoseconds>(
               std::chrono::steady_clock::now().time_since_epoch())
        .count();
  }
};
```
