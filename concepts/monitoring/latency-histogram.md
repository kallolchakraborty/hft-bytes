---
type: reference
title: "Latency Histogram"
description: "HDR Histogram provides high dynamic range with constant relative error. Coordinated omission distorts percentiles if samples are skipped during"
tags: ["backtesting", "performance"]
difficulty: advanced
timestamp: "2026-06-27T03:06:09.447Z"
phase: 14
phaseName: "Monitoring & Security"
category: "Phase 14 - Monitoring & Security"
subcategory: "monitoring"
language: "cpp"
artifact-id: "ZHFT_LATENCY_HISTOGRAM"
---
## Key Learning Points

- HDR Histogram provides high dynamic range with constant relative error
- Coordinated omission distorts percentiles if samples are skipped during
- p50/p90/p99/p99.9/max each tell a different story about tail latency
- Merging histograms across processes enables cross-instance percentile
- Real-time percentile reporting via atomic snapshots for Prometheus

## Source Code

```cpp
#include <atomic>
#include <array>
#include <bit>
#include <cstdint>
#include <span>
#include <vector>

// ---------------------------------------------------------------------------
// Minimal HDR Histogram — fixed precision of 2 significant digits (±1% error).
// The classic HDR approach uses sub-bucket indexing: value → exponent → mantissa.
// Tradeoff: 2-digit precision means p99 might report 498µs for true 500µs.
// Higher precision (3 digits) costs ~10x more memory — acceptable only for
// non-TOT paths.
// ---------------------------------------------------------------------------
template <int SignificantDigits = 2>
class HdrHistogram {
  static_assert(SignificantDigits >= 1 && SignificantDigits <= 5);

  static constexpr int kUnitMagnitude    = 0;       // Tick size = 1 (nanosecond)
  static constexpr int kSubBucketBits    = SignificantDigits * 3 + 2; // e.g., 8 for 2 digits
  static constexpr int kSubBucketCount   = 1 << kSubBucketBits;
  static constexpr int kBucketCount      = 64;      // Enough for 64-bit range

  // Pre-computed counts array — sized to hold all buckets + sub-buckets.
  // For 2-digit precision: ~64 * 256 = 16 384 counters.
  std::array<std::atomic<int64_t>,
             (kBucketCount - 1) * (kSubBucketCount / 2) + kSubBucketCount + 1>
      counts_{};

  std::atomic<int64_t> total_count_{0};
  std::atomic<int64_t> total_sum_{0};
  int64_t min_value_ = std::numeric_limits<int64_t>::max();
  int64_t max_value_ = 0;

  // -----------------------------------------------------------------------
  // Index → value conversion (fast version using bit tricks).
  // HDR formula: value = sub_bucket_count * 2^(bucket_index) + sub_bucket_value
  // -----------------------------------------------------------------------
  int64_t value_from_index(int idx) const noexcept {
    if (idx < kSubBucketCount) return idx;
    int bucket = (idx / (kSubBucketCount / 2)) - 1;
    int sub    = idx % (kSubBucketCount / 2);
    return (static_cast<int64_t>(sub) + kSubBucketCount) *
           (1LL << bucket);
  }

  // -----------------------------------------------------------------------
  // Value → index.
  // The leading_zeros trick avoids branching — critical for the hot path.
  // -----------------------------------------------------------------------
  int index_from_value(int64_t value) const noexcept {
    if (value <= 0) return 0; // Should not happen; clamp.
    int bucket = 63 - std::countl_zero(static_cast<uint64_t>(value));
    int sub    = static_cast<int>(
        (value >> (bucket - kSubBucketBits + 1)) & (kSubBucketCount - 1));
    return (bucket + 1) * (kSubBucketCount / 2) + sub;
  }

public:
  // -----------------------------------------------------------------------
  // record_value — the hot path. Must stay under 50ns.
  // Uses relaxed atomics because percentiles are approximate anyway and we
  // tolerate minor torn reads for speed. Only total_count_ uses acq_rel for
  // snapshot correctness.
  // -----------------------------------------------------------------------
  void record_value(int64_t value) noexcept {
    if (value < 0) value = 0;
    int idx        = index_from_value(value);
    counts_[idx].fetch_add(1, std::memory_order_relaxed);
    total_count_.fetch_add(1, std::memory_order_acq_rel);
    total_sum_.fetch_add(value, std::memory_order_relaxed);

    // Min/max: CAS loop — rare enough that the branch mispredict dominates.
    int64_t old_min;
    do { old_min = min_value_; } while (value < old_min &&
                                        !min_value_.compare_exchange_weak(
                                            old_min, value));
    int64_t old_max;
    do { old_max = max_value_; } while (value > old_max &&
                                        !max_value_.compare_exchange_weak(
                                            old_max, value));
  }

  // -----------------------------------------------------------------------
  // percentile — O(num_buckets) scan. Called by the metrics goroutine every
  // 5–15s, so 16k iterations at ~3ns each is fine.
  // -----------------------------------------------------------------------
  int64_t percentile(double p) const noexcept {
    int64_t target = static_cast<int64_t>(total_count_.load(std::memory_order_acquire) *
                                          (p / 100.0));
    if (target <= 0) return min_value_;

    int64_t running = 0;
    for (size_t i = 0; i < counts_.size(); ++i) {
      int64_t c = counts_[i].load(std::memory_order_relaxed);
      running += c;
      if (running >= target) return value_from_index(static_cast<int>(i));
    }
    return max_value_;
  }

  // -----------------------------------------------------------------------
  // Merging — used by the histogram collector daemon to combine per-thread or
  // per-process histograms into a global view.
  // -----------------------------------------------------------------------
  void merge(const HdrHistogram &other) noexcept {
    for (size_t i = 0; i < counts_.size(); ++i) {
      int64_t c = other.counts_[i].load(std::memory_order_relaxed);
      if (c) counts_[i].fetch_add(c, std::memory_order_relaxed);
    }
    total_count_.fetch_add(other.total_count_.load(std::memory_order_acquire),
                           std::memory_order_acq_rel);
    total_sum_.fetch_add(other.total_sum_.load(std::memory_order_relaxed),
                         std::memory_order_relaxed);

    int64_t om = other.min_value_;
    int64_t tm = min_value_;
    while (om < tm && !min_value_.compare_exchange_weak(tm, om)) {}

    int64_t ox = other.max_value_;
    int64_t tx = max_value_;
    while (ox > tx && !max_value_.compare_exchange_weak(tx, ox)) {}
  }
};

// ---------------------------------------------------------------------------
// Coordinated omission protection wrapper.
// ---------------------------------------------------------------------------
// Idea: if the producer cannot call record_value() because it is stuck on
// something slow, those "missing" samples cause p99 to look artificially good.
// Solution: start a background thread that ticks the histogram at a fixed
// interval (e.g., every 100µs). If a tick "should have" seen a value but the
// producer was blocked, we record the elapsed wall time into the histogram
// instead.
//
// In practice: the tick thread records "how long since the last tick" into a
// separate "wait time" histogram. The tick interval must be < 1/10 of the
// latency target to have enough resolution.
// ---------------------------------------------------------------------------
class CoordinatedOmissionGuard {
  HdrHistogram<2> &latency_hist_;
  HdrHistogram<2> &wait_hist_;
  std::chrono::steady_clock::time_point last_tick_;
  std::chrono::microseconds interval_;

public:
  void tick() noexcept {
    auto now     = std::chrono::steady_clock::now();
    auto elapsed = std::chrono::duration_cast<std::chrono::nanoseconds>(
                       now - last_tick_).count();
    if (elapsed > interval_.count() * 2) {
      // We missed at least one tick — record the gap as a "lost opportunity".
      wait_hist_.record_value(elapsed);
    }
    last_tick_ = now;
  }
};

// ---------------------------------------------------------------------------
// Real-time percentile snapshot (lock-free for Prometheus scraping).
// ---------------------------------------------------------------------------
class PercentileSnapshot {
  struct alignas(128) Snapshot { // Avoid false sharing.
    int64_t p50;
    int64_t p90;
    int64_t p99;
    int64_t p999;
    int64_t max;
  };

  std::array<std::atomic<Snapshot>, 2> snapshots_;
  std::atomic<int> active_{0};

public:
  void update(const HdrHistogram<2> &h) noexcept {
    int next = active_.load(std::memory_order_relaxed) ^ 1;
    snapshots_[next].store(
        {.p50  = h.percentile(50.0),
         .p90  = h.percentile(90.0),
         .p99  = h.percentile(99.0),
         .p999 = h.percentile(99.9),
         .max  = h.percentile(100.0)},
        std::memory_order_release);
    active_.store(next, std::memory_order_release);
  }

  Snapshot read() const noexcept {
    int idx = active_.load(std::memory_order_acquire);
    return snapshots_[idx].load(std::memory_order_acquire);
  }
};
```
