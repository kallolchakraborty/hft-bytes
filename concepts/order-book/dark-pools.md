---
type: reference
title: "Dark Pools & Alternative Liquidity"
description: "Dark pool matching preferences (size-only, time-at-size, conditional, continuous), dark-to-lit sweep logic, midpoint peg orders, ATS/ECN comparison, dark liquidity detection indicators, and SOR integration for dark venues."
tags: ["market-data", "trading"]
difficulty: staff
timestamp: "2026-06-27T03:40:00.000Z"
phase: 9
phaseName: "Order Book & Microstructure"
category: "Order Book"
subcategory: "order-book"
language: "cpp"
artifact-id: "ZHFT_DARK_POOLS"
---
## Key Learning Points

- Dark pool types: ATS-operated (UBS ATS, Credit Suisse Crossfinder, Goldman Sachs Sigma X) vs exchange-operated (NYSE Dark, Nasdaq BX Dark); ~40% of US equity volume trades off-exchange
- Matching preferences: each dark pool uses distinct matching logic — size-only (match only when order size matches displayed interest), time-at-size (first to submit at a given size gets priority), conditional (negotiated, not automatic), continuous (price-time like lit, but dark)
- Dark-to-lit sweep: SQR (Standard Quote Router) sends a sweep order to all dark pools and then the lit exchange as a single logical operation; NMS requires best execution regardless of venue
- Midpoint peg: order pegs to the midpoint of NBBO; no spread cost, but no price improvement either; order may not fill if NBBO spread is wide (no midpoint stability)
- Conditional orders: indication of interest (IOI) sent when two contra-side conditional orders overlap; negotiation/confirmation before execution; used for large-in-scale (LIS) blocks
- Dark liquidity detection: repetitive small dark prints at the same price may indicate a hidden iceberg; large dark print followed by lit price move indicates informed flow; NBBO bounce frequency as dark presence proxy
- SOR integration: route order to dark pool first (midpoint save), if unfilled within N ms, sweep to lit; configurable per-symbol based on historical dark fill probability

## Usage

```cpp
// Dark pool SOR routing
struct DarkSOR {
    struct Venue {
        std::string name_;         // "UBS ATS", "CS Crossfinder"
        double fill_prob_mid_;     // P(fill) at midpoint
        double latency_us_;        // round-trip to venue
        bool is_exchange_;         // lit exchange or dark pool
    };

    int selectVenue(const Order& order, const std::vector<Venue>& venues) {
        // To dark first (midpoint save), then lit
        for (const auto& v : venues) {
            if (v.is_exchange_) continue;
            if (v.fill_prob_mid_ > 0.05)  // >= 5% fill probability
                return &v - &venues[0];
        }
        // No dark venue with sufficient probability — go to lit
        for (const auto& v : venues) {
            if (v.is_exchange_) return &v - &venues[0];
        }
        return -1;
    }
};

// Midpoint peg order
struct MidpointPeg {
    double midpoint() const { return (nbbid_ + nboffer_) / 2.0; }
    bool isPegValid() const {
        return nboffer_ - nbbid_ < MAX_SPREAD_TICKS;  // dont peg on wide spread
    }
};
```

## Source Code

```cpp
// Major US equity dark pools (approx market share, 2026)
// UBS ATS:           ~5% equity volume
// Credit Suisse CX:  ~4%
// Goldman Sachs SX:  ~3%
// Virtu POS:         ~3%
// CitiMatch:         ~3%
// JP Morgan Xist:   ~2%
// NYSE Dark:         ~2%
// Nasdaq BX Dark:   ~2%

// Dark pool fill probability signal model:
// P(fill) = sigmoid(a * depth_at_mid + b * spread_bps + c * time_to_close)
// Calibrated per-symbol per-venue from historical fill data

// Lit-to-dark sweep order (NMS intermarket sweep):
// Send to all dark pools + primary exchange simultaneously
// Cancel unfilled legs once first fill received
```
