---
type: reference
title: "Transaction Cost Analysis (TCA)"
description: "Implementation shortfall decomposition, VWAP/TWAP benchmarks, Almgren-Chriss market impact model, timing vs liquidity cost separation, post-trade analytics pipeline, and TCA dashboard metrics."
tags: ["trading"]
difficulty: staff
timestamp: "2026-06-27T03:30:00.000Z"
phase: 10
phaseName: "Trading Strategies"
category: "Trading Strategies"
subcategory: "trading-strategies"
language: "cpp"
artifact-id: "ZHFT_TCA"
---
## Key Learning Points

- Implementation shortfall (IS): difference between execution price and decision price at time of trading decision; decomposed into fixed cost (commissions/fees) + market impact + timing risk + opportunity cost
- Almgren-Chriss model: total cost = permanent impact (information leakage) + temporary impact (liquidity demand) + timing cost (price drift); parameters calibrated per symbol from historical fills
- Market impact: square-root model: `impact ∝ σ * √(Q / ADV) * sign(Q)` where Q = order size, ADV = average daily volume, σ = volatility
- VWAP benchmark: compare fill-price to volume-weighted average price over execution window; TWAP equivalent for time-weighted slicing
- Timing cost: price change between decision and first fill; split into predictable (drift) and unpredictable (noise); noise component contributes to TCA variance
- TCA pipeline: order capture → fill enrichment (exchange fee, rebate) → benchmark computation → impact decomposition → aggregation by strategy/symbol/trader
- Key metrics: IS bps, VWAP slippage bps, fill rate, adverse selection rate (fills that move against after execution)

## Usage

```cpp
// Implementation shortfall calculation
struct TCAReport {
    double decision_price_;      // mid/bid/ask at order-decision time
    double avg_execution_price_; // quantity-weighted average fill price
    double side_;                // +1 buy, -1 sell
    double fixed_cost_;          // commissions + exchange fees
    double market_impact_;       // Almgren-Chriss model estimate
    double timing_cost_;         // price drift from decision to first fill

    double shortfall() const {
        return side_ * (avg_execution_price_ - decision_price_) / decision_price_;
    }

    double shortfall_bps() const { return shortfall() * 10'000; }

    void decompose() {
        // Impact = signed price change attributable to order
        // Timing = residual after removing impact estimate
        // Fixed = known from fee schedule
        double total = shortfall_bps();
        double fixed_bps = fixed_cost_ / decision_price_ * 10'000;
        double impact_bps = market_impact_bps();
        double timing_bps = total - fixed_bps - impact_bps;
        // Log: "IS=2.3bps (fixed=0.3, impact=1.2, timing=0.8)"
    }
};
```

## Source Code

```cpp
// Almgren-Chriss market impact estimate
// I(Q) = a * σ * (Q / V)^0.5 * sign(Q)
// a = calibration constant (~0.1 for US equities)
// σ = daily volatility
// Q = order size (shares)
// V = average daily volume (shares)

// TCA dashboard metrics (per strategy)
// ┌──────────────┬────────┬────────┬────────┐
// │ Metric       │ Today  │ MTD    │ Target │
// ├──────────────┼────────┼────────┼────────┤
// │ IS (bps)     │ 1.8    │ 2.1    │ < 3.0  │
// │ Fill Rate    │ 94%    │ 93%    │ > 90%  │
// │ Adv. Sel.    │ 12%    │ 14%    │ < 15%  │
// └──────────────┴────────┴────────┴────────┘
```
