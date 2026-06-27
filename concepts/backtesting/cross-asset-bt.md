---
type: reference
title: "Cross-Asset Backtesting"
description: "Production-grade multi-asset backtester architecture: event loop design, execution simulation (queue position, partial fills, latency-aware matching), look-ahead bias prevention, survivorship bias, trading costs, overfitting prevention, and the backtest-to-live gap."
tags: ["backtesting", "simulation", "execution", "risk"]
difficulty: staff
timestamp: "2026-06-27T23:30:00.000Z"
phase: 11
phaseName: "Backtesting & Simulation"
category: "Backtesting"
subcategory: "backtesting"
language: "cpp"
artifact-id: "ZHFT_CROSS_ASSET_BT"
---

## Key Learning Points

### Backtester Event Loop Architecture
- The core of any backtester is the **event loop**: advance time to the next event (market data tick, order fill, scheduled task), deliver the event to the strategy, allow the strategy to respond with orders, simulate exchange processing of those orders, deliver fills/rejects back to the strategy. The event loop must be **deterministic** — the same input data + same strategy code + same seed must produce the same output every time. Implementation pattern: a priority queue of events ordered by timestamp. The main loop pops the next event, advances the simulated clock, dispatches to the strategy. After the strategy processes the event, any new orders it submitted are processed against the simulated exchange state (order books, latency)
- **Time management**: the simulated clock advances discretely from event to event (not in continuous real-time). Between events, no processing occurs. The clock must be monotonic and never go backward. For sub-microsecond precision (HFT backtesting), use nanosecond timestamps. Handle same-timestamp events: if two events have the same timestamp (e.g., trade and quote simultaneously), define an ordering rule (process quotes before trades, or randomize with a fixed seed). Record the ordering decision so it's reproducible
- **Latency-aware event scheduling**: in real HFT, market data and order fills arrive with network latency. The backtester must model: (a) market data transmission latency from exchange to strategy; (b) order transmission latency from strategy to exchange; (c) matching engine processing latency. A common approach: when the strategy submits an order, schedule the fill event at `current_time + network_rtt + matching_latency`. For a venue 500km away at fiber speed (~5µs/km), RTT = ~5ms. Schedule the fill 5ms + matching_engine_latency (20µs) in the future. This prevents unrealistic "instant fill" backtests
- **Multi-asset event ordering**: when backtesting equities + futures + FX, events from different venues arrive at different times. The event loop must interleave events correctly: an equity trade at 10:00:00.001000 and a futures trade at 10:00:00.001500 are ordered by their simulated arrival time, not the exchange's timestamp. The strategy must see them in the same order they would arrive in production

### Execution Simulation
- **Queue position simulation**: limit orders do not fill instantly — they join a queue at the price level. The queue advances as other orders ahead are filled or cancelled. Simulating this is critical for market-making backtests. Approaches: (a) **full order book simulation** — maintain the full LOB per instrument, process every add/cancel/execute event, track each order's position in the queue. Most accurate but computationally expensive (10M+ events per day). (b) **probabilistic fill** — assign a fill probability based on historical fill rate, queue depth, and order size. Less accurate but 100x faster. (c) **hybrid** — use full book for highly liquid symbols (fills matter for PnL), probabilistic for illiquid ones. Target: full book for all instruments in the strategy's universe
- **Partial fills**: a large limit order may be partially filled by multiple incoming market orders. The backtester must: (a) match each incoming market order against the order book; (b) if the market order exhausts the first limit order, continue to the next price level; (c) report partial fills to the strategy as separate fill events. The strategy must handle partial fills (update position, adjust quotes accordingly)
- **Market impact**: large orders move the market. Models: (a) **Almgren-Chriss** — price impact = permanent (information leakage) + temporary (liquidity demand); (b) **linear impact** — cost = a × order_size × volatility; (c) **empirical impact** — historical distribution of price moves following trades of a given size. For HFT strategies (small order size, high frequency), market impact is negligible — skip it. For execution algos or large parent orders, always include it
- **Latency-dependent fill**: the fill probability of a limit order depends on how fast your order reaches the exchange relative to other market participants. If your simulated order takes 5ms to arrive and a competing order takes 4ms, the competitor gets priority. Model this: (a) assign each order a "submission time" (current simulated time + network latency); (b) process orders at the exchange in submission-time order; (c) orders with the same price and submission time are filled pro-rata (or FIFO depending on exchange rules). This prevents unrealistic "we got every fill" results
- **Iceberg orders**: exchanges support iceberg orders (display a small portion, hide the rest). The backtester must: (a) split an iceberg into displayed + hidden quantity; (b) replenish the displayed quantity after each fill; (c) the hidden quantity is only visible to the exchange, not to other market participants. Icebergs affect queue position — after replenishment, the new displayed portion goes to the back of the queue

