---
type: reference
title: "Performance Regression Testing"
description: "Automated latency gates in CI/CD, A/B latency tests with statistical significance, micro-regression detection, production canary analysis, hardware-counter profiling in test pipelines, and golden-latency baselines."
tags: ["testing"]
timestamp: "2026-06-27T03:20:00.000Z"
phase: 15
phaseName: "Testing & Production"
category: "Testing & Production"
subcategory: "testing-production"
language: "cpp"
artifact-id: "ZHFT_PERF_REGRESSION_TESTING"
---
## Key Learning Points

- CI/CD performance gate: every PR triggers a latency benchmark suite (median, p99, p99.9); regression > 5% auto-rejects the PR; uses dedicated benchmark hardware (same SKU as prod)
- A/B latency testing: deploy new binary on shadow core alongside production; compare latency histograms; Kolmogorov–Smirnov test for distribution difference at 99% confidence
- Micro-regression detection: track cycle-level changes via RDTSC snapshots at pipeline stage boundaries; flag stages where mean cycle count drifts > 2 sigma from baseline
- Production canary: deploy new version on 1 of N cores; compare order latency, market-data processing latency, and order-to-trade ratio; rollback if any metric degrades
- Hardware-counter profiling in CI: capture `perf stat` counters (L1 miss rate, LLC miss rate, branch mispredict, IPC) for each benchmark; compare against golden profile
- Golden latency baseline: store per-stage latency histograms in git-lfs; CI compares PR histogram to baseline with Mann-Whitney U test
- Statistical significance: benchmark must run minimum `n` iterations for power (typically > 10k samples per metric); warm-up cache before measurement; detect outlier runs via IQR

## Usage

```cpp
// Benchmark harness for latency regression detection
struct PerfRegression {
    static constexpr size_t MIN_SAMPLES = 10'000;
    static constexpr double REGRESSION_THRESHOLD = 0.05; // 5%

    std::vector<uint64_t> baseline_;
    std::vector<uint64_t> candidate_;

    bool detectRegression(const std::vector<uint64_t>& new_samples) {
        double base_median = percentile(baseline_, 50);
        double cand_median = percentile(new_samples, 50);
        double rel_change = (cand_median - base_median) / base_median;
        // Mann-Whitney U test for statistical significance
        double p = mannWhitneyU(baseline_, new_samples);
        return std::abs(rel_change) > REGRESSION_THRESHOLD && p < 0.01;
    }

    // Hardware counter baseline check
    struct PerfCounters {
        double ipc_;
        double l1_miss_rate_;
        double llc_miss_rate_;
        double branch_mispredict_rate_;
    };

    bool checkCounters(const PerfCounters& golden, const PerfCounters& now) {
        return (now.l1_miss_rate_ < golden.l1_miss_rate_ * 1.1 &&   // max 10% degradation
                now.llc_miss_rate_ < golden.llc_miss_rate_ * 1.1 &&
                now.ipc_ > golden.ipc_ * 0.95);
    }
};
```

## Source Code

```cpp
// CI benchmark invocation (Makefile target)
// bench-latency:
//     taskset -c 2 ./build/bench/order_book_bench --samples 50000
//     python3 scripts/compare_latency.py \
//         --baseline ./baselines/latest.json \
//         --candidate /tmp/bench_output.json \
//         --threshold 0.05

// Golden baseline stored as JSON:
// {
//   "median_ns": 425,
//   "p99_ns": 1280,
//   "p99.9_ns": 3400,
//   "ipc": 2.8,
//   "l1_miss_pct": 1.2,
//   "branch_mispredict_pct": 0.8,
//   "timestamp": "2026-06-27T03:20:00Z",
//   "cpu_model": "Intel Xeon Platinum 8480+"
// }
```
