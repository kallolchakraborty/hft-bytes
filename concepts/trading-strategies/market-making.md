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

- **Spread capture**: simultaneously bidding at bid and offering at ask — profit = bid-ask spread minus adverse selection cost minus exchange fees. The theoretical edge: you earn the spread on every round-trip (buy at bid, sell at ask). The practical problem: adverse selection — informed traders hit your bid when the price is about to drop, and lift your ask when the price is about to rise. Your PnL = spread_income - adverse_selection - fees. For HFT: target spread capture > 40% of theoretical maximum. If capture < 30%, your quotes are being adversely selected too often — widen quotes or reduce participation
- **Dynamic spread widening**: spread = base_spread × σ × multiplier. Widen during high volatility (σ increases), narrow during calm markets. The multiplier is the key tuning parameter: too high = you stop quoting during volatility (when edge is highest), too low = you get picked off during volatility (when adverse selection is worst). For HFT: use an EWMA volatility estimator (20-tick window, α=0.95) rather than a simple moving average — EWMA adapts faster to regime changes. The spread should also widen when your inventory is large (inventory risk premium)
- **Inventory skew**: shift quotes to encourage mean-reverting flow — if you're long, lower both bid and ask to attract sellers; if short, raise both to attract buyers. The skew formula: skew_offset = -position × skew_factor × mid × 0.0001. Skew factor controls how aggressively you unwind: 0.0 = no skew (pure market making), 1.0 = maximum skew (aggressive inventory management). For HFT: the skew should be proportional to your inventory risk limit. If max_position = 1M and current position = 500K, skew = 0.5 × base_skew. Never let inventory accumulate beyond your risk limit — the cost of unwinding a large position in a thin market exceeds the spread income from building it
- **Gamma scalping in options**: delta-hedge against adverse gamma exposure. Gamma = rate of change of delta with respect to price. If you're long gamma (long options), you profit from large moves (delta increases as price rises, decreases as price falls). If you're short gamma (short options), you lose from large moves. Gamma scalping: rebalance delta hedge after each significant price move. The tradeoff: gamma scalping earns money from volatility (rebalancing profits) but costs money in theta (time decay). For HFT: gamma scalping is profitable when realized vol > implied vol. Monitor the gamma/theta ratio — if gamma profits < theta costs, close the position
- **Adverse selection avoidance**: cancel quotes when adverse selection is detected — last-trade cancellation logic detects when your quotes are being picked off by informed flow. Detection: if your bid is filled and the price drops within N milliseconds, or your ask is filled and the price rises within N milliseconds, that's adverse selection. Response: widen quotes or pause quoting for M milliseconds. For HFT: the detection window N is critical — too short = false positives (normal price movement), too long = you miss real adverse selection. Start with N=50ms, M=100ms, and tune based on adverse selection rate. Target: < 5% of fills are adversely selected

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
/*
 *   while (running) { auto tick = exchange.nextTick(); engine.onTick(tick); }

 */
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