### Look-Ahead Bias Prevention
- **Look-ahead bias** is the #1 cause of over-optimistic backtests. It occurs when the backtest uses information that would not have been available at the time of the decision. Common sources: (a) **price peeking** — using today's close price in a signal computed at 10:00 AM. Fix: only use prices with timestamps <= the strategy's current time. (b) **survivorship bias** — only backtesting instruments that exist today, ignoring those that delisted. Fix: use point-in-time symbol lists (the universe as it was on that date). (c) **corporate action peeking** — knowing about a dividend announcement before it was public. Fix: use announcement timestamps, not effective timestamps. (d) **parameter optimization** — selecting parameters that work best on the entire test period. Fix: walk-forward analysis (optimize on training period, test on out-of-sample). (e) **data snooping** — testing 100s of strategies on the same data and picking the best one. Fix: use a completely separate test set (final 20% of data) for final validation
- **Point-in-time data**: every market data snapshot must include only information that was available at that moment. This means: (a) use "as-of" timestamps, not "recorded" timestamps; (b) corporate actions are applied at their announcement date, not effective date; (c) index membership changes are applied at the rebalance date, not when announced; (d) financial reports are available at the filing timestamp, not the period-end date. Building point-in-time data is expensive (100TB+ for 10 years of US equities). Most firms use a vendor (KDB, OneTick, TickSmith) or build their own pipeline with time-travel queries
- **Time-travel testing**: after the backtest is complete, time-travel back to a specific timestamp and inspect the state (positions, orders, signals). This is critical for debugging why a trade was made. The simulator must support: (a) replaying from any checkpoint; (b) inspecting the order book at that moment; (c) evaluating the strategy's decision without advancing time. Use snapshot-based checkpoints every 1 million events

### Transaction Costs
- **Explicit costs**: (a) exchange fees (maker/taker) — modeled per venue with tier qualification; (b) clearing fees — per trade, vary by asset class; (c) settlement fees — for futures (CME), options (OCC); (d) regulatory fees — SEC Section 31 fee ($20.70/million for equities). All must be included in the PnL calculation. Missing fees = overestimated PnL by 10-30%
- **Implicit costs**: (a) bid-ask spread — pay the spread on every round-trip. Model: entry at ask, exit at bid. If the strategy is a taker, pay the full spread; if a maker, earn the spread. (b) slippage — the difference between the decision price and the execution price. Model: add a slippage distribution (empirical from historical fills) to each trade. (c) opportunity cost — missed fills due to latency. Model: if a limit order doesn't fill, the strategy misses the price move. This is the hardest to model but the most important for HFT
- **Fee tier qualification in backtesting**: the backtester must model the firm's fee tier dynamically. If the strategy trades 50K contracts/day on CME, it qualifies for a better tier. The backtester should: (a) track cumulative volume per venue; (b) apply the appropriate tier retrospectively; (c) model the effect of volume on tier qualification. This can change PnL by 15-25%

