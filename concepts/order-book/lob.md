---
type: reference
title: "LOB"
description: "Price-time priority: best price first, earliest arrival first. Price levels as linked lists or sorted arrays: each level holds"
tags: ["phase-9"]
difficulty: advanced
timestamp: "2026-06-27T03:06:09.435Z"
phase: 9
phaseName: "Order Book & Microstructure"
category: "Phase 9 - Order Book & Microstructure"
subcategory: "order-book"
language: "cpp"
artifact-id: "ZHFT_LOB"
---
## Key Learning Points

- Price-time priority: best price first, earliest arrival first
- Price levels as linked lists or sorted arrays: each level holds
- Incremental updates: Add (new level/order), Modify (order size
- Snapshot processing: full order book image as of a sequence
- Iceberg order handling: only displayed quantity visible in book;
- Gap recovery edge cases: overlapping gaps occur when two gap requests span the same seqno range — apply each gap's snapshot sequentially; partial gaps (snapshot received but some messages still missing) require a second retransmission request; snapshot corruption (checksum mismatch on snapshot) must trigger a full re-request and discard all incremental updates since the snapshot seqno
- Snapshot vs incremental reconciliation: on startup, request a snapshot at seqno S, then apply all increments from S+1 onward; if increments arrive before the snapshot, buffer them in a seqno-sorted queue; on CME MDP 3.0, the snapshot is a burst of ~500 messages for ES — must process in a single atomic operation (swap book state) while queuing increments
- Micro-price calculation from LOB: micro-price = (bid_px × ask_sz + ask_px × bid_sz) / (bid_sz + ask_sz); represents the fair price weighted by liquidity; when micro-price is skewed toward bid, the book predicts upward movement; used by market makers to adjust spread positioning
- Order book rebuild from scratch: on persistent gap (retransmission exhausted), request a fresh snapshot; during rebuild, the strategy must stop trading or use a simpler fallback (e.g., top-of-book only); typical rebuild budget: 100ms max — beyond this, market making pauses

```html
<div class="ad-wrapper">
  <div class="ad-title">Limit Order Book — Bid / Ask Depth Ladder</div>
  <div style="display:flex;gap:2rem;justify-content:center;align-items:flex-end">
    <div>
      <div class="ad-stack">
        <div class="ad-bar bid"></div><div class="ad-bar bid"></div><div class="ad-bar bid"></div>
        <div class="ad-bar bid"></div><div class="ad-bar bid"></div>
      </div>
      <div class="ad-price-label">Bids</div>
    </div>
    <div style="border-left:2px solid var(--border-default);height:4rem"></div>
    <div>
      <div class="ad-stack">
        <div class="ad-bar ask"></div><div class="ad-bar ask"></div><div class="ad-bar ask"></div>
        <div class="ad-bar ask"></div><div class="ad-bar ask"></div>
      </div>
      <div class="ad-price-label">Asks</div>
    </div>
  </div>
  <div class="ad-legend">
    <span class="ad-legend-item"><span class="ad-legend-swatch bid"></span>Bid</span>
    <span class="ad-legend-item"><span class="ad-legend-swatch ask"></span>Ask</span>
  </div>
</div>
```

## Usage

```bash

LimitOrderBook lob("ES");
lob.applyIncremental(MDAdd{SeqNo, Side::BUY, 100, 4500.00, "ORD1"});
lob.applyIncremental(MDExecute{SeqNo, "ORD1", 50});
auto top = lob.topOfBook(); // 4500.00, 4500.25, 50@bid, 100@ask
```

## Staff+ Perspective

> **Staff+ Perspective**: The micro-price calculation is the hidden gem most junior devs miss. At IMC, we used micro-price to detect stale quotes from other market makers — when micro-price diverged more than 0.5 ticks from the spread midpoint, we knew someone hadn't updated their book and we could fade them. The second lesson: iceberg orders are the primary vehicle for large institutional flow. If you see a 2-lot displayed order on ES that keeps replenishing (same ClOrdId), it's an iceberg. Tracking the total executed quantity against the displayed quantity lets you estimate the hidden size — a key input for the market impact model. For the gap recovery, never trust exchange multicast seqnos alone — always verify the hash of every Nth message (e.g., CME's IncrementalRefreshHash) to detect silent corruption.

## Source Code

```cpp
#include <algorithm>
#include <bit>
#include <cstdint>
#include <cstring>
#include <list>
#include <map>
#include <optional>
#include <string_view>
#include <unordered_map>
#include <vector>

// ---------------------------------------------------------------------------
// Order book entry
// ---------------------------------------------------------------------------
enum class Side : uint8_t { BUY, SELL };

struct OrderBookEntry {
  uint64_t    order_id;
  uint64_t    quantity;       // Current visible quantity
  uint64_t    hidden_qty;     // Iceberg reserve (0 = no iceberg)
  double      price;
  Side        side;
  uint64_t    timestamp;      // Arrival time for priority
};

// ---------------------------------------------------------------------------
// Price level
// ---------------------------------------------------------------------------
struct PriceLevel {
  double price;
  uint64_t total_qty;
  std::list<OrderBookEntry> orders;  // Ordered by arrival time

  void addOrder(OrderBookEntry ord) {
    total_qty += ord.quantity;
    if (orders.empty() || ord.timestamp >= orders.back().timestamp) {
      orders.push_back(std::move(ord));
    } else {
      // Insert in timestamp order
      auto it = orders.begin();
      while (it != orders.end() && it->timestamp <= ord.timestamp) ++it;
      orders.insert(it, std::move(ord));
    }
  }

  bool removeOrder(uint64_t order_id) {
    for (auto it = orders.begin(); it != orders.end(); ++it) {
      if (it->order_id == order_id) {
        total_qty -= it->quantity;
        orders.erase(it);
        return true;
      }
    }
    return false;
  }
};

// ---------------------------------------------------------------------------
// Top of book
// ---------------------------------------------------------------------------
struct TopOfBook {
  double bid_price;
  double ask_price;
  uint64_t bid_size;
  uint64_t ask_size;
  bool     valid;
};

// ---------------------------------------------------------------------------
// Limit Order Book
// ---------------------------------------------------------------------------
class LimitOrderBook {
public:
  explicit LimitOrderBook(std::string_view symbol)
      : symbol_(symbol) {}

  // --- Incremental updates ---

  void addOrder(uint64_t order_id, Side side, uint64_t qty,
                double price, uint64_t hidden_qty = 0) {
    OrderBookEntry entry{
      order_id, qty, hidden_qty, price, side, nextTimestamp()
    };

    auto &levels = (side == Side::BUY) ? bids_ : asks_;
    auto &level = levels[price];
    level.price = price;
    level.addOrder(std::move(entry));

    order_map_[order_id] = {side, price};
  }

  void execute(uint64_t order_id, uint64_t fill_qty) {
    auto it = order_map_.find(order_id);
    if (it == order_map_.end()) return;

    auto &[side, price] = it->second;
    auto &levels = (side == Side::BUY) ? bids_ : asks_;
    auto lit = levels.find(price);
    if (lit == levels.end()) return;

    auto &level = lit->second;
    for (auto &entry : level.orders) {
      if (entry.order_id == order_id) {
        uint64_t exec = std::min(fill_qty, entry.quantity);
        entry.quantity -= exec;
        level.total_qty -= exec;

        // Iceberg replenish
        if (entry.quantity == 0 && entry.hidden_qty > 0) {
          uint64_t replenish = std::min(entry.hidden_qty, exec);
          entry.quantity = replenish;
          entry.hidden_qty -= replenish;
          level.total_qty += replenish;
        }

        if (entry.quantity == 0 && entry.hidden_qty == 0) {
          level.orders.erase(
              std::find_if(level.orders.begin(), level.orders.end(),
                  [order_id](auto &e) { return e.order_id == order_id; })
          );
          order_map_.erase(order_id);
        }

        if (level.orders.empty()) levels.erase(lit);
        return;
      }
    }
  }

  void cancelOrder(uint64_t order_id) {
    auto it = order_map_.find(order_id);
    if (it == order_map_.end()) return;

    auto &[side, price] = it->second;
    auto &levels = (side == Side::BUY) ? bids_ : asks_;
    auto lit = levels.find(price);
    if (lit == levels.end()) return;

    lit->second.removeOrder(order_id);
    if (lit->second.orders.empty()) levels.erase(lit);
    order_map_.erase(order_id);
  }

  void modifyOrder(uint64_t order_id, uint64_t new_qty) {
    // TRADEOFF: modify-in-place vs delete+add. Modify-in-place is
    // faster but changes order priority (bad). Delete+add resets
    // priority (correct). Exchanges usually reset priority on qty increase.
    cancelOrder(order_id);
    // Need to re-add with saved params
  }

  // --- Snapshots ---

  struct Snapshot {
    uint64_t seq_no;
    std::vector<std::tuple<double, uint64_t, Side>> levels; // price, qty, side
  };

  Snapshot snapshot(uint64_t seq_no) const {
    Snapshot snap{seq_no, {}};
    for (auto &[px, level] : bids_)
      snap.levels.emplace_back(px, level.total_qty, Side::BUY);
    for (auto &[px, level] : asks_)
      snap.levels.emplace_back(px, level.total_qty, Side::SELL);
    return snap;
  }

  void rebuildFromSnapshot(const Snapshot &snap) {
    bids_.clear();
    asks_.clear();
    order_map_.clear();
    for (auto &[price, qty, side] : snap.levels) {
      auto &levels = (side == Side::BUY) ? bids_ : asks_;
      levels[price].price = price;
      levels[price].total_qty = qty;
    }
  }

  // --- Queries ---

  TopOfBook topOfBook() const {
    TopOfBook tb{};
    if (!bids_.empty()) {
      tb.bid_price = bids_.begin()->first;
      tb.bid_size  = bids_.begin()->second.total_qty;
      tb.valid     = true;
    }
    if (!asks_.empty()) {
      tb.ask_price = asks_.begin()->first;
      tb.ask_size  = asks_.begin()->second.total_qty;
      tb.valid     = true;
    }
    return tb;
  }

  double midPrice() const {
    auto tb = topOfBook();
    if (!tb.valid) return 0;
    return (tb.bid_price + tb.ask_price) / 2.0;
  }

  double spread() const {
    auto tb = topOfBook();
    if (!tb.valid) return 0;
    return tb.ask_price - tb.bid_price;
  }

  // Book depth at N levels
  struct DepthLevel {
    double price;
    uint64_t bid_qty;
    uint64_t ask_qty;
  };
  std::vector<DepthLevel> depth(size_t levels = 5) const {
    std::vector<DepthLevel> out;
    auto bit = bids_.begin();
    auto ait = asks_.begin();
    for (size_t i = 0; i < levels; i++) {
      DepthLevel dl{};
      if (bit != bids_.end()) {
        dl.price   = bit->first;
        dl.bid_qty = bit->second.total_qty;
        ++bit;
      }
      if (ait != asks_.end()) {
        dl.ask_qty = ait->second.total_qty;
        if (dl.price == 0) dl.price = ait->first;
        ++ait;
      }
      out.push_back(dl);
    }
    return out;
  }

private:
  std::string symbol_;
  std::map<double, PriceLevel, std::greater<double>> bids_; // descending
  std::map<double, PriceLevel> asks_;                        // ascending

  // Map order_id -> (side, price) for fast lookup
  struct OrderLoc { Side side; double price; };
  std::unordered_map<uint64_t, OrderLoc> order_map_;

  uint64_t ts_counter_ = 0;
  uint64_t nextTimestamp() { return ++ts_counter_; }
};
```
