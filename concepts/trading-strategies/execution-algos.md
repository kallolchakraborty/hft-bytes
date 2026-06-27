---
type: reference
title: "Execution Algorithms"
description: "TWAP slice scheduling, VWAP historical volume distribution, POV adaptive participation, Implementation Shortfall with Urgency, SOR routing logic with venue weighting, and fill-probability models."
tags: ["trading"]
difficulty: staff
timestamp: "2026-06-27T03:30:00.000Z"
phase: 10
phaseName: "Trading Strategies"
category: "Trading Strategies"
subcategory: "trading-strategies"
language: "cpp"
artifact-id: "ZHFT_EXECUTION_ALGOS"
---
## Key Learning Points

- **TWAP (Time-Weighted Average Price)**: slice order into equal-size child orders at fixed intervals; simple but ignores volume profile; good for small orders relative to ADV. The hidden assumption: volume is evenly distributed throughout the day — it's not. TWAP underperforms when volume is concentrated at open/close. For HFT: TWAP's simplicity is its strength (no historical data dependency), but the uniform slicing creates predictable patterns that predatory algos can detect. Add random jitter (±10% of interval) to reduce detectability. Fill quality: typically 5-15 bps worse than VWAP for large orders because it doesn't adapt to volume surges
- **VWAP (Volume-Weighted Average Price)**: slice proportional to historical volume distribution (e.g., 5-min buckets); requires reliable intraday volume profile; execution quality measured as VWAP slippage. The profile is typically 20-day average volume by 5-minute bucket. Critical failure mode: volume spikes (FOMC, earnings, index rebalance) make the historical profile obsolete mid-trade. For HFT: VWAP participation rate should be capped at 10-15% of observed volume per bucket — exceeding this moves the market and degrades fill quality. The tradeoff: more aggressive participation = faster completion but higher market impact. VWAP slippage = (your_avg_price - benchmark_vwap) / benchmark_vwap — target < 5 bps for liquid names
- **POV (Percentage of Volume)**: adapt child-order size to maintain constant participation rate of observed volume; auto-slows in low-volume periods, speeds up in high-volume. POV is reactive rather than predictive — it adapts to what the market is doing now, not what it did historically. The participation rate is the key parameter: 5-10% is passive (low market impact), 15-25% is aggressive (high impact, faster completion). For HFT: POV's weakness is that in low-volume periods, the algorithm pauses entirely — if you need execution by a deadline, combine POV with a TWAP floor (minimum slice size). POV's strength: it naturally slows during adverse conditions (thin markets = bad fills)
- **Implementation Shortfall (IS) with Urgency**: Almgren-Chriss optimal trajectory given urgency parameter η; high urgency = front-load execution (more impact, less timing risk); low urgency = stretch out. The Almgren-Chriss model decomposes IS into two components: (a) execution cost (market impact from your orders), and (b) timing risk (adverse price movement while you wait). The urgency parameter η controls the tradeoff: η → ∞ means execute everything now (zero timing risk, maximum impact); η → 0 means execute infinitely slowly (minimum impact, maximum timing risk). For HFT: calibrate η based on signal decay rate — if your alpha signal has a half-life of 2 minutes, urgency must be high. If half-life is 30 minutes, patience is rewarded
- **SOR (Smart Order Routing)**: for multi-venue stocks, route to venue with highest fill probability given current L2 state; update POV per-venue based on fill-rate history. SOR is not just "route to the cheapest venue" — it's a multi-objective optimization: (a) fill probability, (b) adverse selection probability, (c) latency, (d) rebates/fees. For HFT: the fill-probability model is the most important component. Use a logistic regression on L2 features (spread, depth at best, queue position, order size relative to depth), calibrated per-venue per-symbol daily. Venue weight decays with latency — a venue 50μs slower needs 5% higher fill probability to justify routing there
- **Fill-probability model**: logistic regression on L2 features (spread, depth at best, queue position, order size relative to depth); calibrated per venue per symbol. The model predicts P(fill | order reaches venue). Features matter: depth at best explains 40% of variance, queue position explains 25%, spread explains 20%. For HFT: recalibrate daily — market microstructure changes (new market makers, changed fee schedules, regulatory events). The model degrades gracefully: even a week-old model is better than no model. A/B test model versions by routing 10% of orders through the new model and comparing fill rates and adverse selection

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
