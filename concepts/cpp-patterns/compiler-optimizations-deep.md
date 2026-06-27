---
type: reference
title: "Advanced Compiler Optimizations for HFT"
description: "PGO with trading hot-path examples, ThinLTO vs full LTO tradeoffs, BOLT binary layout for icache locality, -march=native decision matrix, and compiler barriers vs memory barriers for latency-critical trading code."
tags: ["cpp-patterns"]
difficulty: staff
timestamp: "2026-06-27T06:00:00.000Z"
phase: 3
phaseName: "C++ Low-Latency Patterns"
category: "C++ Low-Latency Patterns"
subcategory: "cpp-patterns"
language: "cpp"
artifact-id: "ZHFT_COMPILER_OPT_DEEP"
---
## Key Learning Points

- PGO (Profile-Guided Optimization): build with `-fprofile-generate`, run on production trace, rebuild with `-fprofile-use`; reorders basic blocks for hot/cold splitting, inlines at hot call sites, optimizes switch statements for common paths
- ThinLTO vs full LTO: ThinLTO partitions IR per translation unit with a thin global index — 80-90% of full LTO benefit at fraction of link time; full LTO can be 5-10x slower to link, impractical for large trading codebases
- BOLT (Binary Optimization and Layout Tool): post-link binary rewriter that profiles and relayouts `.text` section for icache locality; typical 5-15% latency reduction on trading hot paths; requires `–pgo` profile or perf-lbr sampling
- `-march` decision matrix: `-march=native` gives max perf but ties binary to specific CPU stepping; `-march=skylake-avx512` + `-mtune=cascadelake` balances portability and perf; for colo deployments, `-march=native` is safe since hardware is homogeneous
- Compiler barrier vs memory barrier: `asm volatile("" ::: "memory")` prevents compiler reordering across the barrier (zero cost at runtime); `std::atomic_signal_fence(memory_order_seq_cst)` same effect in C++11; does NOT prevent CPU reordering — use `mfence` or `lock` prefix for that

```html
<div class="ad-wrapper">
  <div class="ad-title">PGO Compilation Flow</div>
  <div class="ad-flow">
    <div class="ad-stage active"><span class="ad-stage-icon">⚙️</span><span class="ad-stage-label">Build -fprofile-gen</span></div>
    <div class="ad-arrow"><span class="material-symbols-outlined">chevron_right</span><span class="ad-packet"></span></div>
    <div class="ad-stage"><span class="ad-stage-icon">▶️</span><span class="ad-stage-label">Run Prod Trace</span></div>
    <div class="ad-arrow"><span class="material-symbols-outlined">chevron_right</span><span class="ad-packet"></span></div>
    <div class="ad-stage"><span class="ad-stage-icon">📊</span><span class="ad-stage-label">Profile Data</span></div>
    <div class="ad-arrow"><span class="material-symbols-outlined">chevron_right</span><span class="ad-packet"></span></div>
    <div class="ad-stage"><span class="ad-stage-icon">⚡</span><span class="ad-stage-label">Rebuild -fprofile-use</span></div>
    <div class="ad-arrow"><span class="material-symbols-outlined">chevron_right</span><span class="ad-packet"></span></div>
    <div class="ad-stage"><span class="ad-stage-icon">🚀</span><span class="ad-stage-label">Optimized Binary</span></div>
  </div>
</div>
```

## Usage

```bash
# Step 1: Build with instrumentation
g++ -O3 -march=native -flto=thin -fprofile-generate \
  -o trading_strategy_pgo strategy.cpp order_book.cpp risk_checks.cpp

# Step 2: Run on production-like workload
./trading_strategy_pgo --mode replay --input /data/trace.itch

# Step 3: Rebuild with profiles (profraw -> profdata)
llvm-profdata merge -output=default.profdata *.profraw
g++ -O3 -march=native -flto=thin -fprofile-use \
  -o trading_strategy strategy.cpp order_book.cpp risk_checks.cpp

# BOLT post-link optimization
llvm-bolt trading_strategy -o trading_strategy.bolt \
  -pdata=perf.data -reorder-blocks=ext-tsp -split-functions=3
```

## Source Code

```cpp
// Compiler barrier — prevents reordering, zero runtime cost
#define COMPILER_BARRIER() asm volatile("" ::: "memory")

// Trading hot path example that benefits from PGO
void on_market_tick(const MarketDataEntry& entry) {
    COMPILER_BARRIER();
    auto price = entry.price();
    auto signal = compute_signal(entry);  // hot — PGO inlines this
    COMPILER_BARRIER();
    if (signal > threshold_) {
        send_order(entry.symbol(), price, signal);
    }
}
```
