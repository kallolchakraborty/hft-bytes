---
type: reference
title: "Matching Engine"
description: "Price-time priority: orders sorted by price (best first), then. Pro-rata allocation: at the same price level, each order gets"
tags: ["exchange-protocols"]
difficulty: intermediate
timestamp: "2026-06-27T03:06:09.432Z"
phase: 8
phaseName: "Exchange Architecture"
category: "Phase 8 - Exchange Architecture"
subcategory: "exchange-architecture"
language: "cpp"
artifact-id: "ZHFT_MATCHING_ENGINE"
---
## Key Learning Points

- Price-time priority: orders sorted by price (best first), then
- Pro-rata allocation: at the same price level, each order gets
- Continuous trading: orders match immediately when crossing.
- Odd lot handling: odd lots (< round lot) may have lower priority
- Workup / negotiation: some exchanges (e.g., NYSE) allow
- Price-time vs pro-rata allocation deep dive: price-time gives predictable latency incentive (fastest at best price gets all); pro-rata splits volume proportionally among orders at the same price level, reducing the speed advantage but creating gaming via order-size inflation. CME uses pro-rata with top-order priority (first order at each price level gets minimum fill guarantee). Eurex uses pure price-time. LSE uses hybrid: price-time for displayed, pro-rata for hidden
- Trade cancellation / trade break rules: exchanges can nullify trades under specific conditions (erroneous print, system malfunction, market-wide circuit breaker). CME: trades within 5 seconds of a clearly erroneous trade can be busted; Eurex: trades within 3 seconds; LSE: no automatic bust for on-exchange trades. Firms must handle trade break notifications (TradingAction / TradeBust messages) and reverse position/PnL accordingly
- Implied pricing edge cases: CME implied pricing for calendar spreads can create infinite loops (A implies B, B implies A) — the exchange uses a maximum implication depth (typically 3 levels); cross-product implieds (e.g., ES + NQ → YM) must be calculated across matching engines; complex butterflies (3+ legs) may imply into 5+ outright books simultaneously; a partial fill on one butterfly leg can orphan implied orders on other legs

## Usage

```bash

MatchingEngine me("AAPL");
me.addOrder({1, Side::BUY, 100, 150.25, OrderType::LIMIT});
me.addOrder({2, Side::SELL, 50, 150.25, OrderType::LIMIT});
auto trades = me.match(); // process matching
```

## Staff+ Perspective

> **Staff+ Perspective**: The choice between price-time and pro-rata affects strategy more than most realize. In pure pro-rata allocation (CME), the optimal strategy is to send the maximum order size at the best price level to capture a proportion of each match — a "book burner" strategy. In price-time (Eurex), the optimal strategy is to be the fastest to the best price. Many firms run separate microstrategies tuned to each venue's matching rule. For implied pricing, the infinite-loop protection must be understood deeply: CME's maximum implication depth of 3 means a 3-leg butterfly can imply into 8 outright books. If the butterfly's spread's change is slow (e.g., expiration-based), recalc can be lazy (every N milliseconds); if it's fast (e.g., active calendar spread), recalc must be event-driven on each outright change.

## Source Code

