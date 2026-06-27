---
type: reference
title: "Auction Handling"
description: "Opening auction: order collection (pre-open), indicative price. Closing auction: Market-On-Close (MOC) / Limit-On-Close (LOC)"
tags: ["auctions"]
timestamp: "2026-06-27T03:06:09.424Z"
phase: 7
phaseName: "Order Entry & Execution"
category: "Phase 7 - Order Entry & Execution"
subcategory: "order-entry"
language: "cpp"
artifact-id: "ZHFT_AUCTION_HANDLING"
---
## Key Learning Points

- Opening auction: order collection (pre-open), indicative price
- Closing auction: Market-On-Close (MOC) / Limit-On-Close (LOC)
- Volatility auctions: triggered by circuit breaker (LULD).
- Imbalance auction: when buy/sell orders mis-match, price moves
- Uncrossing algorithm: match at a single price that maximizes

## Usage

// AuctionEngine auct;
// auct.startAuction(AuctionType::OPENING, "AAPL");
// auct.addOrder(Order{...}); // during collection
// auct.indicativePrice(); // during auction
// auto result = auct.uncross(); // at auction end

## Source Code

```cpp
#include <algorithm>
#include <bit>
#include <chrono>
#include <cstdint>
#include <cstring>
#include <map>
#include <string_view>
#include <vector>

// ---------------------------------------------------------------------------
// Auction types
// ---------------------------------------------------------------------------
enum class AuctionType : uint8_t {
  OPENING,
  CLOSING,
  VOLATILITY,
  IMBALANCE,
};

enum class AuctionPhase : uint8_t {
  INACTIVE,
  ORDER_COLLECTION,
  INDICATIVE,    // Publishing indicative price + imbalance
  UNCROSSING,    // Final matching
  COMPLETE,
};

// ---------------------------------------------------------------------------
// Auction order (extended)
// ---------------------------------------------------------------------------
enum class AucSide : uint8_t { BUY, SELL };

struct AuctionOrder {
  uint64_t order_id;
  uint64_t quantity;
  uint64_t display_qty;  // 0 = hidden
  double   limit_price;   // 0 = market
  AucSide  side;
  bool     is_moc;        // Market-on-Close
  bool     is_iceberg;
  bool     is_hidden;
};

// ---------------------------------------------------------------------------
// Price level aggregation
// ---------------------------------------------------------------------------
struct PriceLevel {
  double   price;
  uint64_t buy_qty;
  uint64_t sell_qty;
  uint64_t buy_orders;
  uint64_t sell_orders;
};

// ---------------------------------------------------------------------------
// Indicative state
// ---------------------------------------------------------------------------
struct IndicativeState {
  double indicative_price;
  double imbalance_qty;    // + = net buy, - = net sell
  double matched_qty;
  bool   is_valid;
  double near_price;       // Reference (last trade) price
};

// ---------------------------------------------------------------------------
// Auction uncrossing result
// ---------------------------------------------------------------------------
struct UncrossingResult {
  double uncross_price;
  uint64_t executed_qty;
  uint64_t imbalance_qty;
  uint64_t num_trades;
  bool     succeeded;
};

// ---------------------------------------------------------------------------
// Auction engine
// ---------------------------------------------------------------------------
class AuctionEngine {
public:
  void startAuction(AuctionType type, std::string_view symbol,
                    double reference_price, uint64_t auction_duration_ms) {
    auction_type_ = type;
    symbol_ = symbol;
    reference_price_ = reference_price;
    phase_ = AuctionPhase::ORDER_COLLECTION;
    auction_end_ = std::chrono::steady_clock::now() +
                   std::chrono::milliseconds(auction_duration_ms);
    orders_.clear();
    buy_levels_.clear();
    sell_levels_.clear();
  }

  void addOrder(const AuctionOrder &ord) {
    if (phase_ != AuctionPhase::ORDER_COLLECTION &&
        phase_ != AuctionPhase::INDICATIVE) return;

    orders_.push_back(ord);

    // Aggregate into price levels
    auto &levels = (ord.side == AucSide::BUY) ? buy_levels_ : sell_levels_;
    double px = ord.limit_price;
    // Market orders go to "zero" price level for computation
    if (px == 0.0) px = (ord.side == AucSide::BUY) ? 1e9 : -1e9;
    auto &lvl = levels[px];
    lvl.price = px;
    lvl.buy_qty += (ord.side == AucSide::BUY) ? ord.quantity : 0;
    lvl.sell_qty += (ord.side == AucSide::SELL) ? ord.quantity : 0;
  }

  IndicativeState indicativePrice() {
    if (orders_.empty())
      return {0, 0, 0, false, reference_price_};

    // Build cumulative supply/demand curves and find cross point
    // Sort buy descending, sell ascending
    // Compute cumulative qty at each price level
    // Find price where cumulative buy >= cumulative sell
    // (max volume, min imbalance)

    IndicativeState state{};
    state.near_price = reference_price_;

    // Simplified: walk through sorted levels
    uint64_t cum_buy = 0, cum_sell = 0;
    for (auto &[px, lvl] : buy_levels_) {
      cum_buy += lvl.buy_qty;
    }
    for (auto &[px, lvl] : sell_levels_) {
      cum_sell += lvl.sell_qty;
    }

    state.imbalance_qty = static_cast<double>(
        std::max(cum_buy, cum_sell) - std::min(cum_buy, cum_sell));
    state.matched_qty = std::min(cum_buy, cum_sell);
    state.indicative_price = reference_price_;
    state.is_valid = true;

    // CRITICAL: indicative price must not move more than exchange
    // volatility limits (e.g., CME price bands). Clamp if needed.
    return state;
  }

  UncrossingResult uncross() {
    if (phase_ == AuctionPhase::COMPLETE) return {};

    phase_ = AuctionPhase::UNCROSSING;

    // 1. Sort buy orders: price descending, time ascending
    // 2. Sort sell orders: price ascending, time ascending
    // 3. Find clearing price that maximizes volume
    // 4. Execute at that price, all orders at or better than clearing price fill
    // 5. Remaining entered as limit orders at clearing price

    // Simplified uncross:
    uint64_t buy_vol = 0, sell_vol = 0;
    for (auto &[px, lvl] : buy_levels_) buy_vol += lvl.buy_qty;
    for (auto &[px, lvl] : sell_levels_) sell_vol += lvl.sell_qty;

    uint64_t exec = std::min(buy_vol, sell_vol);
    double price = reference_price_; // would compute from supply/demand

    phase_ = AuctionPhase::COMPLETE;

    return {price, exec,
            buy_vol > sell_vol ? buy_vol - sell_vol : sell_vol - buy_vol,
            exec > 0 ? exec / 100 : 0, // rough trade count estimate
            exec > 0};
  }

  AuctionPhase phase() const { return phase_; }
  bool isActive() const {
    return phase_ != AuctionPhase::INACTIVE &&
           phase_ != AuctionPhase::COMPLETE;
  }

  // Check if auction should transition to indicative
  void tick() {
    if (phase_ != AuctionPhase::ORDER_COLLECTION) return;
    auto now = std::chrono::steady_clock::now();
    if (now >= auction_end_) {
      phase_ = AuctionPhase::INDICATIVE;
    }
    // In production: publish indicative price periodically
  }

private:
  AuctionType auction_type_;
  std::string symbol_;
  double reference_price_ = 0;
  AuctionPhase phase_ = AuctionPhase::INACTIVE;
  std::chrono::steady_clock::time_point auction_end_;
  std::vector<AuctionOrder> orders_;
  std::map<double, PriceLevel, std::greater<double>> buy_levels_;
  std::map<double, PriceLevel> sell_levels_;
};
```
