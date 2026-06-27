---
type: reference
title: "Cross-Exchange Latency Arbitrage"
description: "Tick-to-trade latency measurement, exchange timestamp provenance, arb detection probability, microwave vs fiber path case studies (Chicago-NJ, London-Frankfurt), co-location distance arbitrage, and latency leaderboard maintenance."
tags: ["trading"]
timestamp: "2026-06-27T03:30:00.000Z"
phase: 10
phaseName: "Trading Strategies"
category: "Trading Strategies"
subcategory: "trading-strategies"
language: "cpp"
artifact-id: "ZHFT_LATENCY_ARB"
---
## Key Learning Points

- Tick-to-trade latency: time from a price change on exchange A to the resulting order arriving at exchange B; decompose into: packet propagation A → colo → parse → strategy → OMS → FIX → packet propagation B
- Exchange timestamp provenance: CME timestamps at matching engine (PTP), Nasdaq timestamps at SIP (SG), Eurex timestamps at gateway (PTP); each has different accuracy (±100ns to ±1μs)
- Arb probability: arb exists when price on B is stale relative to A for longer than tick-to-trade latency + exchange B round-trip; probability = P(|price_A - price_B| > spread_before latency_window)
- Microwave vs fiber paths: Chicago-NY: fiber ~7.4ms, microwave ~4.3ms (save ~3ms); London-Frankfurt: fiber ~4.5ms, microwave ~2.1ms (save ~2.4ms); microwave still requires conversion at endpoints
- Co-location distance arb: exchange A matching engine in same facility as B gives ~5μs cross-connect; across facilities (e.g., NY4 to NY11) adds ~50-200μs; across metros adds milliseconds
- Latency leaderboard: firms continuously measure and compare tick-to-trade latency; target is top quartile; publish pseudonymous rankings; drives colo and hardware investment decisions

## Usage

```cpp
// Arb detection window
struct LatencyArb {
    struct Path {
        double one_way_us_;
        std::string exchange_a_;
        std::string exchange_b_;
    };

    // Given price update on A, is B stale enough to trade?
    bool detectArb(const Path& path, double bid_a, double ask_a,
                   double bid_b, double ask_b, double round_trip_b_us) {
        // Theoretical fastest arb: A price → B order (one-way path) + B fill (round-trip)
        double min_arb_time_us = path.one_way_us_ + round_trip_b_us;
        // Is B's price stale enough?
        double fair_b_mid = (bid_a + ask_a) / 2;
        double stale_b_mid = (bid_b + ask_b) / 2;
        double arb_window = /* time since last B update */;
        return arb_window > min_arb_time_us &&
               std::abs(fair_b_mid - stale_b_mid) > (ask_b - bid_b) * 0.5;
    }
};

// Known paths (approximate one-way, 2026)
// CME Cermak → NY4:         7,100 us (fiber)
// CME Cermak → NY4:         4,100 us (microwave)
// FR2 (Frankfurt) → LD4:    4,500 us (fiber)
// FR2 (Frankfurt) → LD4:    2,100 us (microwave)
// NY4 → NY11:                  60 us (dark fiber)
// NY4 cross-connect:            5 us (direct cage-to-cage)
```

## Source Code

```cpp
// Latency measurement framework
struct LatencyProbe {
    uint64_t tick_to_order_ns_;
    uint64_t tick_to_fill_ns_;

    void measure() {
        auto start = hardwareTimestamp(); // PTP or RDTSC
        // 1. Market data packet arrives at NIC
        // 2. Parse → book update → strategy → OMS
        // 3. FIX encode → NIC transmit
        auto end = hardwareTimestamp();
        tick_to_order_ns_ = end - start;
    }
};

// Exchange timestamp sources
// CME   : PTP (IEEE 1588) at matching engine → ±100ns
// Nasdaq: SG (Self-contained GPS) at SIP → ±100ns
// Eurex : PTP at gateway → ±200ns
// ICE   : NTP at gateway → ±1ms (no PTP)
// NYSE  : PTP at matching engine → ±100ns
```