```cpp
#include <algorithm>
#include <bit>
#include <cstdint>
#include <cstring>
#include <list>
#include <map>
#include <string_view>
#include <vector>

// ---------------------------------------------------------------------------
// Order types
// ---------------------------------------------------------------------------
enum class Side : uint8_t { BUY, SELL };
enum class OrderType : uint8_t { LIMIT, MARKET, STOP, STOP_LIMIT };
enum class TimeInForce : uint8_t { DAY, IOC, FOK, GTC };

struct Order {
  uint64_t    id;
  Side        side;
  uint64_t    quantity;
  uint64_t    filled_qty;
  double      price;       // 0 for MARKET
  double      stop_price;  // 0 if not stop
  OrderType   type;
  TimeInForce tif;
  uint64_t    timestamp;   // Arrival time (nanoseconds since epoch)
};

// ---------------------------------------------------------------------------
// Trade record
// ---------------------------------------------------------------------------
struct Trade {
  uint64_t buy_id;
  uint64_t sell_id;
  uint64_t quantity;
  double   price;
  uint64_t timestamp;
};

// ---------------------------------------------------------------------------
// Price level (price-time priority)
// ---------------------------------------------------------------------------
struct PriceLevel {
  double price;
  std::list<Order> orders; // Ordered by arrival

  void addOrder(Order ord) {
    if (orders.empty()) {
      orders.push_back(std::move(ord));
      return;
    }
    // Insert in timestamp order (ascending)
    auto it = orders.begin();
    while (it != orders.end() && it->timestamp <= ord.timestamp) ++it;
    orders.insert(it, std::move(ord));
  }
};

// ---------------------------------------------------------------------------
// Matching engine
// ---------------------------------------------------------------------------
class MatchingEngine {
public:
  explicit MatchingEngine(std::string_view symbol) : symbol_(symbol) {}

  // Add order and return any trades
  std::vector<Trade> addOrder(const Order &ord) {
    if (ord.tif == TimeInForce::FOK) {
      return handleFok(ord);
    }
    if (ord.tif == TimeInForce::IOC) {
      return handleIoc(ord);
    }

    // Try immediate match first
    auto trades = tryMatch(ord);

    // If remaining, add to book (unless IOC/FOK)
    if (ord.filled_qty < ord.quantity && ord.tif != TimeInForce::IOC) {
      Order remaining = ord;
      remaining.quantity -= ord.filled_qty;
      remaining.filled_qty = 0;
      addToBook(remaining);
    }

    return trades;
  }

  // Cancel order
  void cancel(uint64_t id) {
    auto cancel_side = cancels_[id];
    auto &levels = (cancel_side == Side::BUY) ? bids_ : asks_;
    for (auto &[px, level] : levels) {
      auto it = std::find_if(level.orders.begin(), level.orders.end(),
          [id](const Order &o) { return o.id == id; });
      if (it != level.orders.end()) {
        level.orders.erase(it);
        cancels_.erase(id);
        if (level.orders.empty()) levels.erase(px);
        return;
      }
    }
  }

  // Top of book
  double bestBid() const {
    if (bids_.empty()) return 0;
    return bids_.begin()->first;
  }

  double bestAsk() const {
    if (asks_.empty()) return 0;
    return asks_.begin()->first;
  }

private:
  std::string symbol_;
  std::map<double, PriceLevel, std::greater<double>> bids_; // Buy: descending price
  std::map<double, PriceLevel> asks_;                       // Sell: ascending price
  std::unordered_map<uint64_t, Side> cancels_;              // For cancel lookup

  std::vector<Trade> tryMatch(const Order &ord) {
    std::vector<Trade> trades;
    Order working = ord;

    auto &opposite = (working.side == Side::BUY) ? asks_ : bids_;
    auto &same = (working.side == Side::BUY) ? bids_ : asks_;

    // Find matching level
    auto it = opposite.begin();
    while (it != opposite.end() && working.filled_qty < working.quantity) {
      auto &level = it->second;
      bool price_ok = (working.side == Side::BUY)
          ? (working.price >= level.price || working.type == OrderType::MARKET)
          : (working.price <= level.price || working.type == OrderType::MARKET);

      if (!price_ok) break;

      auto oit = level.orders.begin();
      while (oit != level.orders.end() &&
             working.filled_qty < working.quantity) {
        uint64_t exec_qty = std::min(working.quantity - working.filled_qty,
                                     oit->quantity - oit->filled_qty);
        double exec_price = level.price;

        trades.push_back({
            working.side == Side::BUY ? working.id : oit->id,
            working.side == Side::SELL ? working.id : oit->id,
            exec_qty, exec_price, working.timestamp
        });

        working.filled_qty += exec_qty;
        oit->filled_qty += exec_qty;
        if (oit->filled_qty >= oit->quantity) {
          oit = level.orders.erase(oit);
        } else {
          ++oit;
        }
      }

      if (level.orders.empty()) {
        it = opposite.erase(it);
      } else {
        ++it;
      }
    }

    return trades;
  }

  void addToBook(const Order &ord) {
    auto &levels = (ord.side == Side::BUY) ? bids_ : asks_;
    levels[ord.price].addOrder(ord);
    cancels_[ord.id] = ord.side;
  }

  std::vector<Trade> handleFok(const Order &ord) {
    // Estimate if full fill possible; if yes, match; else no trade
    uint64_t available = 0;
    auto &opposite = (ord.side == Side::BUY) ? asks_ : bids_;
    for (auto &[px, lvl] : opposite) {
      bool price_ok = (ord.side == Side::BUY)
          ? (ord.price >= px || ord.type == OrderType::MARKET)
          : (ord.price <= px || ord.type == OrderType::MARKET);
      if (!price_ok) break;
      for (auto &o : lvl.orders) available += (o.quantity - o.filled_qty);
    }
    if (available >= ord.quantity) return tryMatch(ord);
    return {}; // No fill for FOK
  }

  std::vector<Trade> handleIoc(const Order &ord) {
    // Fill what's available, cancel remainder
    return tryMatch(ord);
  }
};
```
