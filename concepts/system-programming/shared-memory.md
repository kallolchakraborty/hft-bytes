---
type: reference
title: "Shared Memory"
description: "POSIX shm_open + mmap provides the lowest-latency cross-process. boost::interprocess offers portable RAII wrappers (managed_shared_memory,"
tags: ["phase-4"]
timestamp: "2026-06-27T03:06:09.414Z"
phase: 4
phaseName: "System Programming & IPC"
category: "Phase 4 - System Programming & IPC"
subcategory: "system-programming"
language: "cpp"
artifact-id: "ZHFT_SHARED_MEMORY"
---
## Key Learning Points

- POSIX shm_open + mmap provides the lowest-latency cross-process
- boost::interprocess offers portable RAII wrappers (managed_shared_memory,
- Multi-casting market data: one writer process writes a
- Synchronization choice is critical: futex (Linux fast userspace
- Semaphores (posix or named) add kernel transitions on every
- Shared-memory layout must be cache-line-aligned and avoid false

## Usage

// g++ -O3 -std=c++20 -pthread ZHFT_SHARED_MEMORY.txt -o shm_broadcaster
// Terminal 1: ./shm_broadcaster producer
// Terminal 2: ./shm_broadcaster consumer

## Source Code

```cpp
#include <atomic>
#include <bit>
#include <cerrno>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <iostream>
#include <new>
#include <span>
#include <thread>
#include <string_view>

#include <fcntl.h>
#include <linux/futex.h>
#include <sys/mman.h>
#include <sys/syscall.h>
#include <unistd.h>

// -------------------------------------------------------------------
// Shared memory segment name (per-process persistent in /dev/shm).
// -------------------------------------------------------------------
static constexpr std::string_view kShmPath = "/zhft_marketdata";
static constexpr std::size_t     kShmSize = 64UL * 1024 * 1024;  // 64 MB
static constexpr int             kNumConsumers = 4;

// -------------------------------------------------------------------
// Layout of the shared memory region.
//
// [Page 0 : Control Block]
//    writer_seqno  (atomic<uint64_t>, 8 B)
//    consumer_done (atomic<uint64_t>[kNumConsumers], 8 B each)
//    pad0[64 - 8 - 8*kNumConsumers]
//    ring_mask (uint64_t, read-only after init)
//
// [Page 1+ : Ring Buffer]
//    Each slot: 64 B header + payload.  Total slots = ring_capacity.
//
// The control block sits in its own cache line to avoid false sharing
// between writer (seqno) and consumers (done flags).
// -------------------------------------------------------------------
struct ShmControl {
    std::atomic<uint64_t> writer_seqno;     // written by producer, read by all
    std::atomic<uint64_t> consumer_done[kNumConsumers];
    char                  pad0[64 - 8 - 8 * kNumConsumers];
    uint64_t              ring_mask;         // power-of-2 - 1
};
static_assert(sizeof(ShmControl) <= 64, "ShmControl must fit one cache line");

struct alignas(64) MessageSlot {
    uint64_t seqno;
    uint64_t timestamp_ns;
    char     payload[48];                    // fixed-size for this example
};
static_assert(sizeof(MessageSlot) == 64, "MessageSlot must be 64 B (one cache line)");

// -------------------------------------------------------------------
// Compute ring capacity from shm size (excludes control page).
// -------------------------------------------------------------------
inline auto RingCapacity(std::size_t shm_size) -> std::size_t {
    return (shm_size - 4096) / sizeof(MessageSlot);
}

// -------------------------------------------------------------------
// Producer: writes market data into the shared ring buffer.
// Uses a single atomic store with release ordering so consumers see
// a fully-written slot when they observe seqno advance.
// -------------------------------------------------------------------
void RunProducer() {
    // Create / truncate shared memory.
    int fd = shm_open(kShmPath.data(), O_CREAT | O_RDWR | O_TRUNC, 0644);
    if (fd < 0) { std::perror("shm_open"); return; }
    if (ftruncate(fd, static_cast<off_t>(kShmSize)) < 0) { std::perror("ftruncate"); return; }

    void* addr = mmap(nullptr, kShmSize, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    close(fd);
    if (addr == MAP_FAILED) { std::perror("mmap"); return; }

    auto* ctrl = new (addr) ShmControl{};
    auto* slots = reinterpret_cast<MessageSlot*>(static_cast<char*>(addr) + 4096);
    std::size_t cap = RingCapacity(kShmSize);
    ctrl->ring_mask = cap - 1;
    std::atomic<uint64_t> seqno{0};

    std::cout << "[Producer] shm " << kShmPath << " created, ring capacity=" << cap << "\n";

    // Main production loop.
    uint64_t n = 0;
    for (;;) {
        MessageSlot* slot = &slots[n & ctrl->ring_mask];
        slot->seqno       = n;
        slot->timestamp_ns = 0; // real code: rdtscp()
        std::snprintf(slot->payload, sizeof(slot->payload), "msg_%010lu", n);

        // Release store: writers happens-before any consumer that reads this seqno.
        seqno.store(n + 1, std::memory_order_release);

        // Wake consumers that are futex-waiting on writer_seqno.
        // FUTEX_WAKE_OP could wake multiple at once, but simple WAKE is fine.
        for (int c = 0; c < kNumConsumers; ++c) {
            syscall(SYS_futex, &seqno, FUTEX_WAKE_PRIVATE, 1, nullptr, nullptr, 0);
        }

        ++n;
        if (n % 10'000'000 == 0) [[unlikely]] {
            std::cout << "[Producer] published " << n << " messages\n";
        }

        // Simulate inter-arrival time (HFT: ~1 µs for equity data).
        // In real deployment, remove this — just spin on next packet arrival.
        // asm volatile("pause");
    }
}

// -------------------------------------------------------------------
// Consumer: busy-poll or futex-wait for new seqno, then process.
// For truly minimal latency, busy-wait (spin) without futex.
// Here we show futex_wait which yields CPU -> better for multi-process.
// -------------------------------------------------------------------
void RunConsumer(int consumer_id) {
    int fd = shm_open(kShmPath.data(), O_RDONLY, 0);
    if (fd < 0) { std::perror("shm_open consumer"); return; }

    void* addr = mmap(nullptr, kShmSize, PROT_READ, MAP_SHARED, fd, 0);
    close(fd);
    if (addr == MAP_FAILED) { std::perror("mmap consumer"); return; }

    auto* ctrl = reinterpret_cast<const ShmControl*>(addr);
    auto* slots = reinterpret_cast<const MessageSlot*>(static_cast<const char*>(addr) + 4096);
    std::size_t cap = RingCapacity(kShmSize);

    uint64_t last_seen = 0;
    constexpr int kMaxSpin = 128;           // spin before futex_wait

    for (;;) {
        uint64_t current = ctrl->writer_seqno.load(std::memory_order_acquire);

        if (current > last_seen) {
            // Process all available slots.
            while (last_seen < current) {
                const MessageSlot& msg = slots[last_seen & ctrl->ring_mask];
                (void)msg;
                // Simulated decode: the slot is valid because we observed
                // the release-store of seqno that guarantees payload coherency.
                ++last_seen;
            }
        }

        // Spin a bit before sleeping to balance latency vs CPU usage.
        int spin = 0;
        while (spin < kMaxSpin && ctrl->writer_seqno.load(std::memory_order_relaxed) <= last_seen) {
            ++spin;
            asm volatile("pause");
        }
        if (spin >= kMaxSpin) {
            // Yield: futex_wait puts this thread to sleep until producer wakes us.
            // The kernel will only wake us when *addr (writer_seqno) != expected (last_seen).
            syscall(SYS_futex, &ctrl->writer_seqno, FUTEX_WAIT_PRIVATE,
                    static_cast<int>(last_seen), nullptr, nullptr, 0);
        }
    }
}

// -------------------------------------------------------------------
// Entry point: dispatch producer or consumer based on argv[1].
// -------------------------------------------------------------------
auto main(int argc, char** argv) -> int {
    if (argc < 2) {
        std::cerr << "Usage: " << argv[0] << " (producer|consumer<N>)\n";
        return 1;
    }
    std::string_view role{argv[1]};
    if (role == "producer") {
        RunProducer();
    } else if (role.starts_with("consumer")) {
        int id = 0;
        if (role.size() > 8) id = role[8] - '0';
        if (id < 0 || id >= kNumConsumers) id = 0;
        RunConsumer(id);
    } else {
        std::cerr << "Unknown role: " << role << "\n";
        return 1;
    }
    return 0;
}

// ====================================================================
// TRADEOFF SUMMARY
// ====================================================================
// FUTEX vs SPINLOCK vs SEMAPHORE in shared memory:
//
// | Mechanism   | Fast path (no contention) | Slow path   | Notes                     |
// |-------------|---------------------------|-------------|---------------------------|
// | Futex       | ~10 ns (atomic CAS)       | ~200 ns     | Best perf/CPU trade-off   |
// | Spinlock    | ~10 ns (atomic CAS)       | burns CPU   | Highest latency variance  |
// | Semaphore   | ~80 ns                    | ~250 ns     | Kernel transition each op |
// | Pthread mutex| ~25 ns                  | ~300 ns     | Heavy, avoid in hot path  |
//
// For a pure busy-spin design (no kernel sleep), remove the futex_wait
// and spin forever: this gives the lowest latency (~20-30 ns) but burns
// a full CPU core per consumer.
// ====================================================================
```