### Overfitting Prevention
- **Walk-forward analysis**: divide the full dataset into 10 sequential folds. Train (optimize parameters) on folds 1-8, test on fold 9. Then train on folds 2-9, test on fold 10. This simulates how the strategy would have performed in production (trained on past, tested on future). Metrics: average out-of-sample Sharpe, max drawdown, consistency across folds. If Sharpe drops from 3.0 (in-sample) to 0.5 (out-of-sample), the strategy is overfit
- **Parameter sensitivity**: test each parameter by varying it +/- 10% and measuring PnL impact. If a 10% change in a parameter causes a 50% PnL drop, the strategy is overfit to that parameter. The best strategies have smooth parameter response (flat plateau around the optimum)
- **Randomized data shuffling**: shuffle the order of trades/returns and re-run the strategy. If the strategy still shows positive PnL on shuffled data, it's overfit (finding patterns in noise). The shuffled-data Sharpe should be zero. Any positive Sharpe indicates data snooping
- **Minimum backtest period**: for HFT strategies, a minimum of 12 months of tick data is required (preferably 24 months). The test period must include: (a) high-volatility periods (COVID, Fed days); (b) low-volatility periods (summer doldrums); (c) regime changes (election years, rate hike cycles). If the strategy only works in one regime, it's not robust
- **Out-of-sample validation**: the final validation is data that was never used during development — the last 20% of the timeline, or a separate year entirely. The strategy must not be modified after seeing the out-of-sample results. If it fails, start over from scratch. No "tweaking and re-testing" — that's just overfitting by another name

### Backtest-to-Live Gap
- **Phantom liquidity**: in backtests, every limit order at the best bid/ask fills (because the data shows fills at those levels). In reality, your order was not the only one at that price — you were behind other orders in the queue. The backtest over-estimates fill rate. Mitigation: (a) use full order book simulation (queue position); (b) apply a fill probability model based on historical fill rates for your firm's queue position; (c) deflate fills by 30-50% as a conservative estimate
- **Delayed fills**: in backtests, fills happen instantly (as soon as a matching order arrives). In reality, the fill notification takes RTT to reach you. During that time, the strategy may have sent additional orders based on stale information. Mitigation: model network latency for fills (schedule fill events at current_time + RTT)
- **Cancel-Replace behavior**: in backtests, cancel a limit order and replace with a new one is instantaneous. In reality, the cancel must reach the exchange, be processed, and the ack returned before the new order is accepted. If the market moves during this time, the new order may be at a different price or may not fill. Mitigation: model cancel-replace latency as 2x RTT (cancel out + new order in)
- **Regime change**: a strategy that backtests well from 2020-2023 may fail in 2024 due to market structure changes (fee changes, new order types, new exchanges, maker-taker inversion). The backtest cannot predict regulatory changes. Mitigation: always trade new strategies at 10% risk in production for the first 30 days before scaling up

## Source Code

