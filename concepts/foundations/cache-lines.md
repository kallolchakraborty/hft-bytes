---
type: reference
title: "Cache Lines"
description: "Cache line is 64 bytes on x86-64; any write to a byte within. Intel uses MESIF where the "F" (Forward) core services snoops"
tags: ["cache-coherency"]
difficulty: beginner
timestamp: "2026-06-27T03:06:09.394Z"
phase: 1
phaseName: "Foundations"
category: "Foundations"
subcategory: "foundations"
language: "cpp"
artifact-id: "ZHFT_CACHE_LINES"
---
## Key Learning Points

- Cache line is 64 bytes on x86-64; any write to a byte within
- Intel uses MESIF where the "F" (Forward) core services snoops
- False sharing: two threads update different variables that share
- NUMA: accessing remote memory costs ~1.5-2x local latency.
- NUMA binding: use `numactl --cpubind=0 --membind=0` or

```html
<div class="ad-wrapper">
  <div class="ad-title">CPU Cache Hierarchy — Data Request Flow</div>
  <div class="ad-flow">
    <div class="ad-stage active"><span class="ad-stage-icon">💻</span><span class="ad-stage-label">CPU Core</span></div>
    <div class="ad-arrow"><span class="material-symbols-outlined">chevron_right</span><span class="ad-packet"></span></div>
    <div class="ad-stage"><span class="ad-stage-icon">⚡</span><span class="ad-stage-label">L1 Cache</span></div>
    <div class="ad-arrow"><span class="material-symbols-outlined">chevron_right</span><span class="ad-packet"></span></div>
    <div class="ad-stage"><span class="ad-stage-icon">⚡</span><span class="ad-stage-label">L2 Cache</span></div>
    <div class="ad-arrow"><span class="material-symbols-outlined">chevron_right</span><span class="ad-packet"></span></div>
    <div class="ad-stage"><span class="ad-stage-icon">⚡</span><span class="ad-stage-label">L3 Cache</span></div>
    <div class="ad-arrow"><span class="material-symbols-outlined">chevron_right</span><span class="ad-packet"></span></div>
    <div class="ad-stage"><span class="ad-stage-icon">🧠</span><span class="ad-stage-label">RAM</span></div>
  </div>
  <div class="ad-legend">
    <span class="ad-legend-item"><span class="ad-legend-swatch packet"></span>Data request (miss → next level)</span>
  </div>
</div>
```

## Usage

```bash

g++ -O3 -march=native -std=c++20 -pthread ZHFT_CACHE_LINES.txt -o cache_bench
./cache_bench [--no-false-sharing] [--numa] [--threads=N]
```

## Source Code

