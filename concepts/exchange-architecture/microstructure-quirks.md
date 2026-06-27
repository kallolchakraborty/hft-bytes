---
type: reference
title: "Exchange Microstructure Quirks"
description: "Exchange-specific edge cases: CME calendar spread implied pricing with butterflies, Nasdaq Nordic vs US market model differences, ICE block trade minimum sizes, Eurex T7 entry service login timing, LSE SETSqx mechanics, and other veteran-known 'gotchas.'"
tags: ["exchange-protocols"]
difficulty: advanced
timestamp: "2026-06-27T04:00:00.000Z"
phase: 8
phaseName: "Exchange Architecture"
category: "Exchange Architecture"
subcategory: "exchange-architecture"
language: "cpp"
artifact-id: "ZHFT_MICROSTRUCTURE_QUIRKS"
---
## Key Learning Points

- CME calendar spread implied pricing: 3-legged butterfly (e.g., ESZ6-ESH7-ESM7) creates complex implied IN/OUT chains; a fill on one leg of a butterfly can trigger implied orders on 3 different outright books simultaneously; partial fills on multi-leg spreads can leave orphaned implied orders
- Nasdaq Nordic vs US: Nordic markets (Stockholm, Copenhagen, Helsinki) use a different market model — auction-only for 30 minutes at open, continuous trading with volatility auctions, and different order types than Nasdaq US; INET order book vs Genium INET transition quirks
- ICE block trade mechanics: minimum block size varies by product (e.g., 50 lots for Brent vs 10 for Gasoil) and changes intraday relative to market conditions; block trade reporting deadline is 3 minutes in most ICE products (vs 5 min for Eurex)
- Eurex T7 entry service: mandatory GapFill before trading after reconnection; exchange sends all missed messages since last seqno; firm must process GapFill before sending any new orders — trading during GapFill is a regulatory violation
- LSE SETSqx: periodic auction book for less liquid securities; auctions run every 10-60 minutes depending on symbol; no continuous trading during auction periods; order types differ from SETS (continuous) — no icebergs, no pegged orders in SETSqx
- CME STP (Straight-Through Processing) flag: exchange rejects orders with invalid STP flag combinations; STP = 1 (self-match prevention), STP = 2 (different accounts), STP = 3 (same account, different sub-account); wrong STP flag causes silent rejection

## Usage

```cpp
// CME implied pricing chain example
// Given outright books:
// Near:  Bid(4521.00) Ask(4521.50)
// Far:   Bid(4518.00) Ask(4518.50)
// Calendar spread implied: Bid(2.50) Ask(3.50)
// Butterfly implied from: Near - Mid(2) + Far
struct ImpliedChain {
    bool isButterfly() const;
    // Edge case: butterfly fill on leg 1 may imply
    // 2 separate calendar spreads simultaneously
};

// Eurex T7 reconnection flow:
// 1. Connect TCP → send Logon
// 2. Receive Logon Ack + sequence number
// 3. Exchange sends GapFill (all missed messages)
// 4. Wait for GapFillEnd message
// 5. Only then send ResendRequest (if gaps remain) or start trading
// ⚠ Sending orders before step 4 = violation

// ICE block trade minimum size check:
struct ICEBlockCheck {
    bool isBlockEligible(uint64_t qty, const std::string& product) {
        // Block minimum: Brent=50, Gasoil=10, WTI=25, NatGas=10
        // Thresholds can change intraday based on OI
        static const std::unordered_map<std::string, int> MIN_BLOCK = {
            {"B", 50}, {"QG", 10}, {"CL", 25}, {"NG", 10}
        };
        return qty >= MIN_BLOCK.at(product);
    }
};
```

## Source Code

```cpp
// CME STP flag handling
// enum STP_FLAG { SELF=1, ACCOUNT=2, SUB_ACCOUNT=3 };
// // STP=SELF: prevents matching own orders in same account
// // STP=ACCOUNT: prevents matching across accounts in same firm
// // STP=SUB_ACCT: prevents matching within sub-accounts
// // Wrong flag → exchange rejects with "InvalidSTPFlag" (371=118)

// Nasdaq Nordic volatility auction parameters:
// Stock:  Static Price Range (5-20%), Dynamic Price Range (2-10%)
// Auction: 5 min duration, no order cancellation in last 30s
```
