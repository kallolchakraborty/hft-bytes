---
type: reference
title: "Mkt Replay"
description: "Binary recording format: fixed-size records for deterministic replay. Replay at original speed vs accelerated (Nx)"
tags: ["backtesting"]
timestamp: "2026-06-27T03:06:09.441Z"
phase: 11
phaseName: "Backtesting & Simulation"
category: "Phase 11 - Backtesting & Simulation"
subcategory: "backtesting"
language: "cpp"
artifact-id: "ZHFT_MKT_REPLAY"
---
## Key Learning Points

- Binary recording format: fixed-size records for deterministic replay
- Replay at original speed vs accelerated (Nx)
- Deterministic replay: same binary → same sequence of ticks
- Seek/rewind for targeted testing
- Sequence number checking for gap detection

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
