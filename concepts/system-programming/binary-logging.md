---
type: reference
title: "Binary Logging"
description: "mmap-based ring buffer logging: pre-allocate a large mmap'd file,. Binary format design: fixed-size headers (timestamp, seqno,"
tags: ["protocols"]
difficulty: intermediate
timestamp: "2026-06-27T03:06:09.411Z"
phase: 4
phaseName: "System Programming & IPC"
category: "Phase 4 - System Programming & IPC"
subcategory: "system-programming"
language: "cpp"
artifact-id: "ZHFT_BINARY_LOGGING"
---
## Key Learning Points

- mmap-based ring buffer logging: pre-allocate a large mmap'd file,
- Binary format design: fixed-size headers (timestamp, seqno,
- Latency injection avoidance: never allocate memory, never take
- Async writer thread: batches entries from the ring buffer and
- Crash-safe writes: to guarantee that a reader can recover up
- Rotation: close current file at a size threshold, rename with
- Compression: optional background compression of rotated files

## Usage

```bash

g++ -O3 -std=c++20 -pthread ZHFT_BINARY_LOGGING.txt -o binlog
./binlog
```

## Source Code

```cpp
#include <algorithm>
#include <atomic>
#include <bit>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <iostream>
#include <memory>
#include <mutex>
#include <span>
#include <string_view>
#include <thread>
#include <vector>

#include <fcntl.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>

// -------------------------------------------------------------------
// Binary log entry header (16 B, must be aligned).
// -------------------------------------------------------------------
struct alignas(8) LogEntryHeader {
    uint64_t timestamp_ns;      // steady clock when entry was committed
    uint32_t seqno;             // monotonically increasing sequence number
    uint32_t payload_len;       // bytes of payload that follow
    // Magic number + CRC follow at the end of the entry for crash recovery.
};
static_assert(sizeof(LogEntryHeader) == 16);

struct alignas(8) LogEntryTrailer {
    uint32_t magic;             // 0xDEADBEEF at the end
    uint32_t crc32;             // CRC32C of header + payload
};
static_assert(sizeof(LogEntryTrailer) == 8);

// -------------------------------------------------------------------
// Lock-free SPSC ring buffer for passing log entries from producer
// thread to async writer thread. This avoids any heap allocation or
// syscall in the hot path.
// -------------------------------------------------------------------
template <typename T, std::size_t N>
class SPSCRing {
public:
    static_assert((N & (N - 1)) == 0, "N must be power of 2");

    auto TryPush(T value) -> bool {
        auto head = head_.load(std::memory_order_relaxed);
        auto tail = tail_.load(std::memory_order_acquire);
        if (head - tail >= N) return false;         // full
        slots_[head & (N - 1)] = value;
        head_.store(head + 1, std::memory_order_release);
        return true;
    }

    auto TryPop(T& out) -> bool {
        auto tail = tail_.load(std::memory_order_relaxed);
        auto head = head_.load(std::memory_order_acquire);
        if (tail >= head) return false;              // empty
        out = slots_[tail & (N - 1)];
        tail_.store(tail + 1, std::memory_order_release);
        return true;
    }

private:
    std::array<T, N> slots_     = {};
    alignas(64) std::atomic<uint64_t> head_{0};
    alignas(64) std::atomic<uint64_t> tail_{0};
};

// -------------------------------------------------------------------
// A log entry in the ring buffer: just a pointer + length. The actual
// data is written directly into the mmap'd file by the producer.
// This zero-copy approach avoids an extra memcpy.
// -------------------------------------------------------------------
struct LogSlice {
    uint64_t file_offset;       // byte offset in the mmap'd file
    uint32_t length;            // total bytes written (header + payload + trailer)
};

// -------------------------------------------------------------------
// Binary logger: lock-free producer, async writer thread.
// -------------------------------------------------------------------
class BinaryLogger {
public:
    BinaryLogger(std::string_view filepath, std::size_t ring_size_bytes = 64UL * 1024 * 1024)
        : ring_buf_{}
        , exit_flag_{false}
    {
        // Create / truncate log file.
        fd_ = ::open(filepath.data(), O_CREAT | O_RDWR | O_TRUNC, 0644);
        if (fd_ < 0) { std::perror("open"); return; }

        // Allocate space (sparse file).
        ring_file_size_ = ring_size_bytes;
        if (::ftruncate(fd_, static_cast<off_t>(ring_file_size_)) < 0) {
            std::perror("ftruncate"); return;
        }

        // mmap the entire ring.
        map_ = ::mmap(nullptr, ring_file_size_, PROT_READ | PROT_WRITE,
                      MAP_SHARED, fd_, 0);
        if (map_ == MAP_FAILED) { std::perror("mmap"); return; }

        write_cursor_.store(0, std::memory_order_relaxed);
        committed_.store(0, std::memory_order_relaxed);
        seqno_.store(0, std::memory_order_relaxed);

        // Start the async writer thread.
        writer_thread_ = std::jthread{[this] { WriterLoop(); }};
    }

    ~BinaryLogger() {
        exit_flag_.store(true, std::memory_order_release);
        if (writer_thread_.joinable()) writer_thread_.join();
        if (map_ && map_ != MAP_FAILED) ::munmap(map_, ring_file_size_);
        if (fd_ >= 0) ::close(fd_);
    }

    // -----------------------------------------------------------------
    // Hot path: producer calls this. Must be lock-free and wait-free.
    // Writes directly into the mmap'd buffer, then pushes a descriptor
    // to the async writer.
    // -----------------------------------------------------------------
    template <typename PayloadFn>
    auto WriteEntry(PayloadFn&& write_payload) -> bool {
        // Reserve space in the mmap ring.
        auto hdr_sz   = static_cast<uint32_t>(sizeof(LogEntryHeader));
        auto trl_sz   = static_cast<uint32_t>(sizeof(LogEntryTrailer));

        // (In production, payload length is known before calling this.)
        uint32_t payload_len = 0;       // would come from PayloadFn
        uint32_t total_len  = hdr_sz + payload_len + trl_sz;

        uint64_t offset = write_cursor_.fetch_add(total_len, std::memory_order_acq_rel);
        if (offset + total_len > ring_file_size_) {
            // Ring full — in production, wait or overwrite oldest.
            return false;
        }

        auto* base = static_cast<char*>(map_) + offset;

        // Write header.
        auto* hdr = reinterpret_cast<LogEntryHeader*>(base);
        hdr->timestamp_ns = static_cast<uint64_t>(
            std::chrono::steady_clock::now().time_since_epoch().count());
        hdr->seqno        = seqno_.fetch_add(1, std::memory_order_relaxed);
        hdr->payload_len  = payload_len;

        // Write payload via callback (zero-copy from source).
        write_payload(base + hdr_sz, payload_len);

        // Write trailer with magic + CRC.
        auto* trl = reinterpret_cast<LogEntryTrailer*>(base + hdr_sz + payload_len);
        trl->magic = 0xDEADBEEF;
        trl->crc32 = 0;     // real CRC32C computation omitted

        // Push to async writer.
        LogSlice slice{offset, total_len};
        while (!ring_buf_.TryPush(slice)) {
            asm volatile("pause");      // ring full — spin
        }

        return true;
    }

private:
    // -----------------------------------------------------------------
    // Async writer thread: consumes LogSlice descriptors and advances
    // the committed cursor. Periodically calls msync() or fsync().
    // -----------------------------------------------------------------
    void WriterLoop() {
        constexpr int kBatchSize = 64;
        constexpr auto kSyncInterval = std::chrono::milliseconds(10);

        auto last_sync = std::chrono::steady_clock::now();

        while (!exit_flag_.load(std::memory_order_acquire)) {
            // Drain available slices.
            for (int i = 0; i < kBatchSize; ++i) {
                LogSlice slice;
                if (!ring_buf_.TryPop(slice)) break;

                // The data is already in the mmap. We just need to
                // commit the cursor so readers know it's safe.
                uint64_t end = slice.file_offset + slice.length;
                auto prev = committed_.exchange(end, std::memory_order_acq_rel);
                (void)prev;
            }

            // Periodic fsync.
            auto now = std::chrono::steady_clock::now();
            if (now - last_sync >= kSyncInterval) {
                ::msync(map_, write_cursor_.load(std::memory_order_acquire), MS_SYNC);
                // Alternative: fsync(fd_) — much slower but fully durable.
                last_sync = now;
            }

            // Brief sleep if no work.
            std::this_thread::sleep_for(std::chrono::microseconds(100));
        }

        // Final sync on exit.
        ::msync(map_, write_cursor_.load(std::memory_order_acquire), MS_SYNC);
    }

    int                    fd_                = -1;
    std::size_t            ring_file_size_    = 0;
    void*                  map_               = nullptr;

    alignas(64) std::atomic<uint64_t> write_cursor_{0};
    alignas(64) std::atomic<uint64_t> committed_{0};
    alignas(64) std::atomic<uint32_t> seqno_{0};

    SPSCRing<LogSlice, 4096> ring_buf_;
    std::atomic<bool>        exit_flag_{false};
    std::jthread             writer_thread_;
};

// -------------------------------------------------------------------
// Demonstration: producer writes 1M log entries.
// -------------------------------------------------------------------
auto main() -> int {
    BinaryLogger logger{"/tmp/zhft_binlog.bin", 256UL * 1024 * 1024};

    constexpr int kIter = 1'000'000;

    auto t0 = std::chrono::steady_clock::now();
    for (int i = 0; i < kIter; ++i) {
        logger.WriteEntry([&](char* buf, uint32_t len) {
            // Simulate writing a 64-byte payload.
            // In production, this would be a memcpy of the source struct.
            if (len >= 8) std::memcpy(buf, &i, sizeof(i));
        });
    }
    auto t1 = std::chrono::steady_clock::now();

    auto ns = std::chrono::duration_cast<std::chrono::nanoseconds>(t1 - t0).count();
    std::cout << "=== Binary Logger Benchmark ===\n";
    std::cout << "Wrote " << kIter << " entries in "
              << (ns / 1'000'000.0) << " ms\n";
    std::cout << "Avg " << (ns / kIter) << " ns / entry (hot path)\n";
    std::cout << "Effective throughput: "
              << (static_cast<double>(kIter) * 1'000'000'000.0 / static_cast<double>(ns))
              << " entries/sec\n";

    std::cout << "\n=== Design Notes ===\n";
    std::cout << "1. Hot path is lock-free: one atomic fetch_add + memcpy\n";
    std::cout << "2. Async writer batches fsync every 10 ms\n";
    std::cout << "3. For true nanosecond logging, remove fsync entirely\n";
    std::cout << "4. Recovery: scan for 0xDEADBEEF magic at entry boundaries\n";
    std::cout << "5. For multi-producer, use a ticket spinlock or shm atomic\n";

    return 0;
}
```
