---
type: playbook
title: "Mass Cancel"
description: "Mass cancel request sent but response lost: you don't know if the. Exchange mass cancel succeeds but timeout returns error: the cancel"
tags: ["phase-17"]
timestamp: "2026-06-27T03:06:09.459Z"
phase: 17
phaseName: "Production Failure Modes"
category: "Phase 17 - Production Failure Modes"
subcategory: "failure-modes"
language: "cpp"
artifact-id: "ZHFT_MASS_CANCEL"
---
## Key Learning Points

- Mass cancel request sent but response lost: you don't know if the
- Exchange mass cancel succeeds but timeout returns error: the cancel
- Partial mass cancel: some symbols accepted, some rejected; need
- Recovery after mass cancel: reconcile known open orders against

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
// Mass cancel confirmation checker.
// ---------------------------------------------------------------------------
// Tracks a mass cancel request through its lifecycle and verifies the outcome.
// ---------------------------------------------------------------------------
struct MassCancelRequest {
  uint64_t    request_id;
  uint64_t    sent_ns;
  uint64_t    timeout_ns;      // When to stop waiting for response.
  std::set<std::string> target_symbols;  // Empty = all symbols.
  std::set<uint64_t>    target_order_ids;
  bool        response_received = false;
  bool        confirmed_success = false;
};

struct MassCancelResponse {
  uint64_t    request_id;
  bool        success;        // Overall result.
  std::vector<std::string> failed_symbols;  // Symbols where cancel failed.
  std::vector<uint64_t>    failed_order_ids;
  std::string error_message;
};

class MassCancelTracker {
  std::map<uint64_t, MassCancelRequest> pending_;

public:
  uint64_t initiate_mass_cancel(const std::set<std::string> &symbols) {
    uint64_t id = next_id();
    pending_[id] = {
        .request_id      = id,
        .sent_ns         = now_ns(),
        .timeout_ns      = now_ns() + 5'000'000'000ULL, // 5 second timeout.
        .target_symbols  = symbols,
    };
    return id;
  }

  // Called when a mass cancel response is received.
  struct ConfirmResult {
    bool    success;
    bool    timed_out;
    std::string details;
  };

  ConfirmResult process_response(uint64_t request_id,
                                  const MassCancelResponse &response) {
    auto it = pending_.find(request_id);
    if (it == pending_.end()) return {false, false, "Unknown request ID"};

    auto &req = it->second;
    req.response_received = true;

    if (response.success && response.failed_symbols.empty()) {
      req.confirmed_success = true;
      pending_.erase(it); // Done.
      return {true, false, "All symbols cancelled successfully"};
    }

    // Partial success.
    if (!response.failed_symbols.empty()) {
      return {false, false,
              "Partial failure on symbols: " + join(response.failed_symbols)};
    }

    return {false, false, response.error_message};
  }

  // Check for pending mass cancels that have timed out.
  std::vector<MassCancelRequest> check_timeouts() {
    std::vector<MassCancelRequest> timed_out;
    for (auto it = pending_.begin(); it != pending_.end();) {
      if (now_ns() > it->second.timeout_ns && !it->second.response_received) {
        timed_out.push_back(it->second);
        it = pending_.erase(it);
      } else {
        ++it;
      }
    }
    return timed_out;
  }

private:
  uint64_t next_id() {
    static std::atomic<uint64_t> id{0};
    return id.fetch_add(1, std::memory_order_relaxed);
  }

  uint64_t now_ns() const {
    return std::chrono::duration_cast<std::chrono::nanoseconds>(
               std::chrono::steady_clock::now().time_since_epoch())
        .count();
  }

  static std::string join(const std::vector<std::string> &v) {
    std::string s;
    for (const auto &x : v) s += x + ",";
    return s;
  }
};

// ---------------------------------------------------------------------------
// Safe-order-state recovery after mass cancel.
// ---------------------------------------------------------------------------
// After a mass cancel (successful or not), we must reconcile our known open
// orders with the exchange's actual state.
// ---------------------------------------------------------------------------
class SafeOrderStateRecovery {
  // Orders we think are still open.
  std::map<uint64_t, struct OrderInfo> known_orders_;
  // Orders the exchange reports as open.
  std::map<uint64_t, struct OrderInfo> exchange_orders_;

public:
  struct OrderInfo {
    uint64_t    order_id;
    std::string symbol;
    int64_t     price;
    uint32_t    remaining_qty;
  };

  struct ReconciliationAction {
    enum Action { CancelOnExchange, WaitForFill, MarkAsLost };
    Action     action;
    uint64_t   order_id;
    std::string reason;
  };

  std::vector<ReconciliationAction> reconcile() {
    std::vector<ReconciliationAction> actions;

    // Orders we know about but exchange doesn't: probably already cancelled.
    for (const auto &[oid, info] : known_orders_) {
      if (exchange_orders_.find(oid) == exchange_orders_.end()) {
        actions.push_back(
            {ReconciliationAction::MarkAsLost, oid,
             "Order in our book but not in exchange's — assumed cancelled"});
      }
    }

    // Orders exchange has but we don't know about: need to cancel them.
    for (const auto &[oid, info] : exchange_orders_) {
      if (known_orders_.find(oid) == known_orders_.end()) {
        actions.push_back(
            {ReconciliationAction::CancelOnExchange, oid,
             "Order on exchange but unknown to us — sending cancel"});
      }
    }

    return actions;
  }
};
```
