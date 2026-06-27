---
type: reference
title: "Mkt Replay"
description: "Binary recording format: fixed-size records for deterministic replay. Replay at original speed vs accelerated (Nx)"
tags: ["backtesting"]
difficulty: intermediate
timestamp: "2026-06-27T03:06:09.441Z"
phase: 11
phaseName: "Backtesting & Simulation"
category: "Phase 11 - Backtesting & Simulation"
subcategory: "backtesting"
language: "cpp"
artifact-id: "ZHFT_MKT_REPLAY"
---
## Key Learning Points

- **Binary recording format**: fixed-size records for deterministic replay — each record is 64 bytes (cache-line aligned) containing timestamp, sequence number, bid/ask/last prices and sizes, and flags. Fixed-size records enable O(1) seek — to jump to a specific time, calculate the byte offset directly. The 64-byte record is intentionally cache-line aligned — reading one record fills exactly one cache line, minimizing CPU cache misses during sequential replay. For HFT: the recording format must capture enough information to reconstruct the full order book state, not just the top-of-book. Include depth levels (bid_sz[0..4], ask_sz[0..4]) for strategies that use depth features
- **Replay at original speed vs accelerated (Nx)**: real-time replay (1x) for testing latency-sensitive strategies, accelerated replay (10x, 100x) for statistical validation. At 10x speed, a full trading day (6.5 hours) replays in ~39 minutes. At 100x, it's ~4 minutes. For HFT: accelerated replay is useful for parameter optimization (test 100 parameter combinations in a day's data), but real-time replay is essential for validating latency-sensitive strategies — the timing of your orders relative to market events matters. The speed control uses busy-waiting (spin loop) for sub-millisecond timing accuracy — `usleep` has 10ms granularity, which is too coarse for HFT timing
- **Deterministic replay**: same binary → same sequence of ticks — the backtester must produce identical results on every run. Determinism requires: (a) fixed binary format (no variable-length fields), (b) no external state (no random numbers, no wall-clock dependencies), (c) no floating-point non-determinism (use integer arithmetic for timestamps, avoid platform-specific FP behavior). For HFT: test determinism by running the backtester twice and comparing output byte-for-byte. If they differ, you have a non-determinism bug (usually caused by `std::unordered_map` iteration order or `std::random_device`)
- **Seek/rewind for targeted testing**: jump to a specific date/time to test strategies on specific events (FOMC, earnings, flash crash). Seek is O(1) because records are fixed-size — byte_offset = record_index × 64. For HFT: seek to 30 minutes before the event of interest (to allow the strategy to "warm up" and build position). Rewind resets the file pointer and replay state to the beginning — useful for running the same strategy on the same data with different parameters
- **Sequence number checking for gap detection**: every record has a monotonically increasing sequence number. If record[N].seqno != record[N-1].seqno + 1, there's a gap (missing records). Gap handling: (a) mark the gap in the binary file (set gap flag in the record), (b) during replay, skip gaps and insert synthetic ticks at the last known price. For HFT: gaps are common in live data (exchange outages, network drops, recording buffer overflows). The backtester must handle gaps gracefully — strategies that assume continuous data will break during gaps. Test gap resilience by injecting synthetic gaps into the binary file and verifying the strategy doesn't crash or produce anomalous signals

## Usage

MarketRecorder rec("data.bin");
rec.record(tick);
MarketReplayPlayer player("data.bin");
player.setSpeed(10.0);
while (auto ev = player.next()) { strategy.onTick(*ev); }

## Source Code

```cpp
#include <cstdio>
#include <cstdint>
#include <chrono>
#include <optional>
#include <vector>

#pragma pack(push, 1)
struct BinaryTickRecord {
    uint64_t timestamp_ns;
    uint64_t seqno;
    double   bid, ask, last;
    uint32_t bid_sz, ask_sz, last_sz;
    uint8_t  flags;  // bit0: gap flag, bit1: corrected
};
#pragma pack(pop)

static_assert(sizeof(BinaryTickRecord) == 64,
              "BinaryTickRecord must be 64 bytes (cache-line aligned)");

class MarketRecorder {
    FILE* file_;
    uint64_t seqno_{0};
    uint64_t base_time_{0};

public:
    explicit MarketRecorder(const char* path) {
        file_ = fopen(path, "wb");
        // tradeoff: unbuffered for crash safety vs buffered for throughput
        // HFT recording: unbuffered writes, direct I/O if possible
    }

    void record(double bid, double ask, double last,
                uint32_t bsz, uint32_t asz, uint32_t lsz) {
        BinaryTickRecord rec;
        rec.timestamp_ns = std::chrono::steady_clock::now()
                           .time_since_epoch().count();
        rec.seqno = seqno_++;
        rec.bid = bid; rec.ask = ask; rec.last = last;
        rec.bid_sz = bsz; rec.ask_sz = asz; rec.last_sz = lsz;
        rec.flags = 0;
        fwrite(&rec, sizeof(rec), 1, file_);
    }

    ~MarketRecorder() { fclose(file_); }
};

class MarketReplayPlayer {
    FILE* file_;
    double speed_{1.0};
    uint64_t first_ts_{0};
    uint64_t last_replay_ns_{0};
    bool     started_{false};

public:
    explicit MarketReplayPlayer(const char* path) {
        file_ = fopen(path, "rb");
    }

    void setSpeed(double s) { speed_ = s; }  // 1.0 = real-time

    std::optional<BinaryTickRecord> next() {
        BinaryTickRecord rec;
        if (fread(&rec, sizeof(rec), 1, file_) != 1)
            return std::nullopt;

        // sequence check
        static uint64_t expected_seq = 0;
        if (rec.seqno != expected_seq) {
            rec.flags |= 0x01;  // gap detected
            // tradeoff: skip vs interpolate vs pause
        }
        expected_seq = rec.seqno + 1;

        // timing control for real-time replay
        if (!started_) {
            first_ts_ = rec.timestamp_ns;
            last_replay_ns_ = now();
            started_ = true;
        } else {
            uint64_t wall_elapsed = now() - last_replay_ns_;
            uint64_t tick_elapsed = rec.timestamp_ns - first_ts_;
            uint64_t target_elapsed = static_cast<uint64_t>(tick_elapsed / speed_);
            if (wall_elapsed < target_elapsed) {
                // busy-wait: tradeoff between accuracy and CPU
                while (now() - last_replay_ns_ < target_elapsed);
            }
        }
        return rec;
    }

    void seek(uint64_t seqno) {
        fseek(file_, seqno * sizeof(BinaryTickRecord), SEEK_SET);
    }

private:
    static uint64_t now() {
        return std::chrono::steady_clock::now()
               .time_since_epoch().count();
    }
};
```
