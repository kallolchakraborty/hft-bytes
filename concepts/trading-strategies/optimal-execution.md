---
type: reference
title: "Optimal Execution"
description: "Almgren-Chriss model: trade-off between market impact and timing risk. VWAP: slice orders proportionally to historical volume profile"
tags: ["execution-algorithms"]
difficulty: intermediate
timestamp: "2026-06-27T03:06:09.438Z"
phase: 10
phaseName: "Trading Strategies"
category: "Phase 10 - Trading Strategies"
subcategory: "trading-strategies"
language: "cpp"
artifact-id: "ZHFT_OPTIMAL_EXECUTION"
---
## Key Learning Points

- Almgren-Chriss model: trade-off between market impact and timing risk
- VWAP: slice orders proportionally to historical volume profile
- TWAP: equal slices at fixed intervals (simplest)
- POV (Percentage of Volume): trade at X% of market volume
- Implementation shortfall: compare execution price to arrival price
- Impact models: linear vs square-root (Almgren et al. 2005)

## Usage

AlmgrenChriss ac(/* sigma= */ 0.02, /* impact= */ 1e-6, /* risk_aversion= */ 1e-6);

## Source Code

```cpp
/*
 *   auto schedule = ac.optimize(100000, 3600);

 */
 *
 * PERFORMANCE TARGET:
 *   optimization < 1 ms for 1-hour schedule at 1-second granularity
 * ====================================================================
 */

#include <vector>
#include <cmath>

class AlmgrenChriss {
    double sigma_;        // annualized volatility
    double impact_coeff_; // η in model (permanent impact coefficient)
    double risk_aversion_; // γ

public:
    AlmgrenChriss(double sigma, double impact, double risk_aversion)
        : sigma_(sigma), impact_coeff_(impact), risk_aversion_(risk_aversion) {}

    // Returns trade list: shares to sell in each interval
    std::vector<double> optimize(double total_shares, int num_intervals) {
        // Almgren-Chriss closed form for linear impact:
        // x_j = X * sinh(κ(T - t_j)) / sinh(κT)
        // κ = sqrt(γ σ² / η)
        double T = static_cast<double>(num_intervals);
        double kappa = std::sqrt(risk_aversion_ * sigma_ * sigma_
                                 / (impact_coeff_ + 1e-30));

        std::vector<double> trades(num_intervals);
        double denom = std::sinh(kappa * T);
        if (denom < 1e-12) {
            // edge case: no risk aversion → TWAP
            for (auto& t : trades) t = total_shares / num_intervals;
            return trades;
        }

        // cumulative shares remaining
        for (int j = 0; j < num_intervals; ++j) {
            double t_j = static_cast<double>(j);
            // shares executed = x(t_j) - x(t_{j+1})
            // tradeoff: closed-form O(N) vs numerical PDE for non-linear impact
            double x_curr = total_shares * std::sinh(kappa * (T - t_j)) / denom;
            double x_next = total_shares * std::sinh(kappa * (T - (t_j + 1))) / denom;
            trades[j] = x_curr - x_next;
        }
        return trades;
    }
};

// --------------------------------------------------------------------
// VWAP Schedule Generator

class VwapScheduleGen {
    std::vector<double> volume_profile_;  // normalized by total daily volume

public:
    VwapScheduleGen(const std::vector<double>& hist_volume) {
        double sum = 0;
        for (auto v : hist_volume) sum += v;
        volume_profile_.reserve(hist_volume.size());
        for (auto v : hist_volume)
            volume_profile_.push_back(v / sum);
    }

    std::vector<double> schedule(double total_shares) {
        std::vector<double> slices(volume_profile_.size());
        for (size_t i = 0; i < volume_profile_.size(); ++i)
            slices[i] = total_shares * volume_profile_[i];
        return slices;
    }
};

// --------------------------------------------------------------------
// Implementation Shortfall Tracker

class ImplementationShortfall {
    double arrival_price_;   // mid price at order arrival
    double total_cost_;      // Σ (exec_price - arrival) * shares
    double total_shares_;
    double spread_cost_;     // half-spread at arrival
    double market_impact_;   // price movement due to order
    double delay_cost_;      // price move between decision and execution

public:
    void report() const {
        // breakdown for TCA (trading cost analysis)
        // tradeoff: attribution granularity vs data availability
    }
};
```
