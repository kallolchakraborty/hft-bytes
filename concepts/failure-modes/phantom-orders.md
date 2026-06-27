---
type: playbook
title: "Phantom Orders"
description: "Fill received but no matching sent order: either the exchange alias. Ack received but order never generated: retransmission from exchange of"
tags: ["order-types"]
timestamp: "2026-06-27T03:06:09.460Z"
phase: 17
phaseName: "Production Failure Modes"
category: "Phase 17 - Production Failure Modes"
subcategory: "failure-modes"
language: "cpp"
artifact-id: "ZHFT_PHANTOM_ORDERS"
---
## Key Learning Points

- Fill received but no matching sent order: either the exchange alias
- Ack received but order never generated: retransmission from exchange of
- Duplicate from retransmission: exchange may retransmit an old message
- Exchange ghost order: filled on the exchange but never reported to the

## Source Code

```cpp
#include <algorithm>
#include <array>
#include <atomic>
#include <cstdint>
#include <map>
#include <optional>
#include <set>
#include <sstream>
#include <string>
#include <vector>

// ---------------------------------------------------------------------------
// Order-to-Fill matching engine.
// ---------------------------------------------------------------------------
// Maintains a map of sent orders and received fills, detecting mismatches.
// ---------------------------------------------------------------------------
struct SentOrder {
  uint64_t    order_id;
  std::string cl_ord_id;    // Client-assigned order ID (ClOrdID in FIX).
  std::string symbol;
  int64_t     price;
  uint32_t    qty;
  bool        buy;
  uint64_t    sent_ns;
  bool        acked = false;
};

struct ReceivedFill {
  uint64_t    fill_id;
  std::string cl_ord_id;
  uint64_t    order_id;    // May be 0 if ClOrdID is unknown.
  std::string symbol;
  int64_t     price;
  uint32_t    qty;
  uint64_t    fill_time_ns;
};

class OrderToFillMatcher {
  std::map<uint64_t, SentOrder> sent_orders_;    // By internal order ID.
  std::map<std::string, uint64_t> clord_to_id_;  // ClOrdID → internal ID.

  std::vector<ReceivedFill> unmatched_fills_;    // Phantom candidates.

public:
  uint64_t send_order(const SentOrder &order) {
    uint64_t id = order.order_id;
    sent_orders_[id] = order;
    clord_to_id_[order.cl_ord_id] = id;
    return id;
  }

  // Process a fill: returns true if it matched a sent order.
  bool process_fill(const ReceivedFill &fill) {
    // Look up by ClOrdID first.
    auto it = clord_to_id_.find(fill.cl_ord_id);
    if (it != clord_to_id_.end()) {
      auto &order = sent_orders_[it->second];

      // Check that fill is consistent with the order.
      if (order.symbol != fill.symbol || order.buy != (fill.price > 0)) {
        // Mismatch: log as phantom.
        unmatched_fills_.push_back(fill);
        return false;
      }

      // Successfully matched.
      return true;
    }

    // ClOrdID not found — try internal order_id (if exchange echoed it).
    if (fill.order_id > 0) {
      auto oit = sent_orders_.find(fill.order_id);
      if (oit != sent_orders_.end()) {
        clord_to_id_[fill.cl_ord_id] = fill.order_id;
        return true;
      }
    }

    // No matching order found — this is a phantom fill.
    unmatched_fills_.push_back(fill);
    return false;
  }

  // Retrieve phantom fills that could not be matched.
  struct PhantomOrderReport {
    std::vector<ReceivedFill> phantoms;
    std::string               description;
  };

  PhantomOrderReport detect_phantoms() const {
    PhantomOrderReport report;
    report.phantoms     = unmatched_fills_;
    report.description  = "Fills received with no matching sent order. ";
    report.description += "May indicate: ghost order on exchange, cross-session "
                          "interference, or retransmission from prior session.";
    return report;
  }
};

// ---------------------------------------------------------------------------
// Phantom order resolver — decides what to do with unmatched fills.
// ---------------------------------------------------------------------------
class PhantomOrderResolver {
  // If we receive a fill for an unknown ClOrdID, we should:
  //   1. Check if it matches any order from a different session (login).
  //   2. Ask the exchange for the current order state (mass quote request / order
  //      status request).
  //   3. If confirmed phantom: reject the fill, log for compliance, adjust position.

public:
  enum class Resolution {
    Accepted,          // Matched to a known order after investigation.
    Rejected,          // Confirmed phantom — reject and log.
    Escalated,         // Cannot determine — escalate to ops.
  };

  Resolution resolve(const ReceivedFill &fill,
                     std::function<bool(const ReceivedFill &)> cross_session_check) {
    // Step 1: cross-session check.
    if (cross_session_check(fill)) {
      return Resolution::Accepted;
    }

    // Step 2: exchange order status query.
    // In production: send OrderStatusRequest (FIX 35=H) to exchange.
    // If exchange confirms the order exists, accept the fill.
    // If exchange says no such order, reject.

    // For now, escalate.
    return Resolution::Escalated;
  }
};
```
