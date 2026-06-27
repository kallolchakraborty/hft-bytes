---
type: reference
title: "CPU Performance Analysis with TMAM"
description: "Top-Down Microarchitecture Analysis (TMAM) is Intel's bottleneck classification methodology. This covers using perf stat --topdown, pmu-tools/toplev, interpreting front-end vs back-end vs bad speculation vs retiring categories, and mapping bottlenecks to source-level fixes for HFT workloads."
tags: ["performance", "cpu-architecture", "profiling"]
difficulty: staff
timestamp: "2026-06-27T11:45:00.000Z"
phase: 3
phaseName: "C++ Low-Latency Patterns"
category: "Performance"
subcategory: "cpp-patterns"
language: "cpp"
artifact-id: "ZHFT_CPU_PERF_ANALYSIS"
---

## Key Learning Points

- **TMAM (Top-Down Microarchitecture Analysis)**: Intel's methodology classifies each CPU cycle into four top-level categories: Retiring (useful µops retired), Bad Speculation (mispredicted branches, nops from pipeline flushes), Front-End Bound (stalls fetching/deco ding µops), Back-End Bound (stalls executing/committing µops — sub-divided into Memory Bound and Core Bound). Target for HFT: Retiring > 50%, each bound < 15%
- **Measurement tools**: `perf stat --topdown` (Ice Lake+) gives per-second breakdown; `pmu-tools toplev` (or `toplev`) drills into hierarchical sub-categories down to 200+ specific metrics; `perf stat` with raw PMC events for custom analysis. Always run pinned to a single core (`taskset -c N`) with NI=0 priority to avoid scheduler interference
- **Front-End Bound deep dive**: caused by i-cache misses, DSB (uop cache) underflow, MITE decoder throughput limits, or branch predictor congestion. Key PMU events: `frontend_retired.latency` (>5% of cycles = problem), `icache_64b.iftag_hit` / `icache_64b.iftag_miss`, `dsb2mite_switches.penalty_cycles`. HFT fix: align hot loops to 64-byte boundary (`.p2align 5`), reduce code size to fit DSB (>50% DSB coverage is good)
- **Bad Speculation**: cycles wasted on mispredicted branches (actual + recovery). Key events: `branch_misprediction_retired.all_branches` ( >2% of branches = high), `machine_clears.count` (memory ordering nukes). HFT fix: use `__builtin_expect` / `[[likely]]`/`[[unlikely]]` to guide the BPU; avoid self-modifying code patterns; minimize indirect calls (virtual dispatch) in hot path
- **Back-End Bound — Memory Bound**: stalls waiting for data from cache or memory. Sub-categories: L1 Bound (L1 hit but latency), L2 Bound, L3 Bound, DRAM Bound, Store Bound (store buffer full). Key events: `mem_load_uops_retired.l1_hit` / `.l2_hit` / `.l3_hit` / `.l3_miss`, `offcore_requests_outstanding.cycles_with_data_rd`. HFT fix: prefetch (`_mm_prefetch`) for streaming access patterns; reduce pointer-chasing depth; consider software prefetch for known stride patterns
- **Back-End Bound — Core Bound**: stalls waiting for execution resources (execution port contention, divider busy, long-latency µops). Key events: `uops_executed.port_0` through `uops_executed.port_5` (measure port pressure), `arith.divider_active`. HFT fix: distribute critical path across multiple ports (e.g., use `lea` instead of `add+mov`), avoid division in hot path, use SIMD for parallel work
- **Retiring analysis**: not all retiring cycles are equal — `uops_retired.retire_slots / cycles` gives IPC. High IPC (>3.0) but still slow can indicate many cheap µops (e.g., lots of `nop`s from alignment padding). Filter with `uops_retired.macro_fused` (micro-fused ops) and `uops_executed.thread` to distinguish µop count from macro-op count
- **Pipeline slot accounting**: each cycle offers 4 pipeline slots (Skylake+). TMAM counts how each slot is used: Retired (completed usefully), Front-End Bound (no µop delivered), Back-End Bound (µop delivered but stalled), Bad Speculation (µop delivered but later cancelled). Total slots = 4 × cycles. Sum of all four categories = total slots. This is the fundamental equation of TMAM
- **False sharing detection**: `perf c2c` (cache-to-cache) records HITM (hit modified) events to identify cache lines bouncing between cores. Look for lines with high `llc_hits` + high `rmt_hits` (remote socket). HFT fix: pad hot data to 64 bytes (`alignas(64)`), separate read-mostly and write-mostly variables into different cache lines

