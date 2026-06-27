---
type: reference
title: "Fee Dynamics"
description: "Maker rebate impact on spread: higher maker rebates attract. Taker fee vs maker rebate tradeoff: aggressive strategies pay"
tags: ["phase-9"]
difficulty: intermediate
timestamp: "2026-06-27T03:06:09.434Z"
phase: 9
phaseName: "Order Book & Microstructure"
category: "Phase 9 - Order Book & Microstructure"
subcategory: "order-book"
language: "cpp"
artifact-id: "ZHFT_FEE_DYNAMICS"
---
## Key Learning Points

- Maker rebate impact on spread: higher maker rebates attract
- Taker fee vs maker rebate tradeoff: aggressive strategies pay
- Rebate arbitrage strategies: "rebate capture" — post passive
- Fee tier qualification logic: ADV-based tiers — higher volume
- Inverted fee models: some venues pay takers and charge makers

## Usage

// FeeAwareOrderPlacer placer(fee_calc);
// auto loc = placer.optimalPosting(Side::BUY, 100, 150.25);
// // loc says: post on ASMEX (rebate -$0.0012) vs take on CME ($0.0015)

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
// Fee-aware order placement
// ---------------------------------------------------------------------------
class FeeAwareOrderPlacer {
public:
  struct VenueFeeState {
    std::string_view name;
    double maker_rebate;  // Negative = rebate to trader
    double taker_fee;     // Positive = fee charged
    double latency_us;    // One-way RTT
  };

  struct PlacementDecision {
    std::string_view venue;
    bool             post_passive;  // true = maker, false = taker
    double           net_fee;       // Expected net fee (negative = rebate)
    double           expected_cost; // Net fee + expected adverse selection
  };

  // Given a quote to post, find the best venue + side based on fees
  PlacementDecision optimalPosting(Side side, uint64_t qty, double price,
                                    const std::vector<VenueFeeState> &venues) {
    PlacementDecision best;
    best.expected_cost = 1e9;

    for (auto &v : venues) {
      // Option 1: Post passive (maker)
      double maker_cost = v.maker_rebate * qty;
      // Option 2: Take aggressive (taker)
      double taker_cost = v.taker_fee * qty;

      // TRADEOFF: posting passive has lower fill probability but
      // earns rebate. Taking fills immediately but costs fee.
      // Weight by fill probability estimate.
      double maker_adj = maker_cost * 0.6; // 60% fill prob
      double taker_adj = taker_cost * 1.0; // 100% fill prob

      if (maker_adj < best.expected_cost) {
        best = {v.name, true, v.maker_rebate, maker_adj};
      }
      if (taker_adj < best.expected_cost) {
        best = {v.name, false, v.taker_fee, taker_adj};
      }
    }

    return best;
  }
};

// ---------------------------------------------------------------------------
// Rebate arbitrage opportunity detector
// ---------------------------------------------------------------------------
class RebateArbDetector {
public:
  struct ArbOpportunity {
    std::string_view post_venue;    // Where to post maker order
    std::string_view take_venue;    // Where to take other side
    double           profit_per_share;
    double           total_profit;
    uint64_t         max_size;
    bool             valid;
  };

  // Detect if we can earn a rebate on one side and pay lower fee on other
  ArbOpportunity detect(double bid, double ask, uint64_t size,
                         const std::vector<FeeAwareOrderPlacer::VenueFeeState> &venues) {
    double spread = ask - bid;
    ArbOpportunity best{};

    for (auto &post_v : venues) {
      for (auto &take_v : venues) {
        if (post_v.name == take_v.name) continue; // same venue

        // Round-trip: post on venue A (maker rebate), take on venue B (taker fee)
        // Profit = spread + rebate (negative cost) - taker fee
        double net = spread + post_v.maker_rebate + take_v.taker_fee;

        if (net > 0 && net > best.profit_per_share) {
          best = {post_v.name, take_v.name, net, net * size, size, true};
        }
      }
    }

    return best;
  }

  // TRADEOFF: rebate arb is fleeting — the opportunity closes as
  // spreads tighten. Must detect and execute in < 1 us.
  // Also consider: latency between venues, fill risk on maker side.
};

// ---------------------------------------------------------------------------
// Fee tier qualification tracker
// ---------------------------------------------------------------------------
class FeeTierTracker {
public:
  void recordVolume(std::string_view exchange, uint64_t volume) {
    monthly_volume_[std::string(exchange)] += volume;
  }

  struct TierQualification {
    std::string_view tier_name;
    uint64_t         required_adv;
    uint64_t         current_adv;
    double           maker_rebate;
    double           taker_fee;
    bool             qualified;
  };

  TierQualification checkTier(std::string_view exchange,
                               const std::vector<std::pair<uint64_t,
                               std::pair<double, double>>> &tiers) {
    uint64_t adv = monthly_volume_[std::string(exchange)];
    TierQualification best{"base", 0, adv, 0, 0, true};

    for (auto &[min_adv, fees] : tiers) {
      if (adv >= min_adv) {
        best = {"tier_" + std::to_string(min_adv), min_adv, adv,
                fees.first, fees.second, true};
      }
    }

    return best;
  }

  // Estimate additional volume needed to reach next tier
  uint64_t volumeToNextTier(std::string_view exchange,
                             const std::vector<uint64_t> &tier_thresholds) {
    uint64_t adv = monthly_volume_[std::string(exchange)];
    for (auto t : tier_thresholds) {
      if (adv < t) return t - adv;
    }
    return 0;
  }

private:
  std::unordered_map<std::string, uint64_t> monthly_volume_;
};
```
