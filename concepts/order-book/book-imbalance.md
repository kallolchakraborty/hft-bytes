---
type: reference
title: "Book Imbalance"
description: "Bid/ask volume imbalance: (bid_volume - ask_volume) /. Micro-price: weighted average of bid and ask using volume"
tags: ["liquidity"]
difficulty: intermediate
timestamp: "2026-06-27T03:06:09.433Z"
phase: 9
phaseName: "Order Book & Microstructure"
category: "Phase 9 - Order Book & Microstructure"
subcategory: "order-book"
language: "cpp"
artifact-id: "ZHFT_BOOK_IMBALANCE"
---
## Key Learning Points

- Bid/ask volume imbalance: (bid_volume - ask_volume) /
- Micro-price: weighted average of bid and ask using volume
- VPIN (Volume-synchronized Probability of Informed Trading):
- Spread decomposition: realized spread vs adverse selection
- Trade sign classification: Lee-Ready (quote rule: trade at

## Usage

```bash

BookImbalance bi;
bi.update(Side::BUY, 1000, 150.25, Side::SELL, 500, 150.30);
auto imb = bi.imbalance();
auto mp = bi.microPrice();
auto vpin = bi.vpin(trades, 100);
```

## Source Code

```cpp
#include <algorithm>
#include <array>
#include <bit>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <deque>
#include <string_view>
#include <vector>

// ---------------------------------------------------------------------------
// Book imbalance calculator
// ---------------------------------------------------------------------------
class BookImbalance {
public:
  void update(uint64_t bid_vol, double bid, uint64_t ask_vol, double ask) {
    bid_volume_ = bid_vol;
    ask_volume_ = ask_vol;
    bid_price_  = bid;
    ask_price_  = ask;
  }

  // Signed imbalance: +1 = all bids, -1 = all asks
  double imbalance() const {
    double total = static_cast<double>(bid_volume_ + ask_volume_);
    if (total == 0) return 0;
    return (static_cast<double>(bid_volume_) - static_cast<double>(ask_volume_)) / total;
  }

  // Microprice: volume-weighted mid
  double microPrice() const {
    if (bid_volume_ + ask_volume_ == 0) return (bid_price_ + ask_price_) / 2.0;
    return (ask_price_ * bid_volume_ + bid_price_ * ask_volume_)
         / static_cast<double>(bid_volume_ + ask_volume_);
  }

  // Order flow toxicity proxy
  double toxicity() const {
    double imb = imbalance();
    return std::abs(imb); // simplified
  }

private:
  uint64_t bid_volume_ = 0;
  uint64_t ask_volume_ = 0;
  double   bid_price_  = 0;
  double   ask_price_  = 0;
};

// ---------------------------------------------------------------------------
// VPIN calculator
// ---------------------------------------------------------------------------
class VpinCalculator {
public:
  VpinCalculator(size_t volume_bucket, size_t n_buckets)
      : bucket_volume_(volume_bucket), max_buckets_(n_buckets) {}

  void recordTrade(double price, uint64_t volume, bool is_buy) {
    current_bucket_.buy_vol += is_buy ? volume : 0;
    current_bucket_.sell_vol += is_buy ? 0 : volume;
    current_bucket_.total_vol += volume;

    if (current_bucket_.total_vol >= bucket_volume_) {
      // Finalize bucket and push
      buckets_.push_back(current_bucket_);
      current_bucket_ = VolumeBucket{};
      if (buckets_.size() > max_buckets_) {
        buckets_.pop_front();
      }
    }
  }

  double computeVPIN() const {
    if (buckets_.empty()) return 0;
    double total_imbalance = 0;
    uint64_t total_vol = 0;
    for (auto &b : buckets_) {
      double imb = std::abs(
          static_cast<double>(b.buy_vol) - static_cast<double>(b.sell_vol));
      total_imbalance += imb;
      total_vol += b.total_vol;
    }
    if (total_vol == 0) return 0;
    return total_imbalance / static_cast<double>(total_vol);
  }

  // TRADEOFF: VPIN values > 0.6 suggest toxic order flow.
  // Consider widening spread or reducing size when VPIN high.

private:
  struct VolumeBucket {
    uint64_t buy_vol = 0;
    uint64_t sell_vol = 0;
    uint64_t total_vol = 0;
  };

  uint64_t bucket_volume_;
  size_t max_buckets_;
  VolumeBucket current_bucket_;
  std::deque<VolumeBucket> buckets_;
};

// ---------------------------------------------------------------------------
// Trade sign classifier (Lee-Ready + Tick rule)
// ---------------------------------------------------------------------------
class TradeSignClassifier {
public:
  enum class TradeSign : uint8_t { BUY, SELL, NEUTRAL };

  TradeSign classify(double trade_price, double bid, double ask,
                     double last_trade_price) {
    // Lee-Ready: trade at ask = buy, at bid = sell
    if (trade_price >= ask) return TradeSign::BUY;
    if (trade_price <= bid) return TradeSign::SELL;

    // If mid, use tick rule: compare to last trade
    // CRITICAL: tick rule alone catches ~70-80% of signs.
    // Combined with quote rule (Lee-Ready) achieves ~85-93% accuracy.
    if (trade_price > last_trade_price) return TradeSign::BUY;
    if (trade_price < last_trade_price) return TradeSign::SELL;

    // If equal to last trade, use last sign (zero-tick rule)
    return last_sign_;
  }

  TradeSign lastSign() const { return last_sign_; }

private:
  TradeSign last_sign_ = TradeSign::NEUTRAL;
};

// ---------------------------------------------------------------------------
// Spread decomposition
// ---------------------------------------------------------------------------
class SpreadDecomposition {
public:
  void recordTrade(double price, double mid, double mid_5min_later) {
    double realized   = price - mid_5min_later;
    double adverse    = mid_5min_later - mid;
    double spread     = price - mid;
    // Realized = revenue for liquidity provider
    // Adverse selection = loss due to informed trading

    realized_sum_ += realized;
    adverse_sum_  += adverse;
    spread_sum_   += spread;
    count_++;
  }

  struct Decomposition {
    double avg_realized_spread;
    double avg_adverse_selection;
    double avg_half_spread;
  };

  Decomposition current() const {
    if (count_ == 0) return {};
    return {
      realized_sum_ / count_,
      adverse_sum_  / count_,
      spread_sum_   / count_
    };
  }

private:
  double realized_sum_ = 0;
  double adverse_sum_  = 0;
  double spread_sum_   = 0;
  uint64_t count_ = 0;
};
```
