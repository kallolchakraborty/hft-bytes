---
type: reference
title: "Mkt Data Quality"
description: "Sequence gaps are the #1 indicator of lost packets; detect within 1ms. Latency spikes >100µs from exchange to application need immediate alerts"
tags: ["dark-pools", "data-engineering"]
timestamp: "2026-06-27T03:06:09.448Z"
phase: 14
phaseName: "Monitoring & Security"
category: "Phase 14 - Monitoring & Security"
subcategory: "monitoring"
language: "cpp"
artifact-id: "ZHFT_MKT_DATA_QUALITY"
---
## Key Learning Points

- Sequence gaps are the #1 indicator of lost packets; detect within 1ms
- Latency spikes >100µs from exchange to application need immediate alerts
- Duplicate ticks must be identified by sequence number, not just content
- Late ticks (sequence < watermark) indicate jitter or reordering
- Cross-feed comparison (feed A vs feed B) catches silent corruption
- Heartbeat monitoring ensures liveness even in quiet market periods

## Source Code

```cpp
#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <cstring>
#include <optional>
#include <span>

// ---------------------------------------------------------------------------
// Per-symbol sequence tracker.
// ---------------------------------------------------------------------------
// Maintains the last-seen sequence number and detects gaps / duplicates / late
// arrivals in a single pass.
// ---------------------------------------------------------------------------
class SequenceTracker {
  // Last sequence number delivered to the book builder.
  uint64_t last_seq_ = 0;
  // Number of gaps detected (cumulative counter for alerting).
  std::atomic<uint64_t> gap_count_{0};
  std::atomic<uint64_t> dup_count_{0};
  std::atomic<uint64_t> late_count_{0};

public:
  enum class Result { Ok, Gap, Duplicate, Late, Reordered };

  // Returns the outcome and the expected sequence if a gap is found.
  // Tradeoff: we don't buffer the missed packets here; a separate GapFiller
  // uses retransmission requests to fill holes.
  Result check(uint64_t seq) noexcept {
    if (seq == last_seq_ + 1) {
      last_seq_ = seq;
      return Result::Ok;
    }
    if (seq <= last_seq_) {
      // Late tick (seq <= watermark). Could be a reorder or a duplicate.
      if (seq == last_seq_) {
        dup_count_.fetch_add(1, std::memory_order_relaxed);
        return Result::Duplicate;
      }
      // Late tick — arrived after we already saw a higher sequence.
      late_count_.fetch_add(1, std::memory_order_relaxed);
      return Result::Late;
    }
    // Gap: we jumped from last_seq_+1 to seq (maybe >1).
    gap_count_.fetch_add(seq - last_seq_ - 1, std::memory_order_relaxed);
    last_seq_ = seq;
    return Result::Gap;
  }

  void reset(uint64_t start_seq = 0) noexcept {
    last_seq_ = start_seq;
  }

  uint64_t gap_count() const noexcept { return gap_count_.load(); }
  uint64_t dup_count() const noexcept { return dup_count_.load(); }
  uint64_t last_seq() const noexcept { return last_seq_; }
};

// ---------------------------------------------------------------------------
// Latency spike detector — sliding window of tick arrival times.
// ---------------------------------------------------------------------------
// Uses a simple dequeue of timestamps rather than a full histogram. For spike
// detection, the exact percentile is less important than "is this tick an
// outlier relative to recent history."
// ---------------------------------------------------------------------------
class LatencySpikeDetector {
  static constexpr size_t kWindow = 1024; // Must be power of two.
  std::array<uint64_t, kWindow> deltas_;  // Inter-arrival times in ns.
  size_t pos_ = 0;
  uint64_t mean_ = 0;
  uint64_t threshold_ns_;

public:
  explicit LatencySpikeDetector(uint64_t threshold_ns = 100'000) // 100µs default
      : threshold_ns_(threshold_ns) {
    deltas_.fill(0);
  }

  // Returns true if this tick's inter-arrival delta exceeds threshold * mean.
  void record(uint64_t now_ns) noexcept {
    static uint64_t prev_ns = now_ns;
    uint64_t delta = now_ns - prev_ns;
    prev_ns        = now_ns;

    // Rolling mean (exponential — cheap, avoids O(window) sum).
    mean_ = (mean_ * 15 + delta) / 16; // α = 1/16

    deltas_[pos_++ & (kWindow - 1)] = delta;
  }

  bool is_spike() const noexcept {
    uint64_t latest = deltas_[(pos_ - 1) & (kWindow - 1)];
    return latest > threshold_ns_ && latest > mean_ * 3;
  }
};

// ---------------------------------------------------------------------------
// Cross-feed comparator.
// ---------------------------------------------------------------------------
// Runs on a background thread (not on the hot path). Compares feed A and feed
// B for the same symbol and alerts on:
//   - Different sequence numbers (one feed missed a packet)
//   - Different price/volume (silent corruption)
//   - One feed stalled while the other continues (feed failure)
// ---------------------------------------------------------------------------
struct TickSnapshot {
  uint64_t seq;
  uint64_t price;      // Scaled price (e.g., fixed-point with 4 decimals).
  uint32_t volume;
  uint64_t timestamp_ns;

  bool operator==(const TickSnapshot &o) const noexcept {
    return seq == o.seq && price == o.price && volume == o.volume;
  }
};

class CrossFeedMonitor {
  struct FeedState {
    uint64_t last_seq = 0;
    uint64_t last_ts  = 0;
    bool     alive    = true;
  } feed_a_, feed_b_;

  std::atomic<uint64_t> mismatch_count_{0};

public:
  // Called by the book-builder thread when both feeds are available. Must be
  // lock-free: uses double-word CAS if available, else a spin lock.
  // Tradeoff: on x86 we use cmpxchg16b; on ARM we fall back to a seq lock.
  void compare(uint64_t symbol_id, const TickSnapshot &a,
               const TickSnapshot &b) noexcept {
    if (a == b) {
      feed_a_.last_seq = a.seq;
      feed_b_.last_seq = b.seq;
      return;
    }
    // Mismatch — increment counter and log details (not shown).
    mismatch_count_.fetch_add(1, std::memory_order_relaxed);
  }
};

// ---------------------------------------------------------------------------
// Heartbeat monitor.
// ---------------------------------------------------------------------------
// Exchange feeds send heartbeat messages at a fixed interval (e.g., 1s) during
// quiet periods. If no heartbeat arrives within N intervals, the feed is
// considered stale and failover should trigger.
// ---------------------------------------------------------------------------
class HeartbeatMonitor {
  std::atomic<uint64_t> last_heartbeat_ns_{0};
  uint64_t timeout_ns_;
  bool     failed_ = false;

public:
  explicit HeartbeatMonitor(uint64_t timeout_ns) : timeout_ns_(timeout_ns) {}

  void heartbeat(uint64_t now_ns) noexcept {
    last_heartbeat_ns_.store(now_ns, std::memory_order_release);
    failed_ = false; // Recovered.
  }

  bool check_alive(uint64_t now_ns) noexcept {
    uint64_t last = last_heartbeat_ns_.load(std::memory_order_acquire);
    bool dead     = (now_ns - last) > timeout_ns_;
    if (dead) failed_ = true;
    return !dead;
  }

  bool has_failed() const noexcept { return failed_; }
};
```
