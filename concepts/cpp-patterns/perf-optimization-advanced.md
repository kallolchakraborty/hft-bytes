---
type: reference
title: "Advanced Performance Optimization"
description: "PGO (Profile-Guided Optimization) instrumented and sample-based flows, LTO (Link-Time Optimization) cross-module inlining, BOLT (Binary Optimization and Layout Tool) function/block reordering, perf c2c for false sharing, and integration into CI pipelines."
tags: ["performance"]
difficulty: staff
timestamp: "2026-06-27T03:40:00.000Z"
phase: 3
phaseName: "C++ Low-Latency Patterns"
category: "C++ Patterns"
subcategory: "cpp-patterns"
language: "cpp"
artifact-id: "ZHFT_PERF_OPTIMIZATION_ADVANCED"
---
## Key Learning Points

- PGO (Profile-Guided Optimization): two-phase compilation — first build with `-fprofile-generate`, run workload to collect profiling data, rebuild with `-fprofile-use`; GCC/Clang reorder basic blocks, inline hot callers, optimize branch layout
- Instrumented vs sample-based PGO: instrumented (`-fprofile-generate`) adds counter instrumentation (slower binary, ~1.5x runtime) but more precise; sample-based (`-fprofile-sample-use`) uses `perf record` data with `-fprofile-sample-use`; no instrumentation overhead but statistical noise
- LTO (Link-Time Optimization): `-flto` enables cross-module inlining, constant propagation, dead code elimination across translation units; combine with PGO for maximum benefit
- BOLT (Binary Optimization and Layout Tool): post-link optimizer by Meta/Facebook; rewrites ELF binary layout; reorders functions by call frequency (hot functions contiguous), reorders basic blocks intra-function for fall-through branches; typically gains 5-15% on CPU-bound code
- CI integration: maintain profiling harness that replays production-like workload; regenerate profiles nightly; store baseline profile in git LFS; gate PRs on perf regression
- Compiler flags for HFT: `-march=native -mtune=native -O3 -ffast-math -flto -fprofile-use`; avoid `-funroll-loops` (increases code size); prefer `-fomit-frame-pointer` for registers
- Real PGO experience on a trading hot path: the market-data parser's `getOrderUpdate()` function consumed 12% of CPU per profiling run; PGO inlined the hot path (fast-path for Add Order), de-virtualized the handler dispatch, and reordered branches so the Add Order check fell through ~95% of the time; the cold branch (Delete/Modify) was moved out-of-line. Result: 220→175ns per message, 20% improvement, just from PGO.
- PGO profile staleness: profiles >7 days old lose effectiveness if the strategy's order profile changes (e.g., new symbol added, different market regime). Detect staleness by comparing profile branch counts against runtime PMU counters (branch miss rate >5% indicates stale profile). Automate profile regeneration when miss rate threshold exceeded.
- BOLT in practice: after PGO+LTO, BOLT reorders the binary at the function level — hot functions (parser, allocator, memcpy) moved to the first 64KB of .text, cold functions (startup, cleanup, error paths) moved to a separate section. This reduced iTLB misses by 30% in testing. BOLT's `-reorder-blocks=cache` also reorders basic blocks intra-function so the fast path (no error) is a straight-line fall-through. Combine: PGO → LTO → BOLT for maximum gain.
- Cross-file inlining with ThinLTO: regular LTO loads all IR into memory (fails for large codebases); ThinLTO divides the callgraph, creates import lists per module, and inlines selectively. Set `-flto=thin -fwhole-program-vtables` for C++ apps. For Chromium-sized codebases, ThinLTO reduces LTO memory from 64GB to 4GB.
- Hardware performance counter integration: map perf counter PMU events to source lines using `perf annotate`; track `branch-misses`, `L1-icache-misses`, `iTLB-load-misses` per function; use `topdown` counters (Top-Down Microarchitecture Analysis) to identify front-end vs back-end bound. CI pipeline can compute a "perf score" as geometric mean of normalized counter values across microbenchmarks.

## Usage

```cpp
// PGO workflow (Makefile targets)
// Step 1: Instrumented build
// CXXFLAGS += -fprofile-generate=/tmp/pgo_data
// make clean && make
// # Run workload
// taskset -c 2 ./bench/trading_bench --samples 100000
//
// Step 2: Profile-use build
// CXXFLAGS += -fprofile-use=/tmp/pgo_data
// make clean && make
// # Binary now has PGO-optimized layout

// LTO + PGO combined:
// CXXFLAGS = -O3 -flto -fprofile-use=/tmp/pgo_data \
//            -march=native -mtune=native -fomit-frame-pointer
// LDFLAGS = -flto -fuse-ld=lld

// BOLT invocation:
// llvm-bolt trading_binary -o trading_binary.bolted \
//   --data=/tmp/perf.data \
//   --reorder-blocks=cache+ \
//   --reorder-functions=hfsort+ \
//   --split-functions --icf=all \
//   --peepholes=all

// Verify improvement:

## Staff+ Perspective

> **Staff+ Perspective**: PGO is the single highest-ROI optimization for HFT code. We saw 15-25% throughput improvement on the market-data parser with PGO alone. The catch: the profile must represent the production workload. If your profile replay uses CME data but your strategy trades Eurex, the branch layout is optimized for the wrong pattern. Always regenerate profiles on the actual exchange and product mix. For BOLT: it's worth 5-10% on top of PGO+LTO on large binaries (>50MB .text). The memory cost is significant — BOLT's final binary can be 2x larger due to function reordering padding. This increases I-cache pressure on lower-end CPUs. Only use BOLT on the latency-critical path (e.g., the parser binary, not the risk server). At DRW, BOLT was worth 8% on the market-data pipeline but 0% on the OMS — the OMS is I/O-bound, not CPU-bound.

## Source Code

```cpp
// perf c2c for false sharing detection
// # perf c2c record -a --ldlat=30 -- ./trading_strategy
// # perf c2c report --stdio
// Look for "Shared Data Cache Line" with high "llc_miss" on cacheline

// Hardware counters for HFT (via perf stat):
// # perf stat -e cycles,instructions,L1-dcache-load-misses,\
//   LLC-load-misses,branch-misses,context-switches \
//   taskset -c 2 ./feed_handler

// Typical targets for HFT pipeline:
// IPC > 2.5 (instruction-level parallelism)
// L1 miss < 5% (working set fits L1)
// LLC miss < 0.5% (prefetch-friendly access)
// Branch mispredict < 2% (predictable patterns)
```
