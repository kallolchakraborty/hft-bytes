---
type: reference
title: "Advanced Performance Optimization"
description: "PGO (Profile-Guided Optimization) instrumented and sample-based flows, LTO (Link-Time Optimization) cross-module inlining, BOLT (Binary Optimization and Layout Tool) function/block reordering, perf c2c for false sharing, and integration into CI pipelines."
tags: ["performance"]
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
// hyperfine --warmup 3 './trading_binary' './trading_binary.bolted'
```

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
