---
type: reference
title: "Order Tracking"
description: "Every order hops through NewSent→NewAcked→FillSent→FillAcked→CancelSent. Waterfall diagrams show exactly where microseconds are lost"
tags: ["order-types"]
difficulty: advanced
timestamp: "2026-06-27T03:06:09.448Z"
phase: 14
phaseName: "Monitoring & Security"
category: "Phase 14 - Monitoring & Security"
subcategory: "monitoring"
language: "cpp"
artifact-id: "ZHFT_ORDER_TRACKING"
---
## Key Learning Points

- Every order hops through NewSent→NewAcked→FillSent→FillAcked→CancelSent
- Waterfall diagrams show exactly where microseconds are lost
- Timestamps must use CLOCK_TAI (or at least CLOCK_MONOTONIC_RAW) — not
- A per-order ring buffer prevents allocation on the hot path

```html
<div class="ad-wrapper">
  <div class="ad-title">Order Lifecycle State Machine</div>
  <div class="ad-fsm">
    <span class="ad-state active">New</span>
    <span class="ad-transition-arrow material-symbols-outlined">arrow_right_alt</span>
    <span class="ad-state">Accepted</span>
    <span class="ad-transition-arrow material-symbols-outlined">arrow_right_alt</span>
    <span class="ad-state">Working</span>
    <span class="ad-transition-arrow material-symbols-outlined">arrow_right_alt</span>
    <span class="ad-state" style="border-color:#22c55e;color:#22c55e">Filled</span>
    <span class="ad-transition" style="margin:0 0.25rem">or</span>
    <span class="ad-state" style="border-color:#ef4444;color:#ef4444">Cancelled</span>
    <span class="ad-transition" style="margin:0 0.25rem">or</span>
    <span class="ad-state" style="border-color:#ef4444;color:#ef4444">Rejected</span>
  </div>
</div>
```

## Source Code

```cpp
#include <array>
#include <atomic>
#include <bit>
#include <chrono>
#include <cstdint>
#include <cstring>
#include <optional>

// ---------------------------------------------------------------------------
// Order lifecycle stages — exactly 8 stages leaves room for expansion and fits
// in a power-of-two ring buffer slot.
// ---------------------------------------------------------------------------
enum class OrderStage : uint8_t {
  LocalNewSent    = 0,
  ExchangeNewAck  = 1,
  LocalFillSent   = 2,
  ExchangeFillAck = 3,
  LocalCancelSent = 4,
  ExchangeCancelAck = 5,
  Reject          = 6,
  ModifySent      = 7,
};

struct StageTimestamp {
  OrderStage stage;
  uint64_t   time_ns; // Monotonic nanosecond timestamp
};

// ---------------------------------------------------------------------------
// Per-order tracker — fixed capacity avoids per-event allocation.
// ---------------------------------------------------------------------------
// Tradeoff: storing every event in a ring buffer means old entries are silently
// overwritten. Our minimum reporting interval (15s) times max throughput (say
// 50k orders/s) = 750k orders per window. A ring of 1M entries is sufficient.
// ---------------------------------------------------------------------------
class alignas(64) OrderTracker {
  std::array<StageTimestamp, 256> stages_; // Fixed slots per order.
  uint32_t count_ = 0;
  uint32_t order_id_;
  uint32_t symbol_id_;

public:
  void record(OrderStage stage, uint64_t time_ns) noexcept {
    if (count_ >= stages_.size()) return; // Silently drop — won't happen with 8 stages.
    stages_[count_++] = {.stage = stage, .time_ns = time_ns};
  }

  std::optional<uint64_t> stage_time(OrderStage stage) const noexcept {
    for (uint32_t i = 0; i < count_; ++i) {
      if (stages_[i].stage == stage)
        return stages_[i].time_ns;
    }
    return std::nullopt;
  }

  // Latency for a specific transition in nanoseconds.
  std::optional<uint64_t> hop_latency(OrderStage from, OrderStage to) const noexcept {
    auto ft = stage_time(from);
    auto tt = stage_time(to);
    if (ft && tt && *tt >= *ft) return *tt - *ft;
    return std::nullopt;
  }

  // Full round-trip: NewSent → NewAcked.
  std::optional<uint64_t> new_order_rtt() const noexcept {
    return hop_latency(OrderStage::LocalNewSent, OrderStage::ExchangeNewAck);
  }
};

// ---------------------------------------------------------------------------
// Global order flow tracker — ring buffer of recent orders.
// ---------------------------------------------------------------------------
// Using a power-of-two mask avoids a modulus on every insert.
// ---------------------------------------------------------------------------
template <uint32_t Capacity = 1 << 20>
class OrderFlowTracker {
  static_assert((Capacity & (Capacity - 1)) == 0, "Capacity must be power of two");

  // Separate read/write indices to minimise contention.
  alignas(64) std::atomic<uint64_t> write_idx_{0};
  alignas(64) std::atomic<uint64_t> read_idx_{0}; // Consumed by reporter.

  // Each slot is a small fixed-size tracker to keep allocation off the hot path.
  std::array<OrderTracker, Capacity> orders_;

public:
  // Called on the order management thread.
  OrderTracker *begin_order(uint32_t order_id, uint32_t symbol_id,
                            uint64_t time_ns) noexcept {
    uint64_t idx = write_idx_.fetch_add(1, std::memory_order_acq_rel) & (Capacity - 1);
    OrderTracker *ot = &orders_[idx];
    // Placement-new not needed — just reset fields and record the first stage.
    ot = new (ot) OrderTracker();
    ot->record(OrderStage::LocalNewSent, time_ns);
    return ot;
  }

  // Record hop for an order started via begin_order.
  void record_hop(uint32_t order_id, OrderStage stage, uint64_t time_ns) noexcept {
    // Linear scan backwards from write_idx — orders are usually recent.
    // In production you'd use an order_id → slot hash map; this is illustrative.
    uint64_t idx = write_idx_.load(std::memory_order_acquire) - 1;
    for (int i = 0; i < 64; ++i) { // Limit scan to 64 slots.
      auto &ot    = orders_[idx & (Capacity - 1)];
      ot->record(stage, time_ns);
      break; // Simplified — real code matches order_id.
    }
  }

  // -----------------------------------------------------------------------
  // Waterfall: returns the min/avg/max for each hop across all tracked orders
  // in the ring. Called by the metrics exporter.
  // -----------------------------------------------------------------------
  struct HopStats {
    uint64_t min_ns, avg_ns, max_ns;
  };

  HopStats compute_hop_stats(OrderStage from, OrderStage to) const noexcept {
    uint64_t r = read_idx_.load(std::memory_order_acquire);
    uint64_t w = write_idx_.load(std::memory_order_acquire);
    uint64_t min_ns = UINT64_MAX, max_ns = 0, sum_ns = 0, count = 0;

    for (uint64_t i = r; i < w; ++i) {
      auto hop = orders_[i & (Capacity - 1)].hop_latency(from, to);
      if (hop) {
        min_ns = std::min(min_ns, *hop);
        max_ns = std::max(max_ns, *hop);
        sum_ns += *hop;
        ++count;
      }
    }
    return {.min_ns = min_ns, .avg_ns = count ? sum_ns / count : 0, .max_ns = max_ns};
  }
};
```
