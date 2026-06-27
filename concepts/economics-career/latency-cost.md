---
type: reference
title: "Latency Cost"
description: "ROI per microsecond: each µs of latency reduction improves rebate capture. Fee tier qualification: exchanges reward high-volume traders with rebates;"
tags: ["performance"]
timestamp: "2026-06-27T03:06:09.456Z"
phase: 16
phaseName: "HFT Economics & Career"
category: "Phase 16 - HFT Economics & Career"
subcategory: "economics-career"
language: "cpp"
artifact-id: "ZHFT_LATENCY_COST"
---
## Key Learning Points

- ROI per microsecond: each µs of latency reduction improves rebate capture
- Fee tier qualification: exchanges reward high-volume traders with rebates;
- Colocation distance cost: each additional kilometre of fibre adds ~5µs RTT;
- Break-even analysis: cost of FPGA, colo upgrade, or microwave link must be

## Source Code

```cpp
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <iomanip>
#include <map>
#include <optional>
#include <sstream>
#include <string>
#include <vector>

// ---------------------------------------------------------------------------
// Latency cost calculator — estimates the P&L impact of latency improvements.
// ---------------------------------------------------------------------------
class LatencyCostCalculator {
public:
  struct Inputs {
    double current_latency_us;      // Current round-trip entry→ack latency.
    double target_latency_us;       // Target round-trip latency.
    double daily_trade_count;
    double avg_trade_value_usd;     // Average notional per trade.
    double capture_decay_per_us;    // Fraction of trades lost per µs of delay.
    double maker_rebate_per_share;  // $/share for providing liquidity.
    double taker_fee_per_share;     // $/share for removing liquidity.
    double shares_per_trade;
    double maker_ratio;             // Fraction of trades that are maker.
  };

  struct Output {
    double latency_reduction_us;
    double additional_trades_daily;
    double additional_rebate_revenue_daily;
    double fee_savings_daily;
    double total_daily_benefit;
    double total_annual_benefit;
    double break_even_cost;         // Maximum justifiable investment.
  };

  Output calculate(const Inputs &in) const {
    double reduction_us = std::max(0.0, in.current_latency_us - in.target_latency_us);

    // Trades that were lost due to latency are now captured.
    double capture_improvement = reduction_us * in.capture_decay_per_us;
    double additional_trades   = in.daily_trade_count * capture_improvement;

    // Additional rebate revenue from maker trades.
    double add_maker_trades   = additional_trades * in.maker_ratio;
    double rebate_benefit     = add_maker_trades * in.maker_rebate_per_share *
                                in.shares_per_trade;

    // Fee savings from being faster to cancel (avoid taker fees on stale quotes).
    // Simplified: assume 1% of trades are stale-quote avoidance.
    double fee_savings = in.daily_trade_count * 0.01 *
                         in.taker_fee_per_share * in.shares_per_trade * reduction_us;

    double daily   = rebate_benefit + fee_savings;
    double annual  = daily * 252; // Trading days per year.

    // Break-even: maximum CapEx justified for this improvement.
    // Assuming 3-year horizon and 15% cost of capital.
    double break_even = annual * 0.85 * 3.0; // Discounted cumulative benefit.

    return {.latency_reduction_us   = reduction_us,
            .additional_trades_daily = additional_trades,
            .additional_rebate_revenue_daily = rebate_benefit,
            .fee_savings_daily      = fee_savings,
            .total_daily_benefit    = daily,
            .total_annual_benefit   = annual,
            .break_even_cost        = break_even};
  }
};

// ---------------------------------------------------------------------------
// Fee tier qualification analyser.
// ---------------------------------------------------------------------------
// Most exchanges have volume-based fee tiers. Consistently being in the top tier
// requires maintaining order flow at or above a threshold (e.g., 10M contracts/day).
// Latency determines which venue you reach first, which directly impacts volume.
// ---------------------------------------------------------------------------
struct ExchangeFeeTier {
  std::string name;              // "Tier 1 Maker"
  double      monthly_volume_threshold; // Minimum ADV × 21 to qualify.
  double      maker_rebate;
  double      taker_fee;
};

class FeeTierAnalyser {
  std::vector<ExchangeFeeTier> tiers_;

public:
  void set_tiers(const std::vector<ExchangeFeeTier> &tiers) { tiers_ = tiers; }

  struct TierResult {
    std::string current_tier;
    std::string next_tier;
    double      volume_needed;
    double      potential_savings_monthly;
  };

  TierResult analyse(double current_monthly_volume) const {
    TierResult res;
    double     best_rebate = 0;

    const ExchangeFeeTier *current = nullptr;
    const ExchangeFeeTier *next    = nullptr;

    for (const auto &t : tiers_) {
      if (current_monthly_volume >= t.monthly_volume_threshold) {
        if (!current || t.maker_rebate > current->maker_rebate) {
          current = &t;
        }
      } else {
        if (!next || t.monthly_volume_threshold < next->monthly_volume_threshold) {
          next = &t;
        }
      }
    }

    if (current) {
      res.current_tier       = current->name;
      res.potential_savings_monthly = 0;
    }

    if (next) {
      res.next_tier          = next->name;
      res.volume_needed      = next->monthly_volume_threshold - current_monthly_volume;

      // Additional P&L if we reach the next tier.
      if (current) {
        double extra_rebate   = (next->maker_rebate - current->maker_rebate) *
                                current_monthly_volume;
        double fee_reduction  = (next->taker_fee - current->taker_fee) *
                                current_monthly_volume;
        res.potential_savings_monthly = extra_rebate + fee_reduction;
      }
    }

    return res;
  }
};

// ---------------------------------------------------------------------------
// Colocation distance cost analysis.
// ---------------------------------------------------------------------------
class ColoDistanceCost {
public:
  struct CostInput {
    double current_distance_km;
    double target_distance_km;
    double latency_per_km_ns;       // ~5000 ns/km RTT.
    double cost_per_km_closer;      // Cost to reduce distance by 1km.
    double pnl_per_us_per_year;     // P&L improvement per µs saved annually.
  };

  struct CostOutput {
    double latency_saved_us;
    double pnl_improvement_annual;
    double cost_to_move;
    double break_even_months;
  };

  CostOutput analyse(const CostInput &in) const {
    double distance_reduction = std::max(0.0, in.current_distance_km - in.target_distance_km);
    double latency_saved_us    = (distance_reduction * in.latency_per_km_ns) / 1000.0;
    double pnl_improvement    = latency_saved_us * in.pnl_per_us_per_year;
    double cost_to_move       = distance_reduction * in.cost_per_km_closer;
    double break_even_months  = cost_to_move / (pnl_improvement / 12.0);

    return {latency_saved_us, pnl_improvement, cost_to_move, break_even_months};
  }
};
```
