---
type: reference
title: "Microstructure Edge"
description: "Odd lots vs round lots: odd lots (< 100 shares on NYSE) trade. Tick-constrained instruments: when minimum price increment"
tags: ["phase-9"]
timestamp: "2026-06-27T03:06:09.435Z"
phase: 9
phaseName: "Order Book & Microstructure"
category: "Phase 9 - Order Book & Microstructure"
subcategory: "order-book"
language: "cpp"
artifact-id: "ZHFT_MICROSTRUCTURE_EDGE"
---
## Key Learning Points

- Odd lots vs round lots: odd lots (< 100 shares on NYSE) trade
- Tick-constrained instruments: when minimum price increment
- Short sale restrictions (Reg SHO): Rule 201 — if stock drops
- Trading halts and LULD (Limit Up/Limit Down): SEC's market-wide
- Auction mechanics: open/close/volatility/imbalance auctions

## Usage

// ShortSaleRestrictionChecker ssrc;
// ssrc.updateNBBO(150.25, 150.30);
// if (ssrc.isRestricted("AAPL")) { /* only short at +0 uptick */ }

## Source Code

```cpp
*   //
 *   // LuldCalculator luld;
 *   // auto band = luld.computeBands(last_price, 0.05);
 *   // // band = {lower: 142.74, upper: 157.78} (5% bands)
 *
 * PERFORMANCE TARGET:
 *   Short sale check < 50 ns; LULD band < 100 ns
 * ====================================================================
 */

#include <algorithm>
#include <array>
#include <bit>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <string_view>
#include <unordered_map>
#include <vector>

// ---------------------------------------------------------------------------
// Lot size reference table
// ---------------------------------------------------------------------------
/* REFERENCE TABLE: Lot Sizes by Product
 *
 * +-------------------+----------+----------+---------------------------+
 * | Product           | Lot Size | Odd Lot  | Notes                    |
 * +-------------------+----------+----------+---------------------------+
 * | US Equities       | 100 sh   | < 100    | Odd lots trade at         |
 * | (NYSE, NASDAQ)    |          |          | reduced priority          |
 * | US ETFs           | 100 sh   | < 100    | Same as equities          |
 * | ES (S&P E-mini)   | 1        | N/A      | Full contract = 1 lot     |
 * | NQ (Nasdaq-100)   | 1        | N/A      | Full contract = 1 lot     |
 * | CL (Crude Oil)    | 1        | N/A      | 1,000 barrels             |
 * | ZN (10yr Note)    | 1        | N/A      | $100,000 face value       |
 * | FGBL (Bund)       | 1        | N/A      | Eurex, €100,000 face      |
 * | NQ options        | 1        | N/A      | Mini-options: 10 shares   |
 * +-------------------+----------+----------+---------------------------+
 */

// ---------------------------------------------------------------------------
// Short Sale Restriction (Reg SHO) checker
// ---------------------------------------------------------------------------
class ShortSaleRestrictionChecker {
public:
  // Update NBBO for symbol
  void updateNBBO(std::string_view symbol, double bid, double ask) {
    auto &state = states_[std::string(symbol)];
    state.bid = bid;
    state.ask = ask;
  }

  // Record price drop to detect triggered restriction
  void recordTrade(std::string_view symbol, double price) {
    auto &state = states_[std::string(symbol)];
    if (state.reference_price == 0) {
      state.reference_price = price;
      return;
    }

    // Check for 10% drop (Reg SHO trigger)
    double drop = (state.reference_price - price) / state.reference_price;
    if (drop >= 0.10) {
      // CRITICAL: Reg SHO Rule 201 triggered
      // Short selling only permitted above current NBBO
      state.restricted = true;
      state.restriction_time = std::chrono::steady_clock::now();
      state.reference_price = price; // reset reference
    }
  }

  // Can we short at given price?
  bool canShort(std::string_view symbol, double short_price) {
    auto &state = states_[std::string(symbol)];
    if (!state.restricted) return true;

    // Reg SHO: short sale only above NBBO (uptick rule)
    // TRADEOFF: some exchanges also prohibit short at NBBO if
    // the NBBO is a downtick from last sale
    return short_price > state.ask;
  }

  // Clear restriction after end of day / next trading day
  void clearRestriction(std::string_view symbol) {
    auto &state = states_[std::string(symbol)];
    state.restricted = false;
    state.reference_price = 0;
  }

private:
  struct RegSHOState {
    double bid = 0;
    double ask = 0;
    double reference_price = 0;
    bool   restricted = false;
    std::chrono::steady_clock::time_point restriction_time;
  };

  std::unordered_map<std::string, RegSHOState> states_;
};

// ---------------------------------------------------------------------------
// LULD (Limit Up/Limit Down) price band calculator
// ---------------------------------------------------------------------------
class LuldCalculator {
public:
  static constexpr double kBandPct_Tier1 = 0.05;  // 5% for Tier 1 stocks
  static constexpr double kBandPct_Tier2 = 0.10;  // 10% for Tier 2 stocks
  static constexpr double kBandPct_Other = 0.15;  // 15% for <$3 stocks

  struct PriceBands {
    double lower;
    double upper;
    double reference;
  };

  // Compute LULD price bands based on reference price
  PriceBands computeBands(double reference_price, bool is_tier1 = true,
                            double extended_hours = false) const {
    double band_pct = is_tier1 ? kBandPct_Tier1 :
        (reference_price < 3.0 ? kBandPct_Other : kBandPct_Tier2);

    if (extended_hours) {
      // TRADEOFF: extended hours (pre-market, after-hours) have
      // wider bands (typically 2x) due to lower liquidity
      band_pct *= 2.0;
    }

    // CRITICAL: LULD bands are recalculated per 30-second interval
    // using the 5-second average price over the last 30 seconds.
    // Simplified here.
    return {
      reference_price * (1.0 - band_pct),
      reference_price * (1.0 + band_pct),
      reference_price
    };
  }

  // Check if price is within LULD bands
  bool isWithinBand(double price, const PriceBands &bands) const {
    return price >= bands.lower && price <= bands.upper;
  }

  // Remaining time in a trading halt (standard: 5 min)
  uint64_t haltDurationSec() const { return 300; }

  // Extensions: if volatility auction imbalance > 10%, additional
  // 5-min auction period (in some markets)
};

// ---------------------------------------------------------------------------
// Trading halt state machine
// ---------------------------------------------------------------------------
class TradingHaltManager {
public:
  enum class HaltState : uint8_t {
    Normal,
    LuldBreach,         // Price outside band
    HaltCall,           // Exchange notified halt
    AuctionPeriod,      // Volatility auction
    Reopening,          // Uncrossing in progress
    Resumed,            // Trading resumed
  };

  void onLuldBreach(std::string_view symbol) {
    states_[std::string(symbol)] = HaltState::LuldBreach;
    halt_start_ = std::chrono::steady_clock::now();
  }

  void onAuctionStart(std::string_view symbol) {
    states_[std::string(symbol)] = HaltState::AuctionPeriod;
    // Start indicative price publication
  }

  void onAuctionComplete(std::string_view symbol) {
    states_[std::string(symbol)] = HaltState::Resumed;
  }

  HaltState state(std::string_view symbol) const {
    auto it = states_.find(std::string(symbol));
    return it != states_.end() ? it->second : HaltState::Normal;
  }

  // Time remaining in halt
  uint64_t haltRemainingSec() const {
    auto elapsed = std::chrono::duration_cast<std::chrono::seconds>(
        std::chrono::steady_clock::now() - halt_start_).count();
    return (elapsed >= 300) ? 0 : 300 - elapsed;
  }

private:
  std::unordered_map<std::string, HaltState> states_;
  std::chrono::steady_clock::time_point halt_start_;
};
```
