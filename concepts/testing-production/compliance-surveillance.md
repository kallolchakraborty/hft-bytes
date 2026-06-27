---
type: reference
title: "Compliance & Surveillance Technology"
description: "CAT reporting format and submission, market manipulation detection (spoofing, layering, wash trading), trade reconstruction for regulatory exams, OATS for options, best-execution monitoring infrastructure, audit trail system architecture."
tags: ["compliance"]
difficulty: advanced
timestamp: "2026-06-27T03:50:00.000Z"
phase: 15
phaseName: "Testing & Production"
category: "Testing & Production"
subcategory: "testing-production"
language: "cpp"
artifact-id: "ZHFT_COMPLIANCE_SURVEILLANCE"
---
## Key Learning Points

- CAT (Consolidated Audit Trail): FINRA-mandated system capturing every order event (new, mod, cancel, fill, reject) with timestamps accurate to < 1ms; reports submitted in CAT format (JSON/XML via SFTP); covers all NMS stocks and OTC equities
- Wash-trade detection: same beneficial owner on both sides of a trade; indicator: matching buy/sell orders from same firm at same price/size with no economic purpose; real-time detection blocks orders pre-trade
- Spoofing/layering detection: orders placed with intent to cancel before execution (creates false impression of demand); signals: cancel-to-fill ratio > 20:1, order lifetime < 100ms consistently, price levels that move market then cancel
- Trade reconstruction: regulatory request requires full audit trail for a given symbol/time window; pipeline replays order events from log archive; output includes all order modifications, fills, cancels with microsecond timestamps
- OATS (Order Audit Trail System): for options; captures order origination, routing, modification, cancellation, and execution; reports via FIX or proprietary format
- Best-execution monitoring: compare fill price to NBBO at time of order; flag fills outside NBBO (exchange-awarded price improvement excluded); monthly best-execution report for compliance

## Usage

```cpp
// Spoofing detection
struct SpoofingDetector {
    struct OrderEvent {
        uint64_t ts_ns_;
        uint64_t order_id_;
        double price_;
        uint64_t qty_;
        bool is_cancel_;
    };
    std::unordered_map<uint64_t, OrderEvent> active_orders_;

    // Signal: cancel-to-fill ratio > threshold
    bool isSuspicious(const std::string& trader) {
        auto stats = traderStats(trader);
        double ratio = stats.cancels_ / static_cast<double>(stats.fills_ + 1);
        // Cancel within 100ms of placement = spoofing indicator
        return ratio > 20.0;
    }
};

// CAT report event (simplified)
struct CATReport {
    std::string order_id_;
    std::string firm_id_;
    std::string symbol_;
    char side_;               // B/S/SHORT/SSHORT
    uint64_t order_qty_;
    double price_;
    uint64_t event_timestamp_; // nanosecond since epoch
    std::string event_type_;   // NEW, MOD, CAN, FIL, REJ
    std::string prev_order_id_; // for modifications
};

// Wash-trade check
bool isWashTrade(const Order& buy, const Order& sell) {
    return buy.account_id_ == sell.account_id_ &&
           buy.symbol_ == sell.symbol_ &&
           buy.price_ == sell.price_ &&
           buy.qty_ == sell.qty_ &&
           buy.ts_ + 100'000 > sell.ts_;  // within 100us
}
```

## Source Code

```cpp
// CAT report submission pipeline
// Strategy → OMS → Order events logged to Kafka topic "cat-events"
// CAT reporter consumes topic, builds CAT JSON records
// Batched every 15 seconds → compressed → SFTP to FINRA CAT portal
// Monitor: report acknowledgment (ACK/NAK) within 60 seconds

// Best-execution check:
// bool isBestExecution(const Fill& f, const NBBO& nbbo_at_time) {
//     // Allow price improvement (midpoint, dark pool fill)
//     if (f.side_ == BUY && f.price_ > nbbo_at_time.ask_) return false;
//     if (f.side_ == SELL && f.price_ < nbbo_at_time.bid_) return false;
//     return true;
// }
```
