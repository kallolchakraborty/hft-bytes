---
type: reference
title: "SOR"
description: "Venue selection based on weighted score: latency (30%), fees (25%),. Dark pool aggregation: route to dark venues first (lower impact),"
tags: ["phase-7"]
timestamp: "2026-06-27T03:06:09.427Z"
phase: 7
phaseName: "Order Entry & Execution"
category: "Phase 7 - Order Entry & Execution"
subcategory: "order-entry"
language: "cpp"
artifact-id: "ZHFT_SOR"
---
## Key Learning Points

- Venue selection based on weighted score: latency (30%), fees (25%),
- Dark pool aggregation: route to dark venues first (lower impact),
- Iceberg order detection: monitor displayed qty changes at same
- Fill probability estimator uses recent fill rates per symbol-venue
- Fill-or-Kill routes to fastest venue first; Immediate-or-Cancel

## Usage

// SorEngine sor;
// sor.addVenue("CME", 50e-6, 0.0001, 0.85);
// sor.addVenue("EUREX", 45e-6, 0.00015, 0.80);
// auto venue = sor.selectVenue("ES", 100, Side::BUY);

## Source Code

```cpp
#include <algorithm>
#include <array>
#include <bit>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <span>
#include <string_view>
#include <vector>

// ---------------------------------------------------------------------------
// Venue model
// ---------------------------------------------------------------------------
struct Venue {
  uint64_t id;
  char     name[12];          // 12-byte name for fast compare
  double   latency_sec;       // One-way RTT
  double   maker_fee;         // Negative = rebate
  double   taker_fee;
  double   fill_probability;  // EWMA
  uint32_t recent_orders;     // Last minute count
  uint32_t recent_fills;
  bool     is_dark;           // Dark pool flag
};

static_assert(sizeof(Venue) <= 64, "Venue fits in cache line");

// ---------------------------------------------------------------------------
// Weighted score calculator
// ---------------------------------------------------------------------------
struct VenueScoreParams {
  double w_latency      = 0.30;
  double w_fees         = 0.25;
  double w_fill_prob    = 0.35;
  double w_reliability  = 0.10;
};

class VenueScorer {
public:
  explicit VenueScorer(VenueScoreParams p = {}) : params_(p) {}

  double score(const Venue &v) const {
    // Normalize each component to [0,1]; 1 = best

    // Latency: assume min 1us, max 100us
    double lat_score = 1.0 - std::clamp(
        (v.latency_sec - 1e-6) / (100e-6 - 1e-6), 0.0, 1.0);

    // Fee score: maker+taker. Negative = rebate, score higher.
    // Cap at +/- 0.005 ($0.005 per share)
    double total_fee = v.maker_fee + v.taker_fee;
    double fee_score = 0.5 - (total_fee / 0.01); // -0.005 -> 1.0, +0.005 -> 0.0

    // Fill probability: direct
    double fill_score = v.fill_probability;

    // Reliability: recent fill ratio
    double rel_score = v.recent_orders > 0
        ? static_cast<double>(v.recent_fills) / v.recent_orders
        : 0.5;

    return params_.w_latency * lat_score +
           params_.w_fees * fee_score +
           params_.w_fill_prob * fill_score +
           params_.w_reliability * rel_score;
  }

private:
  VenueScoreParams params_;
};

// ---------------------------------------------------------------------------
// Fill probability estimator (EWMA)
// ---------------------------------------------------------------------------
class FillProbabilityEstimator {
public:
  void recordFill(uint64_t venue_symbol_key, bool filled) {
    auto &e = entries_[venue_symbol_key % kBuckets];
    // CRITICAL: EWMA avoids sharp jumps from single fills.
    // alpha=0.3 reacts quickly; lower alpha for stable estimates.
    if (e.count == 0) {
      e.probability = filled ? 0.6 : 0.4;
    } else {
      e.probability = filled
          ? e.probability + 0.3 * (1.0 - e.probability)
          : e.probability + 0.3 * (0.0 - e.probability);
    }
    e.count++;
  }

  double estimate(uint64_t venue_symbol_key) const {
    auto &e = entries_[venue_symbol_key % kBuckets];
    return e.count > 0 ? e.probability : 0.5;
  }

private:
  static constexpr size_t kBuckets = 4096;
  struct Entry {
    double probability = 0.5;
    uint64_t count = 0;
  };
  mutable std::array<Entry, kBuckets> entries_;
};

// ---------------------------------------------------------------------------
// Smart Order Router
// ---------------------------------------------------------------------------
class SorEngine {
public:
  void addVenue(Venue v) {
    venues_.push_back(v);
  }

  struct RouteResult {
    uint64_t venue_id;
    bool     fill_or_kill;
    double   expected_cost;  // Total expected cost per share
  };

  // Select best venue for order
  RouteResult selectVenue(std::string_view symbol, uint64_t qty, Side side,
                           bool fill_or_kill = false) {
    Venue *best = nullptr;
    double best_score = -1.0;

    for (auto &v : venues_) {
      double s = scorer_.score(v);
      if (s > best_score) {
        best_score = s;
        best = &v;
      }
    }

    if (!best) return {0, false, 0.0};

    // If FOK, try fastest venue regardless of score
    if (fill_or_kill) {
      Venue *fastest = &venues_[0];
      for (auto &v : venues_) {
        if (v.latency_sec < fastest->latency_sec)
          fastest = &v;
      }
      return {fastest->id, true, fastest->taker_fee};
    }

    // Dark pool first, then lit
    // TRADEOFF: routing to dark first reduces market impact but may not fill.
    // Some strategies reverse this for urgency.
    for (auto &v : venues_) {
      if (v.is_dark && scorer_.score(v) > 0.3) {
        return {v.id, false, v.maker_fee + v.taker_fee};
      }
    }

    double cost = (side == Side::Buy) ? best->taker_fee : best->maker_fee;
    return {best->id, false, cost};
  }

  // Detect iceberg: repeated replenish at same price
  struct IcebergSignal {
    uint64_t symbol_hash;
    double   price;
    uint64_t displayed_qty;
    uint64_t replenish_count;
  };

  IcebergSignal detectIceberg(uint64_t symbol_hash, double price,
                              uint64_t current_qty) {
    auto &hist = iceberg_history_[symbol_hash ^
        std::bit_cast<uint64_t>(price)];
    if (hist.last_qty > 0 && hist.last_qty < current_qty) {
      hist.replenish_count++;
      // TRADEOFF: threshold=3 reduces false positives but may miss
      // small icebergs. Increase for less noise.
      if (hist.replenish_count >= 3) {
        return {symbol_hash, price, current_qty, hist.replenish_count};
      }
    }
    hist.last_qty = current_qty;
    return {};
  }

private:
  std::vector<Venue> venues_;
  VenueScorer scorer_;
  FillProbabilityEstimator fill_estimator_;

  struct IcebergHistory {
    uint64_t last_qty = 0;
    uint64_t replenish_count = 0;
  };
  std::array<IcebergHistory, 1024> iceberg_history_;
};
```
