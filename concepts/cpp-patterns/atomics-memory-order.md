---
type: reference
title: "Atomics Memory Order"
description: "memory_order_relaxed: no ordering constraints; fastest (~1ns).. memory_order_acquire/release: establish happens-before between"
tags: ["order-types"]
difficulty: intermediate
timestamp: "2026-06-27T03:06:09.404Z"
phase: 3
phaseName: "C++ Low-Latency Patterns"
category: "C++ Low-Latency Patterns"
subcategory: "cpp-patterns"
language: "cpp"
artifact-id: "ZHFT_ATOMICS_MEMORY_ORDER"
---
## Key Learning Points

- memory_order_relaxed: no ordering constraints; fastest (~1ns).
- memory_order_acquire/release: establish happens-before between
- memory_order_acq_rel: combines acquire and release; needed for
- memory_order_seq_cst: total global order; slowest (~20-40ns) but
- Wait-free vs lock-free: an algorithm is wait-free if every thread

## Usage

AtomicCounter relaxed(0);
relaxed.add(1);          // relaxed
auto v = relaxed.get();  // relaxed (no synchronization needed)
Seqlock seqlock;
seqlock.store(data);
auto [d, ok] = seqlock.load(data);

## Source Code

```cpp
#include <atomic>
#include <cstdint>
#include <cstddef>
#include <cstring>
#include <thread>
#include <chrono>
#include <vector>
#include <optional>
#include <array>
#include <cassert>
#include <iostream>

// ---------------------------------------------------------------------------
// Atomic counter with different memory orders for benchmarking
// ---------------------------------------------------------------------------
class AtomicCounter {
public:
    explicit AtomicCounter(uint64_t initial = 0) : val_(initial) {}

    // Relaxed: no ordering, just atomicity
    void addRelaxed(uint64_t delta) {
        val_.fetch_add(delta, std::memory_order_relaxed);
    }

    // Release: ensures prior writes are visible to consumer
    void addRelease(uint64_t delta) {
        val_.fetch_add(delta, std::memory_order_release);
    }

    // Acquire: ensures subsequent reads see producer's writes
    uint64_t loadAcquire() const {
        return val_.load(std::memory_order_acquire);
    }

    // Seq_cst: full ordering
    void addSeqCst(uint64_t delta) {
        val_.fetch_add(delta, std::memory_order_seq_cst);
    }

    uint64_t loadSeqCst() const {
        return val_.load(std::memory_order_seq_cst);
    }

    // Relaxed load
    uint64_t loadRelaxed() const {
        return val_.load(std::memory_order_relaxed);
    }

    void storeRelease(uint64_t v) {
        val_.store(v, std::memory_order_release);
    }

private:
    std::atomic<uint64_t> val_;
};

// ---------------------------------------------------------------------------
// Seqlock (sequential lock): lock-free reads, blocking writes
// Writer acquires a spinlock; reader detects torn reads via sequence counter
// ---------------------------------------------------------------------------
template <typename T>
class Seqlock {
    static_assert(std::is_trivially_copyable_v<T>,
                  "Seqlock requires trivially copyable type");

public:
    Seqlock() : seq_(0) {}

    // Writer: acquire lock, write data, release lock
    void store(const T& data) {
        uint64_t seq = seq_.load(std::memory_order_relaxed);
        seq_.store(seq + 1, std::memory_order_release);  // odd → locked

        std::atomic_signal_fence(std::memory_order_acq_rel);
        data_ = data;
        std::atomic_signal_fence(std::memory_order_acq_rel);

        seq_.store(seq + 2, std::memory_order_release);  // even → unlocked
    }

    // Reader: read data and verify no concurrent write
    // Returns data and whether the read was consistent
    std::pair<T, bool> load() const {
        T copy;
        uint64_t seq0, seq1;

        do {
            seq0 = seq_.load(std::memory_order_acquire);
            if ((seq0 & 1) == 1) {  // writer active, spin
                _mm_pause();
                continue;
            }

            std::atomic_signal_fence(std::memory_order_acq_rel);
            std::memcpy(&copy, &data_, sizeof(T));
            std::atomic_signal_fence(std::memory_order_acq_rel);

            seq1 = seq_.load(std::memory_order_acquire);
        } while (seq0 != seq1);  // torn if changed during read

        return {copy, true};
    }

    // Optimistic read (no retry loop — caller decides)
    std::optional<T> tryLoad() const {
        uint64_t seq0 = seq_.load(std::memory_order_acquire);
        if (seq0 & 1) return std::nullopt;  // writer active

        T copy;
        std::memcpy(&copy, &data_, sizeof(T));
        std::atomic_thread_fence(std::memory_order_acquire);

        uint64_t seq1 = seq_.load(std::memory_order_relaxed);
        if (seq0 != seq1) return std::nullopt;  // torn
        return copy;
    }

    // Wait-free for readers (no CAS, no loops if no contention)
    // Writer is blocking (uses store, not CAS)

private:
    alignas(64) std::atomic<uint64_t> seq_;
    alignas(64) T data_;
};

// ---------------------------------------------------------------------------
// Atomic spinlock (for comparison)
// ---------------------------------------------------------------------------
class Spinlock {
public:
    void lock() {
        while (flag_.test_and_set(std::memory_order_acquire))
            _mm_pause();
    }

    void unlock() {
        flag_.clear(std::memory_order_release);
    }

private:
    std::atomic_flag flag_ = ATOMIC_FLAG_INIT;
};

// ---------------------------------------------------------------------------
// Hazard pointer based reclamation (simplified)
// See also ZHFT_LOCK_FREE_QUEUE for tagged pointers
// ---------------------------------------------------------------------------
template <typename T>
class HazardPointerReclaimer {
    static constexpr size_t MAX_THREADS = 64;
    static constexpr size_t RETIRE_LIST_SIZE = 256;

    struct ThreadData {
        std::atomic<const T*> hp{nullptr};
    };

public:
    HazardPointerReclaimer() : retired_count_(0) {
        for (auto& td : thread_data_)
            td.hp.store(nullptr, std::memory_order_relaxed);
    }

    void protect(const T* ptr, size_t slot = 0) {
        thread_data_[slot].hp.store(ptr, std::memory_order_release);
    }

    void unprotect(size_t slot = 0) {
        thread_data_[slot].hp.store(nullptr, std::memory_order_release);
    }

    bool isProtected(const T* ptr) const {
        for (auto& td : thread_data_)
            if (td.hp.load(std::memory_order_acquire) == ptr)
                return true;
        return false;
    }

    void retire(T* ptr) {
        if (retired_count_ >= RETIRE_LIST_SIZE)
            scan();
        retired_[retired_count_++] = ptr;
    }

    void scan() {
        for (size_t i = 0; i < retired_count_; ++i) {
            if (!isProtected(retired_[i])) {
                delete retired_[i];
                retired_[i] = nullptr;
            }
        }
        // Compact
        size_t write = 0;
        for (size_t i = 0; i < retired_count_; ++i)
            if (retired_[i])
                retired_[write++] = retired_[i];
        retired_count_ = write;
    }

private:
    std::array<ThreadData, MAX_THREADS> thread_data_;
    std::array<T*, RETIRE_LIST_SIZE> retired_;
    std::atomic<size_t> retired_count_;
};

// ---------------------------------------------------------------------------
// Benchmark: compare memory ordering overhead
// ---------------------------------------------------------------------------
class MemoryOrderBenchmark {
public:
    struct Result {
        double relaxed_ns;
        double acq_rel_ns;
        double seq_cst_ns;
        double seqlock_read_ns;
    };

    static Result run(size_t iterations = 1000000) {
        AtomicCounter counter;

        auto relaxed_start = __builtin_ia32_rdtsc();
        for (size_t i = 0; i < iterations; ++i)
            counter.addRelaxed(1);
        auto relaxed_end = __builtin_ia32_rdtsc();

        auto seq_start = __builtin_ia32_rdtsc();
        for (size_t i = 0; i < iterations; ++i)
            counter.addSeqCst(1);
        auto seq_end = __builtin_ia32_rdtsc();

        // Convert cycles to ns (assuming ~3GHz)
        constexpr double ns_per_cycle = 1.0 / 3.0;

        return {
            (relaxed_end - relaxed_start) * ns_per_cycle / iterations,
            (seq_end - seq_start) * ns_per_cycle / iterations,
            (seq_end - seq_start) * ns_per_cycle / iterations,
            5.0  // placeholder
        };
    }
};

// ---------------------------------------------------------------------------
// Example: happens-before demonstration
// ---------------------------------------------------------------------------
class HappensBeforeDemo {
    std::atomic<bool> ready_{false};
    int data_ = 0;

public:
    void producer() {
        data_ = 42;
        ready_.store(true, std::memory_order_release);  // synchronizes-with
    }

    void consumer() {
        while (!ready_.load(std::memory_order_acquire))
            _mm_pause();
        // Guaranteed to see data_ == 42 (happens-before)
        assert(data_ == 42);
    }
};

// ---------------------------------------------------------------------------
// Usage example
// ---------------------------------------------------------------------------
void example() {
    // Seqlock for reading market data snapshot
    struct alignas(64) MarketSnapshot {
        double bid;
        double ask;
        uint32_t bid_qty;
        uint32_t ask_qty;
    };

    Seqlock<MarketSnapshot> snapshot;
    snapshot.store({100.0, 100.1, 10000, 8000});
    auto [snap, ok] = snapshot.load();
    assert(ok && snap.bid == 100.0);

    // Counter benchmark
    auto results = MemoryOrderBenchmark::run(1000000);
    (void)results;
}
```
