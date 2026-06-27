---
type: reference
title: "Exchange Market Model Comparison"
description: "Price-time vs pro-rata matching, maker-taker vs taker-maker fee models, market order handling, volatility interruptions, circuit breakers, LULD mechanics, and auction formats across CME, Eurex, ICE, Nasdaq, and NYSE."
tags: ["exchange-protocols"]
difficulty: advanced
timestamp: "2026-06-27T03:30:00.000Z"
phase: 8
phaseName: "Exchange Architecture"
category: "Exchange Architecture"
subcategory: "exchange-architecture"
language: "cpp"
artifact-id: "ZHFT_MARKET_MODEL_COMPARISON"
---
## Key Learning Points

- Matching algorithms: price-time (first at price, first in queue) vs pro-rata (all orders at price fill proportionally); CME uses pro-rata+top for most products, Eurex uses price-time for options and pro-rata for futures
- Maker-taker: maker (adds liquidity) gets rebate, taker (removes) pays fee; taker-maker: inverted model (maker pays, taker gets rebate); Nasdaq uses maker-taker, NYSE uses taker-maker for certain securities
- Market order handling: CME rejects market orders in some products (must use market-to-limit), Eurex accepts IOC market orders, Nasdaq/NYSE accept market orders with price protection
- Volatility interruptions: CME uses Velocity Logic (5s lookback price band), Eurex uses volatility interruption (dynamic price range), ICE uses LIS (Liquidity Interruption Signal), Nasdaq uses LULD (Limit Up-Limit Down)
- LULD mechanics: bands widen from 5% to 20% in steps; trading pauses of 15s-5min depending on tier; linked to SIP price feed across all US equities exchanges
- Auction formats: opening (order imbalance driven), closing (MOC on CME, closing cross on Nasdaq), volatility auctions (Eurex), IPO auctions; each has different imbalance disclosure rules
- Fee benchmarks: CME membership tiered, Eurex volume-tiered rebates, ICE flat+rebate, Nasdaq/NYSE SEC-mandated access fees cap ($0.003/share)

## Usage

```cpp
// Fee model comparison (example)
struct FeeModel {
    double maker_rebate_;  // negative = rebate
    double taker_fee_;

    double roundTripCost(size_t qty, double price) const {
        return qty * price * (taker_fee_ - maker_rebate_);
    }
};

// Quick reference table
// ┌────────────┬──────────────┬──────────────┬──────────────────┐
// │ Exchange   │ Matching     │ Fee Model    │ Volatility       │
// ├────────────┼──────────────┼──────────────┼──────────────────┤
// │ CME        │ Pro-rata+top │ Taker/member │ Velocity Logic   │
// │ Eurex      │ Price-time   │ Volume tiers │ Vola Interrupt   │
// │ ICE        │ Pro-rata     │ Flat+rebate  │ LIS              │
// │ Nasdaq     │ Price-time   │ Maker-taker  │ LULD             │
// │ NYSE       │ Price-time   │ Taker-maker  │ LULD             │
// └────────────┴──────────────┴──────────────┴──────────────────┘
```

## Source Code

```cpp
// Matching engine simulation parameters
struct ExchangeModel {
    enum MatchType { PRICE_TIME, PRO_RATA, PRO_RATA_TOP };
    enum FeeModelType { MAKER_TAKER, TAKER_MAKER, MEMBER_TIERED };

    MatchType match_;
    FeeModelType fees_;
    bool accepts_market_orders_;
    double vola_band_pct_;    // e.g. 5% for Velocity Logic
    int vola_pause_seconds_;  // e.g. 15 for LULD
};
```
