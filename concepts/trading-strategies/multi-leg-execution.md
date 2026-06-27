---
type: reference
title: "Multi-Leg Order Execution"
description: "Spread trading, combination orders, implied pricing (CME implied IN/OUT), calendar spreads, order-book construction for multi-leg instruments, and risk management for multi-leg positions."
tags: ["trading"]
difficulty: staff
timestamp: "2026-06-27T03:20:00.000Z"
phase: 10
phaseName: "Trading Strategies"
category: "Trading Strategies"
subcategory: "trading-strategies"
language: "cpp"
artifact-id: "ZHFT_MULTI_LEG_EXECUTION"
---
## Key Learning Points

- Multi-leg order types: spreads (calendar, inter-commodity, butterfly, condor), straddles/strangles (options), stock + option combo; each is a single order with 2+ legs
- Leg pricing convention: spread price = price of leg 1 - price of leg 2 (e.g., calendar spread = near month - far month); ratio defined per instrument (e.g., 1:1, 2:1)
- CME implied pricing: implied IN (spread order implies legs) and implied OUT (leg orders imply spread); creates synthetic liquidity; adds order-book complexity in matching engine
- Calendar spread book: CME maintains a dedicated order book for each listed spread; price is the net differential; book depth is typically thinner than outrights
- Order management: multi-leg order must send leg fills simultaneously (or fail atomically); partial fills on spread orders are rare but possible if exchange supports it
- Implied pricing algorithm: matching engine periodically scans outright books for tradable combinations; generates implied orders on the spread book and vice versa
- Risk: leg hedge ratios must be managed; if one leg fills and the other doesn't (partial fill scenario), residual risk must be hedged immediately

## Usage

```cpp
// Calendar spread order representation
struct MultiLegOrder {
    struct Leg {
        std::string symbol_;
        uint32_t ratio_;   // e.g., 1 for near month
        Side side_;        // Buy leg or Sell leg
        double price_;     // leg limit price (if not spread-priced)
    };
    std::vector<Leg> legs_;
    double spread_price_;  // net differential price for the combination
    OrderType type_;       // e.g., SPREAD, COMBO, STRADDLE

    // For CME calendar spread:
    // Leg 1: Buy ESZ6 (ratio: 1)
    // Leg 2: Sell ESH7 (ratio: 1)
    // spread_price = Bid(ESZ6) - Ask(ESH7)
};

// Implied pricing logic (simplified)
// Given outright book for near: Bid(1001) Ask(1003)
// Given outright book for far:  Bid(995)  Ask(997)
// Implied spread bid = Bid(near) - Ask(far) = 1001 - 997 = 4
// Implied spread ask = Ask(near) - Bid(far) = 1003 - 995 = 8
// These implied quotes appear on the spread book
struct ImpliedPricing {
    static double impliedBid(double near_bid, double far_ask) {
        return near_bid - far_ask;
    }
    static double impliedAsk(double near_ask, double far_bid) {
        return near_ask - far_bid;
    }
};
```

## Source Code

```cpp
// CME futures spread notation
// Calendar spread:  ESH7-ESZ6  (Mar 2027 vs Dec 2026)
// Inter-commodity:  ESH7-NQH7  (ES vs NQ spread)
// Butterfly:        ESZ6-ESH7-ESM7 (Dec-Mar-Jun butterfly)
// Price in ticks:  2.5 ticks = 5 half-ticks on ES

// Risk check: leg fill ratio management
struct LegFillTracker {
    uint32_t filled_legs_ = 0;
    uint32_t total_legs_;
    std::vector<LegFill> fills_;

    bool isFullyFilled() const { return filled_legs_ == total_legs_; }
    // On partial fill with exchange rejection of remaining legs,
    // immediately hedge the filled leg(s)
};
```
