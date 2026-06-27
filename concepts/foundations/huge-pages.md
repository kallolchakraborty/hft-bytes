---
type: reference
title: "Huge Pages"
description: "Standard 4 KB pages cause TLB misses on large working sets.. TLB coverage: 32-64 L1 TLB entries * 4 KB = only 128-256 KB."
tags: ["phase-1"]
difficulty: beginner
timestamp: "2026-06-27T03:06:09.397Z"
phase: 1
phaseName: "Foundations"
category: "Foundations"
subcategory: "foundations"
language: "cpp"
artifact-id: "ZHFT_HUGE_PAGES"
---
## Key Learning Points

- Standard 4 KB pages cause TLB misses on large working sets.
- TLB coverage: 32-64 L1 TLB entries * 4 KB = only 128-256 KB.
- Transparent Huge Pages (THP) are dangerous for HFT: khugepaged
- mmap with MAP_HUGETLB for 2 MB pages; mount hugetlbfs for 1 GB.
- Allocate at boot via "default_hugepagesz=1G hugepagesz=1G hugepages=16"
- libhugetlbfs patches malloc/jemalloc to back allocations with

## Usage

// g++ -std=c++20 -O3 ZHFT_HUGE_PAGES.txt -o huge_alloc
// sudo ./huge_alloc   (needs CAP_IPC_LOCK or huge page quota)
// sudo ./huge_alloc --measure-tlb  (runs TLB miss measurement)

## Source Code

