---
type: reference
title: "Tape Reading & Level 2 Data"
description: "Reading the tape (time & sales), print vs quote analysis, large-order iceberg detection, spoofing/layering signal patterns, Level 2 ladder visualization, order flow imbalance in practice, and actionable signals from market microstructure."
tags: ["market-data"]
timestamp: "2026-06-27T03:30:00.000Z"
phase: 9
phaseName: "Order Book & Microstructure"
category: "Order Book"
subcategory: "order-book"
language: "cpp"
artifact-id: "ZHFT_TAPE_READING"
---
## Key Learning Points

- Tape reading (time & sales): every print (execution) reveals aggressor side, size, price, timestamp; sequence of prints reveals momentum, absorption, and exhaustion
- Print vs quote analysis: compare print price against NBBO at time of execution; prints at the near side indicate aggressive buying/selling; prints inside the spread indicate patient liquidity taking
- Iceberg detection: large order hidden behind displayed size; signals: repeated fills at same price level with constant displayed size refresh; count displayed size × number of refresh cycles to estimate total
- Spoofing/layering signals: large orders at distant price levels that cancel before being tested; pattern: new large limit → market moves toward it → cancel before execution; high cancel-to-trade ratio
- Level 2 ladder: best bid/ask depth with cumulative size; key signals: bid size growing without price improvement (support), ask wall breaking (resistance), sudden depth disappearance (fake liquidity)
- Order flow imbalance (OFI): net aggressive volume at each price level; OFI > threshold predicts short-term price movement; used as input to market-making skew
- Actionable patterns: absorption (size eaten without price move = support/resistance), exhaustion (failed breakout after large prints), momentum failure (acceleration then rapid deceleration)

## Usage

```cpp
// Tape analysis: detect aggressive vs passive flow
struct TapePrint {
    uint64_t ts_ns_;
    double price_;
    uint64_t size_;
    Side aggressor_side_; // Buy = initiator bought (crossed spread)
    bool is_passive() const { /* fill at or inside NBBO */ }
};

struct IcebergDetector {
    double price_level_;
    uint64_t displayed_qty_;
    uint64_t estimated_total_ = 0;
    int refresh_count_ = 0;

    void onFill(const TapePrint& p) {
        if (p.price_ == price_level_ && p.size_ == displayed_qty_) {
            refresh_count_++;
            estimated_total_ += p.size_;
            // Iceberg persists: same price, same displayed qty
        }
    }
    bool is_iceberg() const { return refresh_count_ >= 3; }
};

// Order flow imbalance
struct OFI {
    double bid_size_added_, bid_size_cancelled_;
    double ask_size_added_, ask_size_cancelled_;
    double imbalance() const {
        return (bid_size_added_ - bid_size_cancelled_) -
               (ask_size_added_ - ask_size_cancelled_);
    }
};
```

## Source Code

```cpp
// Level 2 visualization data structure
struct L2Ladder {
    struct Level {
        double price_;
        uint64_t bid_qty_;
        uint64_t ask_qty_;
        int bid_order_count_;
        int ask_order_count_;
    };
    std::array<Level, 10> levels_; // 10 deep each side

    // Support: cumulative bid size, Resistance: cumulative ask size
    double support(size_t depth) const {
        double total = 0;
        for (size_t i = 0; i < depth; ++i) total += levels_[i].bid_qty_;
        return total;
    }
    double resistance(size_t depth) const {
        double total = 0;
        for (size_t i = 0; i < depth; ++i) total += levels_[i].ask_qty_;
        return total;
    }
};
```
