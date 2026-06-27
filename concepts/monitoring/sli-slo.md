---
type: reference
title: "SLI SLO"
description: "Latency SLI: p99 entry→ack < 500µs (measured every 1min window). Availability SLI: fraction of 1s windows with successful heartbeats"
tags: ["phase-14"]
timestamp: "2026-06-27T03:06:09.449Z"
phase: 14
phaseName: "Monitoring & Security"
category: "Phase 14 - Monitoring & Security"
subcategory: "monitoring"
language: "cpp"
artifact-id: "ZHFT_SLI_SLO"
---
## Key Learning Points

- Latency SLI: p99 entry→ack < 500µs (measured every 1min window)
- Availability SLI: fraction of 1s windows with successful heartbeats
- Fill rate accuracy SLI: fills match expected price/volume within tolerance
- Error budget = (1 - SLO) * total events; burn rate = error rate / (1 - SLO)
- Multi-window multi-burn-rate alerts prevent page storms: short window
- Alert fatigue mitigation: only page if burn rate is sustained across

## Source Code

```cpp
#include <array>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <optional>

// ---------------------------------------------------------------------------
// SLI types for an HFT system.
// ---------------------------------------------------------------------------
enum class SliType {
  LatencyEntryToAck,      // p99 entry→ack < 500µs
  LatencyTickToBook,      // p99 tick→book update < 50µs
  Availability,           // Exchange connection available ≥ 99.99%
  FillAccuracy,           // Fills match expected within tolerance (1bps)
};

// ---------------------------------------------------------------------------
// Sliding-window SLI tracker.
// ---------------------------------------------------------------------------
// Divides time into fixed windows (e.g., 60s). Each window records:
//   - Number of "good" events (latency ≤ threshold)
//   - Number of "bad" events (latency > threshold)
// The SLI for a rolling window is good / (good + bad).
// ---------------------------------------------------------------------------
template <size_t NumWindows = 1440> // 1440 windows at 60s = 24h rolling.
class SliWindowTracker {
  static_assert((NumWindows & (NumWindows - 1)) == 0, "Power of two required");

  struct WindowSlot {
    uint64_t good_count = 0;
    uint64_t bad_count  = 0;
    uint64_t window_id  = 0; // Monotonic ID to detect stale slots.
  };

  std::array<std::atomic<WindowSlot>, NumWindows> slots_;
  uint64_t threshold_ns_;

public:
  explicit SliWindowTracker(uint64_t threshold_ns) : threshold_ns_(threshold_ns) {}

  // Called for each event.
  void record_event(uint64_t latency_ns, uint64_t now_window_id) noexcept {
    size_t idx  = now_window_id & (NumWindows - 1);
    auto &slot  = slots_[idx];
    bool  good  = latency_ns <= threshold_ns_;

    // If the slot's window_id doesn't match, reset it (CAS).
    WindowSlot expected = slot.load(std::memory_order_acquire);
    WindowSlot desired  = expected;
    if (desired.window_id != now_window_id) {
      desired = {.good_count = 0, .bad_count = 0, .window_id = now_window_id};
    }
    if (good) {
      desired.good_count++;
    } else {
      desired.bad_count++;
    }
    slot.compare_exchange_weak(expected, desired, std::memory_order_acq_rel);
  }

  // Query SLI over the last N windows. Returns Optional<double> ∈ [0,1].
  std::optional<double> sli(size_t windows = NumWindows) const noexcept {
    uint64_t total_good = 0, total_bad = 0;
    // We approximate "last N windows" by the last N slots that have the
    // expected window_id. This is racy but adequate for monitoring.
    // Tradeoff: exact computation requires a global window counter protected
    // by a seq lock. For monitoring, approximate is fine.
    for (size_t i = 0; i < std::min(windows, NumWindows); ++i) {
      auto slot = slots_[i].load(std::memory_order_acquire);
      total_good += slot.good_count;
      total_bad += slot.bad_count;
    }
    uint64_t total = total_good + total_bad;
    return total > 0 ? std::optional(total_good / double(total)) : std::nullopt;
  }
};

// ---------------------------------------------------------------------------
// Error budget calculator.
// ---------------------------------------------------------------------------
// Error budget = total events × (1 - SLO). Burn rate = (1 - SLI) / (1 - SLO).
// If burn rate > 1, we are consuming budget faster than planned.
// ---------------------------------------------------------------------------
class ErrorBudget {
  double slo_;        // e.g., 0.999 for 99.9%
  double remaining_;  // Fraction [0, 1]

public:
  ErrorBudget(double slo, uint64_t total_events) : slo_(slo), remaining_(1.0) {}

  void consume(double sli, uint64_t events_in_window) noexcept {
    double error_rate = 1.0 - sli;
    double budget_consumed = error_rate / (1.0 - slo_);
    remaining_ = std::max(0.0, remaining_ - budget_consumed * 0.001); // Decay factor.
  }

  double remaining() const noexcept { return remaining_; }

  // Burn rate > 14.4x = SLO violation in ~1 hour at current rate.
  static double burn_rate(double sli, double slo) noexcept {
    double error_rate = 1.0 - sli;
    double budget     = 1.0 - slo;
    return budget > 0 ? error_rate / budget : 0.0;
  }
};

// ---------------------------------------------------------------------------
// Multi-window multi-burn-rate alert evaluator.
// ---------------------------------------------------------------------------
// Evaluates burn rate across short (1m), medium (5m), and long (1h) windows.
// Alerts are grouped into severity levels to reduce alert fatigue.
// ---------------------------------------------------------------------------
struct BurnRateAlert {
  enum Severity { Info, Warning, Critical };
  Severity   severity;
  SliType    sli_type;
  double     burn_rate;
  uint64_t   window_start_ns;
  const char *message;
};

class BurnRateEvaluator {
  SliWindowTracker<60> short_window_;   // 60 × 1s sub-windows = 1m
  SliWindowTracker<300> medium_window_; // 300 × 1s sub-windows = 5m
  SliWindowTracker<3600> long_window_;  // 3600 × 1s sub-windows = 1h

  double slo_;

public:
  explicit BurnRateEvaluator(double slo) : slo_(slo) {}

  std::optional<BurnRateAlert> evaluate(uint64_t now_window_id) noexcept {
    auto s_sli = short_window_.sli();
    auto m_sli = medium_window_.sli();
    auto l_sli = long_window_.sli();

    double br_short = s_sli ? ErrorBudget::burn_rate(*s_sli, slo_) : 0;
    double br_med   = m_sli ? ErrorBudget::burn_rate(*m_sli, slo_) : 0;
    double br_long  = l_sli ? ErrorBudget::burn_rate(*l_sli, slo_) : 0;

    // Multi-window strategy: page if ALL windows indicate a problem.
    if (br_short > 14.4 && br_med > 6.0 && br_long > 2.0) {
      return BurnRateAlert{BurnRateAlert::Critical, SliType::LatencyEntryToAck,
                           br_short, now_window_id,
                           "SLO violation imminent — sustained high burn rate"};
    }
    // Info if only short window is elevated (likely noise).
    if (br_short > 6.0) {
      return BurnRateAlert{BurnRateAlert::Info, SliType::LatencyEntryToAck,
                           br_short, now_window_id,
                           "Elevated burn rate — monitoring"};
    }
    return std::nullopt;
  }
};
```