```cpp
// Backtester event loop core
#include <cstdint>
#include <queue>
#include <variant>
#include <functional>

struct Event {
  uint64_t timestamp_ns;
  enum Type { MARKET_DATA_TICK, ORDER_FILL, ORDER_REJECT, SCHEDULED_TASK };
  Type type;
  std::variant<MarketDataTick, OrderFill, OrderReject> data;

  bool operator>(const Event& o) const { return timestamp_ns > o.timestamp_ns; }
};

class EventLoop {
  std::priority_queue<Event, std::vector<Event>, std::greater<Event>> queue_;
  uint64_t current_time_ns_ = 0;

public:
  void push(Event e) { queue_.push(e); }

  void run(std::function<void(const Event&)> strategy_callback) {
    while (!queue_.empty()) {
      Event e = queue_.top();
      queue_.pop();
      current_time_ns_ = e.timestamp_ns;

      // Deliver event to strategy
      strategy_callback(e);

      // Process any orders the strategy submitted
      // (handled by the exchange simulator after callback returns)
    }
  }

  uint64_t now_ns() const { return current_time_ns_; }
};

// Full order book simulation for fill accuracy
class LimitOrderBook {
  struct Level {
    uint64_t price;
    uint64_t total_qty;
    std::vector<Order> orders; // FIFO queue per level
  };
  std::map<uint64_t, Level, std::greater<uint64_t>> bids_;
  std::map<uint64_t, Level, std::less<uint64_t>> asks_;

public:
  // Add a limit order, return its position in queue
  size_t add_order(Order o) {
    auto& level = (o.side == Side::BUY) ? bids_[o.price] : asks_[o.price];
    level.orders.push_back(o);
    level.total_qty += o.qty;
    return level.orders.size() - 1; // queue position (0 = first)
  }

  // Match a market order against the book
  std::vector<Fill> match_market(uint64_t qty, Side side) {
    std::vector<Fill> fills;
    auto& book = (side == Side::BUY) ? asks_ : bids_;
    while (qty > 0 && !book.empty()) {
      auto& [price, level] = *book.begin();
      while (qty > 0 && !level.orders.empty()) {
        auto& order = level.orders.front();
        uint64_t fill_qty = std::min(qty, order.qty);
        fills.push_back({order.id, price, fill_qty});
        order.qty -= fill_qty;
        level.total_qty -= fill_qty;
        qty -= fill_qty;
        if (order.qty == 0) level.orders.erase(level.orders.begin());
      }
      if (level.total_qty == 0) book.erase(book.begin());
    }
    return fills;
  }
};

// Point-in-time data check
// Ensures no look-ahead: price must have timestamp <= backtest current time
struct PointInTimeCheck {
  static bool is_valid(const MarketDataTick& tick, uint64_t current_time_ns) {
    // Reject data with future timestamps
    if (tick.timestamp_ns > current_time_ns) return false;
    // Reject data that was not public at current_time
    // (e.g., corporate actions, financial reports)
    return tick.publication_time_ns <= current_time_ns;
  }
};
```

## Usage

```bash
# Run backtest with full order book simulation
./backtest --config strategy.yaml --data /data/2024-01-01/ \
  --execution full-book --latency-model realistic \
  --fees maker-taker --start 2024-01-01 --end 2024-12-31 \
  --walk-forward 10 --output /results/out/

# Fee tier qualification modeling
./backtest --config strategy.yaml --fee-tiers cme_tiers.json \
  --track-volume --tier-optimize

# Point-in-time validation
./backtest --config strategy.yaml --pit-data /data/pit/ \
  --validate-lookahead --fail-on-lookahead
```

## Staff+ Perspective

> **Staff+ Perspective**: The single biggest backtesting mistake I see is ignoring the fill model. At the firm, a junior quant built a market-making strategy that backtested at a 5 Sharpe. In production, it made 0.3 Sharpe. The difference was entirely fills — the backtest assumed every limit order at the best bid/ask filled immediately. In reality, the queue was deep and our orders were at the back. The fill probability was 15%, not 100%. After adding a full order book simulation (with queue position), the backtest Sharpe dropped to 0.8 — still optimistic (we had other biases), but much more realistic. The fix was expensive: we rewrote the backtester to process every order book event (10M/day) instead of using aggregated tick data. It added 3 hours to each backtest run, but the results were trustworthy. For look-ahead bias: we introduced a "time machine" auditor that checks after each run whether any price with a future timestamp was used. It caught 12 bugs in the first month. The most common: a signal computed from market data would accidentally read a price 2 nanoseconds into the future (because two ticks at the same timestamp were processed in the wrong order). For overfitting prevention: we enforce a strict "three-week rule" — once a strategy is submitted for out-of-sample testing, the developer cannot modify it for 3 weeks. If the out-of-sample results are good, the strategy goes to shadow trading. If not, the development cycle restarts. This prevents the "tweak until it works" cycle that produces overfit strategies. The one thing I wish we built earlier: a backtest replay debugger. Being able to pause at a specific trade and inspect the order book, positions, and signals at that moment is invaluable. We built it as a web UI that loads backtest state snapshots and lets the user step forward/backward by 1ms.