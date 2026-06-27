---
type: reference
title: "Order Types"
description: "Limit, market, IOC, FOK, pegged, iceberg, and hidden orders. Exchange-specific semantics: CME iceberg vs Eurex iceberg, NASDAQ pegged vs displayed. Queue position implications for fill probability."
tags: ["order-types"]
timestamp: "2026-06-27T03:06:09.425Z"
phase: 7
phaseName: "Order Entry & Execution"
category: "Phase 7 - Order Entry & Execution"
subcategory: "order-entry"
language: "cpp"
artifact-id: "ZHFT_ORDER_TYPES"
---
## Key Learning Points

- Limit orders provide price certainty but execution uncertainty; liquidity rebates (maker/taker model) incentivise limit orders
- Market orders provide execution certainty but price uncertainty; taker fees apply
- IOC (Immediate-or-Cancel) fills against resting liquidity then cancels remainder; used for aggressive fills without resting
- FOK (Fill-or-Kill) must fill entirely or cancels entirely; used for large executions requiring no partial fill
- Pegged orders (primary/market/pegged-to-mid) track the NBBO; avoid adverse selection during fast markets
- Iceberg orders display only a slice of total quantity; reduce market impact but signal hidden size to algos
- Hidden / non-displayed orders rest in the book without visible presence; priority after displayed orders at same price
- Queue position determines fill probability: front-of-queue ~100% in liquid names, rear-of-queue near 0% in fast markets

## Usage

```cpp
enum class OrderType : uint8_t {
    LIMIT,        // rests at limit price
    MARKET,       // fills at prevailing price
    IOC,          // Immediate-or-Cancel
    FOK,          // Fill-or-Kill
    PEGGED_MID,   // pegged to midpoint
    PEGGED_PRIMARY, // pegged to primary (best) bid/ask
    ICEBERG,      // visible + hidden quantity
    HIDDEN        // fully non-displayed
};

enum class TimeInForce : uint8_t {
    DAY,
    GTC,           // Good-Til-Cancelled
    IOC,           // Immediate-or-Cancel
    FOK,           // Fill-or-Kill
    GTD,           // Good-Til-Date
    AT_THE_OPEN,
    AT_THE_CLOSE
};

struct Order {
    uint64_t    client_id;
    Side        side : 2;
    OrderType   type : 3;
    TimeInForce tif  : 3;
    double      price;
    uint32_t    quantity;
    uint32_t    display_qty;     // 0 for hidden, < quantity for iceberg
    uint32_t    min_qty;         // for FOK
};

// CME-specific: Iceberg with 10 visible, 990 hidden
// Eurex-specific: Iceberg with peak size and randomisation
```
