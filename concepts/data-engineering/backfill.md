---
type: reference
title: "Backfill"
description: "Gap detection: scan sequence numbers for missing intervals. Multi-source reconciliation: compare timestamps + prices across vendors"
tags: ["phase-12"]
timestamp: "2026-06-27T03:06:09.443Z"
phase: 12
phaseName: "Data Engineering"
category: "Phase 12 - Data Engineering"
subcategory: "data-engineering"
language: "cpp"
artifact-id: "ZHFT_BACKFILL"
---
## Key Learning Points

- Gap detection: scan sequence numbers for missing intervals
- Multi-source reconciliation: compare timestamps + prices across vendors
- Out-of-order handling: buffer, sort, or drop late arrivals
- Data integrity: checksums on blocks, cross-source comparison
- Repair strategies: interpolation, vendor re-request, fill from alternative

## Usage

BackfillOrchestrator bf(data_store, vendor_api);
bf.detectGaps("2024-06-01", "2024-06-30");
auto gaps = bf.gaps();
for (auto& g : gaps) bf.fill(g);

## Source Code

```cpp
#include <vector>
#include <cstdint>
#include <unordered_map>
#include <algorithm>

// --------------------------------------------------------------------
// Gap Detection

class GapDetector {
    std::vector<uint64_t> seq_numbers_;

public:
    void addSeq(uint64_t seq) {
        seq_numbers_.push_back(seq);
    }

    // Detect gaps — assumes sorted input
    std::vector<std::pair<uint64_t, uint64_t>> detect() {
        std::vector<std::pair<uint64_t, uint64_t>> gaps;
        std::sort(seq_numbers_.begin(), seq_numbers_.end());
        for (size_t i = 1; i < seq_numbers_.size(); ++i) {
            uint64_t diff = seq_numbers_[i] - seq_numbers_[i-1];
            if (diff > 1) {
                // tradeoff: small gaps (<5) can be interpolated, large need refetch
                gaps.emplace_back(seq_numbers_[i-1] + 1, seq_numbers_[i] - 1);
            }
        }
        return gaps;
    }
};

// --------------------------------------------------------------------
// Multi-Source Reconciliation

struct TickRecord {
    uint64_t ts_ns;
    double bid, ask, last;
    uint32_t bsz, asz, lsz;
};

class ReconciliationEngine {
    std::vector<TickRecord> source_a_;
    std::vector<TickRecord> source_b_;
    double tolerance_bps_{1.0};  // 1bp tolerance for price mismatch

public:
    struct Mismatch {
        uint64_t ts_ns;
        double bid_a, bid_b;
        double diff_bps;
        enum { PRICE_MISMATCH, MISSING_IN_A, MISSING_IN_B } type;
    };

    // Merge and diff two sources by timestamp
    std::vector<Mismatch> reconcile() {
        std::vector<Mismatch> issues;
        size_t i = 0, j = 0;
        while (i < source_a_.size() && j < source_b_.size()) {
            if (std::abs(static_cast<int64_t>(source_a_[i].ts_ns
                         - source_b_[j].ts_ns)) < 1000000) {  // 1ms window
                // Same tick — compare prices
                double diff = std::abs(source_a_[i].bid - source_b_[j].bid)
                            / source_a_[i].bid * 10000;
                if (diff > tolerance_bps_) {
                    issues.push_back({source_a_[i].ts_ns,
                        source_a_[i].bid, source_b_[j].bid,
                        diff, Mismatch::PRICE_MISMATCH});
                }
                ++i; ++j;
            } else if (source_a_[i].ts_ns < source_b_[j].ts_ns) {
                issues.push_back({source_a_[i].ts_ns, 0, 0, 0,
                                  Mismatch::MISSING_IN_B});
                ++i;
            } else {
                issues.push_back({source_b_[j].ts_ns, 0, 0, 0,
                                  Mismatch::MISSING_IN_A});
                ++j;
            }
        }
        return issues;
    }

    // Data integrity: block-level checksums
    static uint64_t blockChecksum(const std::vector<uint8_t>& block) {
        // tradeoff: CRC32 (fast, HW-accel) vs SHA256 (crypto-grade)
        // HFT: CRC32C is sufficient and SIMD-accelerated
        uint64_t hash = 0xFFFFFFFF;
        for (size_t i = 0; i < block.size(); ++i) {
            hash ^= block[i];
            for (int b = 0; b < 8; ++b)
                hash = (hash >> 1) ^ (0xEDB88320 & -(hash & 1));
        }
        return hash ^ 0xFFFFFFFF;
    }

    // Out-of-order handling
    std::vector<TickRecord> sortOutOfOrder(std::vector<TickRecord>& ticks) {
        // tradeoff: sort all vs sliding window (incremental sort)
        std::stable_sort(ticks.begin(), ticks.end(),
              [](auto& a, auto& b) { return a.ts_ns < b.ts_ns; });
        return ticks;
    }

    // Repair: linear interpolation for small gaps
    // tradeoff: linear vs cubic spline vs copy-last
    TickRecord interpolate(const TickRecord& prev, const TickRecord& next,
                           uint64_t target_ts) {
        double t = static_cast<double>(target_ts - prev.ts_ns)
                 / (next.ts_ns - prev.ts_ns);
        return {target_ts,
                prev.bid + t * (next.bid - prev.bid),
                prev.ask + t * (next.ask - prev.ask),
                prev.last + t * (next.last - prev.last),
                0, 0, 0};
    }
};
```
