---
type: reference
title: "Backtest Engine"
description: "Event loop architecture: tick/bar/order event queue. Market data cursor: deterministic iteration over historical data"
tags: ["backtesting", "testing"]
difficulty: intermediate
timestamp: "2026-06-27T03:06:09.439Z"
phase: 11
phaseName: "Backtesting & Simulation"
category: "Phase 11 - Backtesting & Simulation"
subcategory: "backtesting"
language: "cpp"
artifact-id: "ZHFT_BACKTEST_ENGINE"
---
## Key Learning Points

- **Event loop architecture**: tick/bar/order event queue — a priority queue sorted by timestamp, with events processed in strict chronological order. The event queue is the backbone of the backtester: it determines the order in which market data, order acknowledgments, fills, and cancels are processed. Design choice: single priority queue (simple, O(log n) per event) vs multi-queue (separate queues for market data and order events, merged at dispatch time). For HFT: the single-queue design is simpler and fast enough for backtesting — O(log n) is negligible compared to the strategy computation per event. The critical property: event order must be deterministic — given the same binary data file, the backtester must produce identical results
- **Market data cursor**: deterministic iteration over historical data — read binary tick records sequentially, dispatch to strategy. The cursor is a simple file reader with a position pointer. For HFT: the cursor must handle gaps in the data (missing ticks, exchange outages) without affecting determinism. Gap handling: insert a synthetic "gap event" with the last known price and zero size. The strategy should be robust to gaps — in live trading, gaps happen during disconnections. The cursor also supports seek/rewind for targeted testing (start from a specific date)
- **Order handler simulator**: fill/stay/cancel decisions with latency — model the exchange's response to your orders. The simulator must model: (a) order acceptance (is the order valid?), (b) fill (does the order cross the spread?), (c) partial fill (what fraction of the order is filled?), (d) latency (how long between send and response?). For HFT: the latency model is critical — a naive model (fixed 5μs latency) misses the reality that fill probability depends on queue position, market depth, and market conditions. A better model: fill_probability = f(order_price, spread, depth_at_best, queue_position) — but this adds complexity. Start with the naive model and add complexity only when backtest results diverge from live results
- **P&L tracker**: realized and unrealized with FIFO cost basis — track profit/loss from each trade. FIFO (First-In-First-Out) matches the oldest entry against the newest exit — this is the standard for tax reporting and performance measurement. Alternative: LIFO (Last-In-First-Out) or specific identification (match each exit to a specific entry). For HFT: FIFO is the only sensible choice — you can't meaningfully match individual entries/exits when you have thousands of trades per second. Realized PnL = sum of (exit_price - entry_price) × quantity for all matched pairs. Unrealized PnL = current_price × position - average_entry_price × position
- **Fill simulation with configurable latency model + partial fills**: model the probability that your order is filled at the price you specified. The simplest model: if your buy order's price >= ask, it's filled. A better model: fill_probability = min(1, depth_at_best / order_size) — if your order is larger than the depth at best, only a fraction is filled. For HFT: partial fills are the norm for large orders in illiquid names. The fill simulator should model queue position — if you're the 5th order in the queue, your fill probability depends on how many orders ahead of you are filled first. This is where backtest realism breaks down: a naive simulator overestimates fill rates, leading to optimistic PnL estimates

## Usage

BacktestEngine engine(data_loader);
engine.run<MyStrategy>(start_date, end_date);

## Source Code

```cpp
#include <queue>
#include <vector>
#include <functional>
#include <memory>

enum class EventType { TICK, ORDER_ACK, FILL, CANCEL, EOD };

struct Event {
    EventType type;
    uint64_t  timestamp_ns;
    union {
        struct { double bid, ask, last; uint32_t bsz, asz, lsz; } tick;
        struct { uint64_t order_id; bool accepted; } ack;
        struct { uint64_t order_id; double price; uint32_t qty; } fill;
    };
    bool operator>(const Event& o) const { return timestamp_ns > o.timestamp_ns; }
};

class EventQueue {
    std::priority_queue<Event, std::vector<Event>, std::greater<Event>> queue_;

public:
    void push(Event e) { queue_.push(e); }
    Event pop() {
        Event e = queue_.top();
        queue_.pop();
        return e;
    }
    bool empty() const { return queue_.empty(); }
};

// --------------------------------------------------------------------
// Order Simulator with Latency Model

class OrderSimulator {
    struct PendingOrder {
        uint64_t id;
        double   price;
        uint32_t qty;
        bool     is_buy;
        uint64_t sent_ns;
    };

    std::vector<PendingOrder> pending_;
    uint64_t latency_model_ns_{5000};  // 5μs exchange round-trip

public:
    // fill simulation: crosses price? partial? latency?
    // tradeoff: naive price-cross vs queue position model
    std::vector<Event> simulateFill(const Event& tick, uint64_t now_ns) {
        std::vector<Event> fills;
        for (auto& po : pending_) {
            if (now_ns - po.sent_ns < latency_model_ns_) continue;
            bool cross = po.is_buy
                         ? tick.tick.ask <= po.price
                         : tick.tick.bid >= po.price;
            if (cross) {
                // partial fill model: 50% fill probability
                uint32_t fill_qty = (rand() % 2) ? po.qty : po.qty / 2;
                fills.push_back({EventType::FILL, now_ns, .fill={po.id, po.price, fill_qty}});
                po.qty -= fill_qty;
            }
        }
        // prune fully filled
        pending_.erase(std::remove_if(pending_.begin(), pending_.end(),
                       [](auto& p) { return p.qty == 0; }), pending_.end());
        return fills;
    }
};

// --------------------------------------------------------------------
// P&L Tracker (FIFO)

class PnLTracker {
    std::queue<std::pair<double, uint32_t>> long_inventory_;   // (price, qty)
    std::queue<std::pair<double, uint32_t>> short_inventory_;
    double realized_{0};

public:
    void addFill(bool buy, double price, uint32_t qty) {
        auto& inv = buy ? long_inventory_ : short_inventory_;
        inv.push({price, qty});
    }

    void removeFill(bool buy, double price, uint32_t qty) {
        // FIFO: match oldest first
        // tradeoff: FIFO vs LIFO vs specific identification
        auto& inv = buy ? short_inventory_ : long_inventory_;
        while (qty > 0 && !inv.empty()) {
            auto [entry_px, entry_qty] = inv.front();
            uint32_t match = std::min(qty, entry_qty);
            realized_ += match * (buy ? (entry_px - price) : (price - entry_px));
            qty -= match;
            entry_qty -= match;
            if (entry_qty == 0) inv.pop();
            else inv.front().second = entry_qty;
        }
    }

    double realized() const { return realized_; }
    double unrealized(double current_price) const { /* compute */ return 0; }
};
```
