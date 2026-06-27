---
type: playbook
title: "Clock Anomalies"
description: "PTP grandmaster failure: without GM, clocks free-run with drift;. Time jumps (forward/backward): CLOCK_REALTIME can jump when NTP adjusts;"
tags: ["clock-synchronization"]
difficulty: advanced
timestamp: "2026-06-27T03:06:09.459Z"
phase: 17
phaseName: "Production Failure Modes"
category: "Phase 17 - Production Failure Modes"
subcategory: "failure-modes"
language: "cpp"
artifact-id: "ZHFT_CLOCK_ANOMALIES"
---
## Key Learning Points

- PTP grandmaster failure: without GM, clocks free-run with drift;
- Time jumps (forward/backward): CLOCK_REALTIME can jump when NTP adjusts;
- Non-monotonic timestamps: if an event appears to have a timestamp before
- Clock servo tuning: PTP servo (pi_filter) parameters must be tuned for
- Holdover performance: the interval over which a clock remains within

## Source Code

```cpp
#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <ctime>
#include <fstream>
#include <map>
#include <optional>
#include <sstream>
#include <string>
#include <vector>

// ---------------------------------------------------------------------------
// Clock anomaly detector — checks for non-monotonic timestamps, large jumps.
// ---------------------------------------------------------------------------
class ClockAnomalyDetector {
  uint64_t last_monotonic_raw_ns_ = 0;
  uint64_t last_tai_ns_           = 0;
  uint64_t anomaly_count_         = 0;
  uint64_t max_clock_jump_ns_     = 1'000'000; // 1ms — beyond this is anomalous.

public:
  struct Anomaly {
    enum Type { NonMonotonic, ForwardJump, BackwardJump, DriftExceeded };
    Type     anomaly_type;
    uint64_t expected_ns;
    uint64_t actual_ns;
    uint64_t delta_ns;
  };

  std::optional<Anomaly> check_monotonic(uint64_t timestamp_ns, bool is_tai) {
    uint64_t &last = is_tai ? last_tai_ns_ : last_monotonic_raw_ns_;

    if (timestamp_ns < last) {
      // Timestamp went backwards — serious anomaly.
      anomaly_count_++;
      return Anomaly{Anomaly::NonMonotonic, last, timestamp_ns,
                     last - timestamp_ns};
    }

    uint64_t delta = timestamp_ns - last;
    if (delta > max_clock_jump_ns_) {
      anomaly_count_++;
      return Anomaly{Anomaly::ForwardJump, last, timestamp_ns, delta};
    }

    last = timestamp_ns;
    return std::nullopt;
  }

  uint64_t anomaly_count() const { return anomaly_count_; }
};

// ---------------------------------------------------------------------------
// PTP health monitor — tracks grandmaster status, offset, and path delay.
// ---------------------------------------------------------------------------
class PtpHealthMonitor {
  // In production: read from pmc (PTP management client) or directly from the
  // ptp4l/linuxptp API.
  struct PtpStatus {
    bool   grandmaster_present;
    double offset_ns;        // Mean offset from master.
    double path_delay_ns;    // Mean path delay.
    double stddev_offset_ns; // Jitter.
    std::string  gm_identity;  // Clock ID of current grandmaster.
  };

  // Replace with actual pmc_get_data() call in production.
  PtpStatus fetch_status() const {
    // Read from /var/run/ptp4l/status or parse logs.
    return {.grandmaster_present = true,
            .offset_ns = -12.5,
            .path_delay_ns = 320.0,
            .stddev_offset_ns = 45.0,
            .gm_identity = "00:1B:A1:23:45:67"};
  }

public:
  struct Alert {
    enum Severity { Warning, Critical };
    Severity   severity;
    std::string message;
  };

  std::vector<Alert> check() {
    std::vector<Alert> alerts;
    auto status = fetch_status();

    if (!status.grandmaster_present) {
      alerts.push_back({Alert::Critical, "PTP grandmaster lost — holdover mode"});
    }

    if (std::abs(status.offset_ns) > 500.0) { // > 500ns offset
      // MiFID II: > 1ms is regulatory violation.
      if (std::abs(status.offset_ns) > 1'000'000.0) {
        alerts.push_back({Alert::Critical,
                          "PTP offset > 1ms — RTS 25 violation risk"});
      } else {
        alerts.push_back(
            {Alert::Warning,
             "PTP offset " + std::to_string(status.offset_ns) + "ns exceeds 500ns"});
      }
    }

    if (status.stddev_offset_ns > 200.0) {
      alerts.push_back(
          {Alert::Warning,
           "PTP jitter " + std::to_string(status.stddev_offset_ns) + "ns — check network"});
    }

    return alerts;
  }
};

// ---------------------------------------------------------------------------
// Timestamp monotonicity checker — validates a stream of timestamps.
// ---------------------------------------------------------------------------
class TimestampMonotonicityValidator {
  uint64_t window_start_ns_ = 0;
  int64_t  max_seen_drift_  = 0;

public:
  struct ValidationResult {
    bool   monotonic;
    bool   within_drift_budget;
    uint64_t non_monotonic_samples;
    int64_t  max_drift_ns;
  };

  ValidationResult validate(std::span<const uint64_t> timestamps_ns) {
    ValidationResult res{true, true, 0, 0};
    for (size_t i = 1; i < timestamps_ns.size(); ++i) {
      if (timestamps_ns[i] < timestamps_ns[i - 1]) {
        res.monotonic = false;
        res.non_monotonic_samples++;
      }
      int64_t drift = int64_t(timestamps_ns[i]) - int64_t(timestamps_ns[i - 1]);
      if (drift > max_seen_drift_) max_seen_drift_ = drift;
    }
    res.max_drift_ns = max_seen_drift_;
    res.within_drift_budget = max_seen_drift_ < 1'000'000; // < 1ms drift.
    return res;
  }
};
```