```cpp
#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <format>
#include <iostream>
#include <mutex>
#include <numa.h>
#include <sys/mman.h>
#include <unistd.h>

// -------------------------------------------------------------------
// ARENA ALLOCATOR backed by 1 GB huge pages
//
// This arena grabs a pool of 1 GB pages at startup and hands out
// sub-allocations from them.  All memory is naturally huge-page-backed
// so TLB misses are minimised for any working set up to the arena size.
//
// Important: Allocating 1 GB pages at runtime can fail if the kernel
// hasn't reserved them at boot (use hugepages=16 on cmdline).  This
// allocator falls back to 2 MB pages, then 4 KB.
// -------------------------------------------------------------------

class HugePageArena {
    static constexpr std::size_t kGB = 1024UL * 1024 * 1024;
    static constexpr std::size_t kMB = 1024UL * 1024;
    static constexpr std::size_t k2MB = 2UL * kMB;

    struct Region {
        char*  base;
        std::size_t size;
        std::atomic<std::size_t> offset{0};
    };

    std::vector<Region> regions_;
    std::mutex          grow_mutex_;

    // Attempt to mmap a 1 GB huge page.
    static auto alloc_1gb() -> char* {
        void* p = mmap(nullptr, kGB, PROT_READ | PROT_WRITE,
                       MAP_PRIVATE | MAP_ANONYMOUS | MAP_HUGETLB |
                       MAP_HUGE_1GB,
                       -1, 0);
        if (p == MAP_FAILED) return nullptr;
        // Touch pages to commit physical memory (page-fault them in).
        // Without this, the kernel lazily faults; for guaranteed latency
        // we want physical pages wired now.
        std::memset(p, 0, kGB);
        return static_cast<char*>(p);
    }

    static auto alloc_2mb() -> char* {
        void* p = mmap(nullptr, k2MB, PROT_READ | PROT_WRITE,
                       MAP_PRIVATE | MAP_ANONYMOUS | MAP_HUGETLB,
                       -1, 0);
        if (p == MAP_FAILED) return nullptr;
        std::memset(p, 0, k2MB);
        return static_cast<char*>(p);
    }

    // Fallback: 4 KB regular page.
    static auto alloc_4kb(std::size_t sz) -> char* {
        // We align to 2 MB boundary so that future madvise can promote.
        void* p = nullptr;
        ::posix_memalign(&p, k2MB, sz);
        if (!p) return nullptr;
        std::memset(p, 0, sz);
        return static_cast<char*>(p);
    }

public:
    explicit HugePageArena(std::size_t initial_gb = 4) {
        // Try 1 GB pages first; fall back to 2 MB, then 4 KB.
        for (std::size_t i = 0; i < initial_gb; ++i) {
            char* p = alloc_1gb();
            if (p) {
                regions_.push_back({p, kGB, 0});
                std::cout << std::format("  Allocated 1 GB huge page @ {}\n",
                                         (void*)p);
                continue;
            }
            // Fallback: 64 * 2 MB = 128 MB chunks; allocate 8 to make 1 GB.
            // This is slower but still gives TLB benefit.
            for (int j = 0; j < 512; ++j) {
                char* p2 = alloc_2mb();
                if (p2) {
                    regions_.push_back({p2, k2MB, 0});
                } else {
                    // Last resort: 4 KB pages.  TLB will suffer.
                    char* p4k = alloc_4kb(k2MB);
                    if (!p4k) {
                        std::cerr << "FATAL: out of memory\n";
                        std::abort();
                    }
                    regions_.push_back({p4k, k2MB, 0});
                }
            }
        }
    }

    ~HugePageArena() {
        for (auto& r : regions_) {
            munmap(r.base, r.size);
        }
    }

    // Thread-safe allocation from the arena.  No free() — the arena
    // is meant for persistent HFT data structures (order book, symbol
    // table) that live for the lifetime of the process.
    [[nodiscard]] auto allocate(std::size_t sz) -> void* {
        // Align to 64 B cache line.
        sz = (sz + 63) & ~63;
        for (auto& r : regions_) {
            auto off = r.offset.fetch_add(sz);
            if (off + sz <= r.size) {
                return r.base + off;
            }
            // Overflow; revert the fetch_add.
            r.offset.fetch_sub(sz);
        }
        // Grow: acquire lock, allocate a new 1 GB region.
        std::lock_guard<std::mutex> lock(grow_mutex_);
        // Double-check after acquiring lock.
        for (auto& r : regions_) {
            auto off = r.offset.fetch_add(sz);
            if (off + sz <= r.size) return r.base + off;
            r.offset.fetch_sub(sz);
        }
        char* p = alloc_1gb();
        if (!p) p = alloc_2mb();
        if (!p) p = alloc_4kb(kGB);
        if (!p) return nullptr;
        regions_.push_back({p, kGB, 0});
        auto off = regions_.back().offset.fetch_add(sz);
        return regions_.back().base + off;
    }

    // Disable copy/move.
    HugePageArena(const HugePageArena&) = delete;
    HugePageArena& operator=(const HugePageArena&) = delete;
};

// -------------------------------------------------------------------
// TLB Miss Measurement Utility
//
// Compares random-access latency with 4 KB vs 2 MB vs 1 GB pages.
// The benchmark allocates a large array, touches it with random
// strides, and measures the average access time.
// -------------------------------------------------------------------

static void measure_tlb_impact() {
    constexpr std::size_t kSize   = 512 * 1024 * 1024;  // 512 MB
    constexpr std::size_t kStride = 4096;                // page-sized
    constexpr int         kRounds = 100;

    std::cout << "\n=== TLB Miss Measurement (512 MB working set) ===\n";

    // --- Test 1: 4 KB pages (via regular malloc) ---
    {
        volatile char* buf = static_cast<volatile char*>(
            std::aligned_alloc(4096, kSize));
        if (!buf) { std::cerr << "malloc failed\n"; return; }
        std::memset(const_cast<char*>(buf), 0, kSize);

        double best = 1e9;
        for (int r = 0; r < kRounds; ++r) {
            auto t0 = std::chrono::steady_clock::now();
            std::uintptr_t sum = 0;
            // Every access hits a different page → TLB miss every time.
            for (std::size_t off = 0; off < kSize; off += kStride) {
                sum += buf[off];
            }
            auto t1 = std::chrono::steady_clock::now();
            double ns = std::chrono::duration<double, std::nano>(t1 - t0).count();
            best = std::min(best, ns / (kSize / kStride));
        }
        std::cout << std::format("  4 KB pages: {:.1f} ns/access (TLB miss on every access)\n", best);
        std::free(const_cast<char*>(buf));
    }

    // --- Test 2: Huge pages (via our arena) ---
    {
        // Allocate 640 MB arena with 1 GB pages.
        HugePageArena arena(1);
        volatile char* buf = static_cast<volatile char*>(arena.allocate(kSize));
        if (!buf) { std::cerr << "arena alloc failed\n"; return; }
        std::memset(const_cast<char*>(buf), 0, kSize);

        double best = 1e9;
        for (int r = 0; r < kRounds; ++r) {
            auto t0 = std::chrono::steady_clock::now();
            std::uintptr_t sum = 0;
            for (std::size_t off = 0; off < kSize; off += kStride) {
                sum += buf[off];
            }
            auto t1 = std::chrono::steady_clock::now();
            double ns = std::chrono::duration<double, std::nano>(t1 - t0).count();
            best = std::min(best, ns / (kSize / kStride));
        }
        std::cout << std::format("  Huge pages (1 GB): {:.1f} ns/access (no TLB miss for 512 MB)\n", best);
    }
}

// -------------------------------------------------------------------
// MAIN
// -------------------------------------------------------------------
auto main(int argc, char** argv) -> int {
    bool measure_tlb = false;
    for (int i = 1; i < argc; ++i) {
        if (std::string(argv[i]) == "--measure-tlb")
            measure_tlb = true;
    }

    std::cout << "=== Huge Page Arena Allocator ===\n";
    // Pre-allocate 2 GB of huge-page-backed memory.
    HugePageArena arena(2);

    // Example: allocate an order book that must be TLB-friendly.
    void* book = arena.allocate(256 * 1024 * 1024);  // 256 MB
    std::cout << std::format("Allocated 256 MB order book @ {}\n", book);

    void* symbol_table = arena.allocate(64 * 1024 * 1024);  // 64 MB
    std::cout << std::format("Allocated 64 MB symbol table @ {}\n", symbol_table);

    if (measure_tlb) {
        measure_tlb_impact();
    }

    std::cout << "\nTip: To reserve 1 GB pages at boot, add to GRUB:\n"
              << "  default_hugepagesz=1G hugepagesz=1G hugepages=16\n";
    return 0;
}
```
