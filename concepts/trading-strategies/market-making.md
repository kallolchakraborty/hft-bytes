---
type: reference
title: "Market Making"
description: "Spread capture by simultaneously bidding at bid and offering at ask. Dynamic spread widening based on volatility (σ * multiplier)"
tags: ["order-types", "trading"]
difficulty: advanced
timestamp: "2026-06-27T03:06:09.437Z"
phase: 10
phaseName: "Trading Strategies"
category: "Phase 10 - Trading Strategies"
subcategory: "trading-strategies"
language: "cpp"
artifact-id: "ZHFT_MARKET_MAKING"
---
## Key Learning Points

- Spread capture by simultaneously bidding at bid and offering at ask
- Dynamic spread widening based on volatility (σ * multiplier)
- Inventory skew: shift quotes to encourage mean-reverting flow
- Gamma scalping in options: delta-hedge against adverse gamma
- Adverse selection avoidance via last-trade cancellation logic

```html
<div class="ad-wrapper">
  <div class="ad-title">Market Making Decision Loop</div>
  <div class="ad-flow">
    <div class="ad-stage active"><span class="ad-stage-icon">📡</span><span class="ad-stage-label">Market Data</span></div>
    <div class="ad-arrow"><span class="material-symbols-outlined">chevron_right</span><span class="ad-packet"></span></div>
    <div class="ad-stage"><span class="ad-stage-icon">🧮</span><span class="ad-stage-label">Pricing Model</span></div>
    <div class="ad-arrow"><span class="material-symbols-outlined">chevron_right</span><span class="ad-packet"></span></div>
    <div class="ad-stage"><span class="ad-stage-icon">🛡️</span><span class="ad-stage-label">Risk Check</span></div>
    <div class="ad-arrow"><span class="material-symbols-outlined">chevron_right</span><span class="ad-packet"></span></div>
    <div class="ad-stage"><span class="ad-stage-icon">📨</span><span class="ad-stage-label">Send Order</span></div>
    <div class="ad-arrow"><span class="material-symbols-outlined">chevron_right</span><span class="ad-packet"></span></div>
    <div class="ad-stage"><span class="ad-stage-icon">✅</span><span class="ad-stage-label">Fill / Cancel</span></div>
  </div>
  <div class="ad-legend">
    <span class="ad-legend-item"><span class="ad-legend-swatch packet"></span>Data packet flow</span>
  </div>
</div>
```

## Usage

MarketMakingEngine engine(exchange, risk_manager);
engine.setParams(/* baseSpread= */ 0.001, /* skewFactor= */ 0.5);

## Source Code

```cpp
*   while (running) { auto tick = exchange.nextTick(); engine.onTick(tick); }
 *
 * PERFORMANCE TARGET:
 *   quote-to-quote latency < 1 μs; spread capture ratio > 40%
 * ====================================================================
 */

#include <cstdint>
#include <cmath>
#include <deque>
#include <span>

struct Quote {
    uint64_t id;
    double    bid_price, ask_price;
    uint32_t  bid_qty, ask_qty;
    uint64_t  timestamp_ns;
};

struct MarketTick {
    double  bid, ask, last;
    uint32_t bid_sz, ask_sz, last_sz;
    uint64_t ts;
};

class MarketMakingEngine {
    double  base_spread_;     // fraction of mid-price
    double  skew_factor_;     // [0,1] — how aggressively to skew
    double  max_position_;    // max inventory notional
    double  position_;        // current inventory (+ long, - short)
    double  target_zones_;    // neutral zone half-width
    int     aging_interval_;  // unwinds stale quotes after N ticks

    // rolling vol estimator (20-tick EWMA)
    double  vol_estimate_{1e-4};
    double  vol_decay_{0.95};

    std::deque<Quote> active_quotes_;

public:
    MarketMakingEngine(double base_spread, double skew_factor)
        : base_spread_(base_spread), skew_factor_(skew_factor)
        , max_position_(1000000.0), position_(0.0), target_zones_(0.02) {}

    void onTick(const MarketTick& tick) {
        updateVolatility(tick);

        double mid   = (tick.bid + tick.ask) * 0.5;
        double half  = base_spread_ * vol_estimate_ * mid * 0.5;

        // inventory skew: shift mid by -position * skew_factor
        double skew_offset = -position_ * skew_factor_ * mid * 0.0001;

        double bid_px = mid + skew_offset - half;
        double ask_px = mid + skew_offset + half;

        // cancel stale quotes, replace with new
        cancelAll();
        sendQuote(bid_px, tick.bid_sz, ask_px, tick.ask_sz);

        // gamma scalping check (if options delta present)
        checkGammaHedge(tick);
    }

private:
    void updateVolatility(const MarketTick& tick) {
        double ret = std::log(tick.last / (tick.ask + tick.bid) * 2.0 + 1e-12);
        // EWMA vol — tradeoff: lower alpha = smoother but slower to adapt
        vol_estimate_ = std::sqrt(vol_decay_ * vol_estimate_ * vol_estimate_
                                 + (1.0 - vol_decay_) * ret * ret);
    }

    void cancelAll() { /* batch cancel via exchange API */ }
    void sendQuote(double bid, uint32_t bsz, double ask, uint32_t asz) { /* send */ }
    void checkGammaHedge(const MarketTick&) { /* delta-hedge logic */ }
};
```