```cpp
#include <atomic>
#include <bit>
#include <chrono>
#include <cstdint>
#include <iostream>
#include <numa.h>      // Linux libnuma; may need -lnuma
#include <pthread.h>
#include <sched.h>
#include <string>
#include <thread>
#include <vector>

// -------------------------------------------------------------------
// BENCHMARK 1: False Sharing Detector
//
// Two threads increment their own counter at high frequency.  If the
// counters share a cache line, each increment forces a RFO (Read For
// Ownership) across cores, creating a coherency bottleneck.
// -------------------------------------------------------------------

// --- BAD: counters share a 64-byte line ---
struct alignas(64) SharedCountersBad {
    std::uint64_t a{0};   // offset 0
    std::uint64_t b{0};   // offset 8  — same cache line as a!
};

// --- GOOD: pad each counter to its own cache line ---
struct alignas(64) SharedCountersGood {
    std::uint64_t a{0};
    char          pad1[56];   // fill remaining 56 bytes of this line
    std::uint64_t b{0};
    char          pad2[56];
};

// Each thread hammers its counter for `duration_ms` milliseconds.
template <typename Shared>
static auto hammer(Shared* s, std::uint64_t Shared::*member,
                   int duration_ms) -> std::uint64_t {
    auto end = std::chrono::steady_clock::now()
             + std::chrono::milliseconds(duration_ms);
    std::uint64_t count = 0;
    // Volatile load/store to prevent the compiler from coalescing.
    // In real HFT code you'd use std::atomic but here we want raw
    // non-atomic stores to measure cache coherency cost purely.
    volatile std::uint64_t* v = reinterpret_cast<volatile std::uint64_t*>(
        &(s->*member));
    while (std::chrono::steady_clock::now() < end) {
        ++(*v);
        ++count;
    }
    return count;
}

static void detect_false_sharing(int threads, int ms) {
    // Note: on some compilers, putting both counters in the same
    // struct still lets the compiler see they're independent and
    // may keep them in registers.  The volatile trick prevents that,
    // but real false sharing in hot loops is even more vicious.
    SharedCountersBad bad;
    SharedCountersGood good;

    std::vector<std::thread> pool;
    auto worker = [&](auto* s, auto member) {
        return hammer(s, member, ms);
    };

    // --- Bad case ---
    auto t0 = std::chrono::steady_clock::now();
    for (int i = 0; i < threads; ++i) {
        pool.emplace_back(worker, &bad,
            (i % 2 == 0) ? &SharedCountersBad::a : &SharedCountersBad::b);
    }
    for (auto& t : pool) t.join();
    auto t1 = std::chrono::steady_clock::now();
    double bad_ns = std::chrono::duration<double, std::nano>(t1 - t0).count();

    pool.clear();

    // --- Good case ---
    t0 = std::chrono::steady_clock::now();
    for (int i = 0; i < threads; ++i) {
        pool.emplace_back(worker, &good,
            (i % 2 == 0) ? &SharedCountersGood::a : &SharedCountersGood::b);
    }
    for (auto& t : pool) t.join();
    t1 = std::chrono::steady_clock::now();
    double good_ns = std::chrono::duration<double, std::nano>(t1 - t0).count();

    std::cout << "False Sharing Detection (" << threads << " threads, "
              << ms << " ms):\n";
    std::cout << "  BAD  (shared line): " << bad_ns / 1e6 << " ms\n";
    std::cout << "  GOOD (padded line): " << good_ns / 1e6 << " ms\n";
    std::cout << "  Slowdown: " << bad_ns / good_ns << "x\n\n";
}

// -------------------------------------------------------------------
// BENCHMARK 2: NUMA Latency Probe
//
// Allocate memory local to socket 0 and socket 1, then measure access
// latency from a thread pinned to each socket.  This quantifies the
// NUMA penalty.
// -------------------------------------------------------------------
static void probe_numa_latency() {
    if (numa_available() < 0) {
        std::cout << "NUMA not available; skipping.\n";
        return;
    }

    constexpr std::size_t kSize = 64UL * 1024 * 1024;  // 64 MB

    // Allocate on node 0.
    numa_set_preferred(0);
    auto* local = static_cast<volatile char*>(
        numa_alloc_local(kSize));
    // Touch all pages to force physical allocation.
    for (std::size_t i = 0; i < kSize; i += 4096) local[i] = 0;

    // Allocate on node 1.
    numa_set_preferred(1);
    auto* remote = static_cast<volatile char*>(
        numa_alloc_local(kSize));
    for (std::size_t i = 0; i < kSize; i += 4096) remote[i] = 0;

    // Helper: read latency via pointer chase on the buffer.
    auto measure = [](volatile char* buf, std::size_t sz) -> double {
        // Build a random-access pattern within the buffer.
        // Simple: stride by 4096 (page size) to get TLB miss + DRAM.
        auto t0 = std::chrono::steady_clock::now();
        std::uintptr_t sum = 0;
        for (int r = 0; r < 100; ++r) {
            for (std::size_t off = 0; off < sz; off += 4096) {
                sum += buf[off];
            }
        }
        auto t1 = std::chrono::steady_clock::now();
        auto ns = std::chrono::duration<double, std::nano>(t1 - t0).count();
        double accesses = 100.0 * static_cast<double>(sz / 4096);
        return ns / accesses;
    };

    // Pin to CPU 0 (node 0).
    cpu_set_t cpuset;
    CPU_ZERO(&cpuset);
    CPU_SET(0, &cpuset);
    pthread_setaffinity_np(pthread_self(), sizeof(cpuset), &cpuset);

    double local_lat  = measure(local, kSize);
    double remote_lat = measure(remote, kSize);

    std::cout << "NUMA Latency (pinned to socket 0):\n";
    std::cout << "  Local  memory (node 0): " << local_lat << " ns\n";
    std::cout << "  Remote memory (node 1): " << remote_lat << " ns\n";
    std::cout << "  Remote penalty: " << (remote_lat / local_lat) << "x\n\n";

    numa_free(const_cast<char*>(local), kSize);
    numa_free(const_cast<char*>(remote), kSize);
}

// -------------------------------------------------------------------
// EXAMPLE: Cache-line-aligned structure for a trading book snapshot.
// Each field that is written by a different thread lives in its own
// line to avoid false sharing.
// -------------------------------------------------------------------
struct alignas(64) TradingBookCacheLine {
    // Thread 1 (market data handler) writes:
    std::uint64_t bid_price{0};
    std::uint64_t bid_qty{0};
    char          pad1[48];   // fill line

    // Thread 2 (order manager) writes:
    std::uint64_t ask_price{0};
    std::uint64_t ask_qty{0};
    char          pad2[48];

    // Thread 3 (risk checks) reads both but writes nothing:
    // No padding needed for read-only data; readers can share lines.
    std::uint64_t last_trade_price{0};
    std::uint64_t last_trade_qty{0};
    // No pad here — last_trade is read-only on the hot path.
};

// -------------------------------------------------------------------
// MAIN
// -------------------------------------------------------------------
auto main(int argc, char** argv) -> int {
    bool run_false_sharing = true;
    bool run_numa          = true;
    int  threads          = 2;
    int  duration_ms      = 1000;

    for (int i = 1; i < argc; ++i) {
        std::string arg(argv[i]);
        if (arg == "--no-false-sharing") run_false_sharing = false;
        if (arg == "--no-numa")          run_numa = false;
        if (arg == "--threads" && i + 1 < argc)
            threads = std::stoi(argv[++i]);
        if (arg == "--duration" && i + 1 < argc)
            duration_ms = std::stoi(argv[++i]);
    }

    if (run_false_sharing)
        detect_false_sharing(threads, duration_ms);

    if (run_numa)
        probe_numa_latency();

    std::cout << "Tip: compile with -lnuma for NUMA probing.\n"
              << "Run with taskset -c 0,1 to pin threads.\n";
    return 0;
}
```
