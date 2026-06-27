---
type: decision-matrix
title: "Top Of Book"
description: "Bandwidth/latency tradeoff: Top-of-book (ToB) = 2 price+size. Full book parsing cost: processing 100 levels takes ~1-2 us"
tags: ["phase-9"]
difficulty: intermediate
timestamp: "2026-06-27T03:06:09.436Z"
phase: 9
phaseName: "Order Book & Microstructure"
category: "Phase 9 - Order Book & Microstructure"
subcategory: "order-book"
language: "cpp"
artifact-id: "ZHFT_TOP_OF_BOOK"
---
## Key Learning Points

- Bandwidth/latency tradeoff: Top-of-book (ToB) = 2 price+size
- Full book parsing cost: processing 100 levels takes ~1-2 us
- Information content: full book provides order flow pressure,
- Quote stuffing identification: rapid order add/cancel on same
- Book depth relevance by strategy:

## Usage

// StrategyBookFit fit;
// fit.evaluate(StrategyType::MARKET_MAKING);
// auto result = fit.recommend(); // "full-book"

## Source Code

```cpp
#include <algorithm>
#include <array>
#include <bit>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <string_view>
#include <vector>

// ---------------------------------------------------------------------------
// Bandwidth calculator
// ---------------------------------------------------------------------------
class BandwidthCalculator {
public:
  struct BandwidthEstimate {
    double mbps;        // Megabits per second
    uint64_t msgs_per_sec;
    double parse_time_us; // Per message
  };

  // Estimate bandwidth for ToB vs full book
  // Assumes: 100,000 updates/sec (active futures contract at peak)
  static BandwidthEstimate estimate(bool full_book, uint64_t updates_per_sec = 100000) {
    // ToB: ~50 bytes (bid px, bid sz, ask px, ask sz, seq)
    // Full: ~500 bytes (10 levels × 2 sides × 25 bytes)
    size_t msg_size = full_book ? 500 : 50;
    double mbps = (msg_size * 8.0 * updates_per_sec) / 1'000'000.0;
    double parse_us = full_book ? 1.5 : 0.1; // microseconds

    return {mbps, updates_per_sec, parse_us};
  }

  // Savings from ToB vs full book
  struct Savings {
    double bandwidth_pct;
    double parse_time_pct;
    double info_loss; // subjective
  };

  static Savings computeSavings() {
    auto full = estimate(true);
    auto tob  = estimate(false);
    return {
      (full.mbps - tob.mbps) / full.mbps * 100.0,
      (full.parse_time_us - tob.parse_time_us) / full.parse_time_us * 100.0,
      0.35 // ~35% information loss (heuristic)
    };
  }
};

// ---------------------------------------------------------------------------
// Book depth analyzer
// ---------------------------------------------------------------------------
class BookDepthAnalyzer {
public:
  struct DepthSignal {
    double toB_bid_ask_gap;
    uint64_t total_bid_depth_10levels;
    uint64_t total_ask_depth_10levels;
    double imbalance_10levels;
    bool   has_iceberg_cluster;
    uint64_t cancel_to_order_ratio; // quote stuffing indicator
  };

  DepthSignal analyze(bool use_full_book) {
    if (!use_full_book) {
      // ToB only: can only compute basic bid/ask
      return {/* bid_ask_gap */ 0.25, 0, 0, 0, false, 0};
    }
    // Full book: comprehensive analysis
    return {/* bid_ask_gap */ 0.25, 50000, 48000, 0.02, true, 3};
  }
};

// ---------------------------------------------------------------------------
// Strategy-book fit matrix
// ---------------------------------------------------------------------------
/* MATRIX: Strategy vs Book Depth Fit
 *
 * +-------------------+------------+--------------+-------------------+
 * | Strategy          | Book Depth | Why?         | Info Value        |
 * +-------------------+------------+--------------+-------------------+
 * | Market Making     | Full       | Walls,       | Critical          |
 * |                   | (10+ lvl)  | icebergs,    | (positioning)     |
 * |                   |            | imbalance    |                   |
 * | Arbitrage         | ToB        | Price diff   | Sufficient        |
 * | (lat arb, ETF)    |            | only needed  |                   |
 * | Momentum          | Full       | Order flow,  | Important         |
 * |                   | (5-10 lvl) | accumulation |                   |
 * | Mean Reversion    | ToB        | Signal from  | Usually enough    |
 * |                   |            | bid/ask only |                   |
 * | Statistical Arb   | ToB        | Cross-       | Sufficient        |
 * |                   |            | sectional   |                   |
 * | Iceberg Detection | Full       | Inherently   | Requires          |
 * |                   | (all)      | needs depth  | full depth        |
 * | Quote Stuffing    | Full       | Pattern      | Requires          |
 * | Detection         | (all)      | at same level| full depth        |
 * | VPIN / Flow Tox   | Full       | Volume at    | Better with       |
 * |                   | (5+ lvl)   | each level   | full depth        |
 * +-------------------+------------+--------------+-------------------+
 *
 * Recommendation:
 *   - If <= 1 Gbps bandwidth: use ToB + occasional depth snapshot
 *   - If >= 10 Gbps: use full book (10 levels) always
 *   - Hybrid: subscribe to ToB incremental + full book snapshot every 1ms
 */

enum class StrategyType : uint8_t {
  MARKET_MAKING,
  ARBITRAGE,
  MOMENTUM,
  MEAN_REVERSION,
  STAT_ARB,
};

class StrategyBookFit {
public:
  struct Recommendation {
    bool   use_full_book;
    uint8_t depth_levels;
    std::string_view reason;
  };

  Recommendation recommend(StrategyType type) const {
    switch (type) {
    case StrategyType::MARKET_MAKING:
      return {true, 10, "Need walls, icebergs, imbalance"};
    case StrategyType::ARBITRAGE:
      return {false, 1, "Price diff only needs ToB"};
    case StrategyType::MOMENTUM:
      return {true, 5, "Order flow requires some depth"};
    case StrategyType::MEAN_REVERSION:
      return {false, 1, "ToB usually sufficient"};
    case StrategyType::STAT_ARB:
      return {false, 1, "Cross-sectional, ToB enough"};
    default:
      return {false, 1, "Default to ToB"};
    }
  }
};
```
## Decision Matrix

| : Strategy vs Book Depth Fit |
| --- |
| +-------------------+------------+--------------+-------------------+ |
| Strategy | Book Depth | Why? | Info Value |
| +-------------------+------------+--------------+-------------------+ |
| Market Making | Full | Walls, | Critical |
| (10+ lvl) | icebergs, | (positioning) |
| imbalance |
| Arbitrage | ToB | Price diff | Sufficient |
| (lat arb, ETF) | only needed |
| Momentum | Full | Order flow, | Important |
| (5-10 lvl) | accumulation |
| Mean Reversion | ToB | Signal from | Usually enough |
| bid/ask only |
| Statistical Arb | ToB | Cross- | Sufficient |
| sectional |
| Iceberg Detection | Full | Inherently | Requires |
| (all) | needs depth | full depth |
| Quote Stuffing | Full | Pattern | Requires |
| Detection | (all) | at same level | full depth |
| VPIN / Flow Tox | Full | Volume at | Better with |
| (5+ lvl) | each level | full depth |
| +-------------------+------------+--------------+-------------------+ |
| Recommendation: |
| - If <= 1 Gbps bandwidth: use ToB + occasional depth snapshot |
| - If >= 10 Gbps: use full book (10 levels) always |
| - Hybrid: subscribe to ToB incremental + full book snapshot every 1ms |

