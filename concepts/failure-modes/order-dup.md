---
type: playbook
title: "Order Dup"
description: "Retransmission without PossDupFlag: TCP retransmission or session-level. Fill received twice: same order ID, same price/qty, same timestamp — the"
tags: ["order-types"]
timestamp: "2026-06-27T03:06:09.460Z"
phase: 17
phaseName: "Production Failure Modes"
category: "Phase 17 - Production Failure Modes"
subcategory: "failure-modes"
language: "cpp"
artifact-id: "ZHFT_ORDER_DUP"
---
## Key Learning Points

- Retransmission without PossDupFlag: TCP retransmission or session-level
- Fill received twice: same order ID, same price/qty, same timestamp — the
- Exchange-duplicated order: rare but documented — exchange processes an
- Idempotency key design: ClOrdID (Client Order ID) must be unique per
- Clockski-sensitive dedup: clocks may skew across processes; use a

## Source Code

```cpp
#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <ctime>
#include <map>
#include <optional>
#include <set>
#include <sstream>
#include <string>
#include <vector>

// ---------------------------------------------------------------------------
// Idempotency key generator — produces unique ClOrdID values.
// ---------------------------------------------------------------------------
// Format: "SESSION_ID_TIMESTAMP_COUNTER"
// Tradeoff: using wall clock time means clock jumps could cause duplicates.
// Instead, use a monotonic per-session counter + process ID.
class IdempotencyKeyGenerator {
  const uint32_t session_id_;
  std::atomic<uint64_t> counter_{0};

public:
  explicit IdempotencyKeyGenerator(uint32_t session_id)
      : session_id_(session_id) {}

  std::string next_cl_ord_id() {
    uint64_t c = counter_.fetch_add(1, std::memory_order_relaxed);
    // Format: "S{ session_id }C{ counter }"
    return "S" + std::to_string(session_id_) + "C" + std::to_string(c);
  }

  // Clock-ski safe variant: includes the last monotonic time as a hedge.
  std::string next_cl_ord_id_hedged() {
    uint64_t c = counter_.fetch_add(1, std::memory_order_relaxed);
    uint64_t t = std::chrono::duration_cast<std::chrono::nanoseconds>(
                     std::chrono::steady_clock::now().time_since_epoch())
                     .count();
    return "S" + std::to_string(session_id_) +
           "T" + std::to_string(t) +
           "C" + std::to_string(c);
  }
};

// ---------------------------------------------------------------------------
// Order deduplication engine — detects and suppresses duplicate orders/fills.
// ---------------------------------------------------------------------------
class OrderDeduplicationEngine {
  // Dedup window: how long we remember processed ClOrdIDs.
  static constexpr uint64_t kDedupWindowNs = 3'600'000'000'000ULL; // 1 hour.

  struct DedupEntry {
    std::string cl_ord_id;
    uint64_t    processed_at_ns;
    bool        is_fill;    // If true, entry is for a fill (not an order).
  };

  // Ring buffer (simplified with map for clarity).
  std::map<std::string, DedupEntry> recent_ids_;
  uint64_t last_cleanup_ns_ = 0;

public:
  enum class DedupResult {
    Accepted,     // First time seeing this ID.
    Duplicate,    // Already saw this ID — silently ignore.
    StaleEntry,   // Entry existed but outside dedup window — ambiguous.
  };

  // Check if we've seen this ClOrdID before (for order submission).
  DedupResult check_order(const std::string &cl_ord_id, uint64_t now_ns) {
    periodic_cleanup(now_ns);

    auto it = recent_ids_.find(cl_ord_id);
    if (it == recent_ids_.end()) {
      // First time.
      recent_ids_.emplace(cl_ord_id, DedupEntry{cl_ord_id, now_ns, false});
      return DedupResult::Accepted;
    }

    if ((now_ns - it->second.processed_at_ns) < kDedupWindowNs) {
      return DedupResult::Duplicate; // Already processed in the window.
    }

    // Outside the window — treat as stale.
    it->second.processed_at_ns = now_ns; // Refresh.
    return DedupResult::StaleEntry;
  }

  // Check if we've already recorded this fill (for fill dedup).
  DedupResult check_fill(const std::string &exec_id, uint64_t now_ns) {
    periodic_cleanup(now_ns);

    auto it = recent_ids_.find(exec_id);
    if (it == recent_ids_.end()) {
      recent_ids_.emplace(exec_id, DedupEntry{exec_id, now_ns, true});
      return DedupResult::Accepted;
    }
    return DedupResult::Duplicate;
  }

private:
  void periodic_cleanup(uint64_t now_ns) {
    // Clean up every 60s.
    if ((now_ns - last_cleanup_ns_) < 60'000'000'000ULL) return;
    last_cleanup_ns_ = now_ns;

    for (auto it = recent_ids_.begin(); it != recent_ids_.end();) {
      if ((now_ns - it->second.processed_at_ns) > kDedupWindowNs) {
        it = recent_ids_.erase(it);
      } else {
        ++it;
      }
    }
  }
};

// ---------------------------------------------------------------------------
// Clockski-sensitive dedup — guards against non-monotonic clocks.
// ---------------------------------------------------------------------------
// Time-corrected dedup: if the clock jumped backwards, use a logical counter
// to maintain ordering, not wall time.
class ClockskiSafeDedup {
  // Logical clock: max(physical_time, last_used_time + 1).
  std::atomic<uint64_t> logical_time_{0};

public:
  uint64_t now() noexcept {
    uint64_t phys = std::chrono::duration_cast<std::chrono::nanoseconds>(
                        std::chrono::steady_clock::now().time_since_epoch())
                        .count();
    uint64_t prev = logical_time_.load(std::memory_order_acquire);
    uint64_t next = std::max(phys, prev + 1);
    logical_time_.store(next, std::memory_order_release);
    return next;
  }
};
```