## Usage

```cpp
// Run TMAM analysis on your trading binary
// sudo perf stat --topdown -C 2 taskset -c 2 ./my_strategy

// Deeper analysis with toplev:
// toplev --core-delta 1000 --no-desc taskset -c 2 ./my_strategy

// Raw PMC analysis:
// perf stat -e cycles,instructions,branch-misses,\
//   L1-dcache-load-misses,LLC-load-misses \
//   taskset -c 2 ./my_strategy

// C2C false sharing:
// perf c2c record -a --ldlat=30 -- taskset -c 2 ./my_strategy
// perf c2c report --stdio
```

## Source Code

```cpp
#include <cstdint>
#include <iostream>
#include <chrono>
#include <thread>

// -------------------------------------------------------------------
// Example: instrument a hot loop with RDTSC to measure cycles/iteration
// Use this to measure the impact of TMAM-guided optimizations.
// -------------------------------------------------------------------
static inline uint64_t rdtscp() {
    uint32_t hi, lo;
    asm volatile("rdtscp" : "=a"(lo), "=d"(hi) :: "ecx");
    return (uint64_t(hi) << 32) | lo;
}

// Align hot function to 64-byte boundary for DSB friendliness
struct alignas(64) align_to_line {};

template <typename Fn>
void benchmark(Fn fn, const char* label, int iterations = 1000000) {
    // Warmup
    for (int i = 0; i < 1000; i++) fn();

    auto start = rdtscp();
    for (int i = 0; i < iterations; i++) fn();
    auto end = rdtscp();

    double cycles_per = double(end - start) / iterations;
    std::cout << label << ": " << cycles_per << " cycles/iter\n";
}

// -------------------------------------------------------------------
// Bad: virtual call in hot path (Bad Speculation + Front-End penalty)
// -------------------------------------------------------------------
struct HandlerBase {
    virtual int handle(int v) = 0;
};
struct AddHandler : HandlerBase {
    int handle(int v) override { return v + 1; }
};

// -------------------------------------------------------------------
// Better: direct call + likely/unlikely hint
// -------------------------------------------------------------------
inline int hot_path(int v) {
    // Use [[likely]] to guide branch prediction
    if (v > 0) [[likely]] {
        return v + 1;
    }
    return v - 1;
}

int main() {
    AddHandler handler;

    // Test virtual dispatch (bad)
    benchmark([&]() { return handler.handle(42); },
              "Virtual dispatch", 1000000);

    // Test direct call with [[likely]] (good)
    benchmark([&]() { return hot_path(42); },
              "Direct call", 1000000);

    // Test: check DSB impact by comparing aligned vs unaligned loops
    // Use perf stat --topdown to compare IPC and front-end bound

    return 0;
}
```

## Staff+ Perspective

> **Staff+ Perspective**: TMAM is the single most useful performance methodology for HFT, but it requires careful interpretation. The biggest trap: `perf stat --topdown` averages across the entire measurement window. If your trading thread has idle periods (waiting for market data), the breakdown shifts toward "Retiring" (from nops in the poll loop) and masks real bottlenecks in the data-processing path. Always segment: profile only the active processing window, or subtract the idle profile. At the firm, we built a custom perf wrapper that started recording on a signal from the RDTSC timer (when data arrived) and stopped when processing finished — giving us TMAM breakdowns per-message rather than per-second. The false-positive rate from CPU frequency scaling also bit us: a run at 3.8 GHz and another at 4.0 GHz gave wildly different TMAM breakdowns because the memory latency (in ns) stayed the same but the cycle count changed. Normalize to cycles-per-byte or use fixed-frequency when comparing runs. For the portfolio of 50+ strategies, we automated TMAM profiling in CI: every release build ran `toplev` with a 30-second real-data replay, and the output was compared against the previous baseline. Any metric moving more than 2 standard deviations triggered a perf review. This caught a 15% regression from a compiler upgrade (new GCC version changed loop unrolling heuristics, causing DSB overflow) within hours of the commit.
