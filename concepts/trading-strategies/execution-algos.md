---
type: reference
title: "Execution Algorithms"
description: "TWAP slice scheduling, VWAP historical volume distribution, POV adaptive participation, Implementation Shortfall with Urgency, SOR routing logic with venue weighting, and fill-probability models."
tags: ["trading"]
timestamp: "2026-06-27T03:30:00.000Z"
phase: 10
phaseName: "Trading Strategies"
category: "Trading Strategies"
subcategory: "trading-strategies"
language: "cpp"
artifact-id: "ZHFT_EXECUTION_ALGOS"
---
## Key Learning Points

- TWAP (Time-Weighted Average Price): slice order into equal-size child orders at fixed intervals; simple but ignores volume profile; good for small orders relative to ADV
- VWAP (Volume-Weighted Average Price): slice proportional to historical volume distribution (e.g., 5-min buckets); requires reliable intraday volume profile; execution quality measured as VWAP slippage
- POV (Percentage of Volume): adapt child-order size to maintain constant participation rate of observed volume; auto-slows in low-volume periods, speeds up in high-volume
- Implementation Shortfall (IS) with Urgency: Almgren-Chriss optimal trajectory given urgency parameter η; high urgency = front-load execution (more impact, less timing risk); low urgency = stretch out
- SOR routing: for multi-venue stocks, route to venue with highest fill probability given current L2 state; update POV per-venue based on fill-rate history
- Fill-probability model: logistic regression on L2 features (spread, depth at best, queue position, order size relative to depth); calibrated per venue per symbol

## Usage

```cpp
// TWAP slice schedule
struct TWAP {
    uint64_t total_qty_;
    uint64_t slices_;
    uint64_t interval_ms_;    // e.g., 1000 (1 sec between slices)
    uint64_t slice_qty_ = total_qty_ / slices_;

    std::vector<ChildOrder> generate() {
        std::vector<ChildOrder> orders;
        for (uint64_t i = 0; i < slices_; ++i) {
            orders.push_back({
                qty: slice_qty_,
                expire_after: interval_ms_
            });
        }
        return orders;
    }
};

// VWAP with historical volume profile
struct VWAP {
    static constexpr size_t BUCKETS = 78;  // 78 * 5min = 390min session
    std::array<double, BUCKETS> volume_profile_; // sum to 1.0

    std::vector<ChildOrder> slice(uint64_t total_qty) {
        std::vector<ChildOrder> out;
        for (size_t i = 0; i < BUCKETS; ++i) {
            out.push_back({
                qty: static_cast<uint64_t>(total_qty * volume_profile_[i])
            });
        }
        return out;
    }
};

// SOR venue selection
struct SOR {
    struct VenueStats {
        double fill_prob_;  // P(fill | order_size, L2 state)
        double adv_sel_prob_; // P(adverse fill | fills)
        double latency_us_;
    };

    int selectVenue(const Order& order, const std::vector<VenueStats>& venues) {
        // Score each venue by fill_prob / (1 + adv_sel_prob) * latency_factor
        int best = 0;
        double best_score = 0;
        for (size_t i = 0; i < venues.size(); ++i) {
            double s = venues[i].fill_prob_ / (1 + venues[i].adv_sel_prob_);
            s /= (1 + venues[i].latency_us_ / 1000.0);
            if (s > best_score) { best_score = s; best = i; }
        }
        return best;
    }
};
```

## Source Code

```cpp
// Almgren-Chriss optimal trading trajectory
// x(t) = X * sinh(η(T-t)) / sinh(ηT)
// where X = total shares, T = total time, η = urgency parameter
// High η: fast front-loading (high impact, low timing risk)
// Low η: near-linear (low impact, high timing risk)

// Urgency calibration:
// η = 0.1 → very patient (e.g., 90% of volume)
// η = 1.0 → normal (e.g., 20% of volume)
// η = 10 → urgent (e.g., 50% of volume, aggressive)
```
