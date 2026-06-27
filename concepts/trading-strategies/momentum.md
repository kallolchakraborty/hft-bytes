---
type: reference
title: "Momentum"
description: "Time-series momentum: long if return over lookback > 0. Cross-sectional momentum: rank assets by return, long top, short bottom"
tags: ["phase-10"]
difficulty: intermediate
timestamp: "2026-06-27T03:06:09.437Z"
phase: 10
phaseName: "Trading Strategies"
category: "Phase 10 - Trading Strategies"
subcategory: "trading-strategies"
language: "cpp"
artifact-id: "ZHFT_MOMENTUM"
---
## Key Learning Points

- Time-series momentum: long if return over lookback > 0
- Cross-sectional momentum: rank assets by return, long top, short bottom
- Mean reversion with Bollinger Bands: z-score > 2 → fade the move
- Ornstein-Uhlenbeck process: estimate θ (mean reversion speed), μ (mean), σ
- Holding period optimization via signal decay estimation

## Usage

MomentumSignal sig(/* lookback= */ 20);

## Source Code

```cpp
/*
 *   for (auto px : prices) { sig.update(px); auto s = sig.signal(); }

 */
 *
 * PERFORMANCE TARGET:
 *   signal generation < 100 ns per tick
 * ====================================================================
 */

#include <vector>
#include <numeric>
#include <cmath>

class MomentumSignal {
    int lookback_;
    std::vector<double> returns_;  // rolling window

public:
    explicit MomentumSignal(int lb) : lookback_(lb) {
        returns_.reserve(lookback_ + 1);
    }

    void update(double price) {
        if (!returns_.empty()) {
            double ret = std::log(price / last_price_);
            returns_.push_back(ret);
            if (returns_.size() > lookback_)
                returns_.erase(returns_.begin());
        }
        last_price_ = price;
    }

    // time-series momentum: +1 if positive trend, -1 if negative, 0 if flat
    int signal(double threshold = 0.0) {
        double avg = std::accumulate(returns_.begin(), returns_.end(), 0.0)
                     / std::max(returns_.size(), size_t(1));
        return (avg > threshold) ? 1 : (avg < -threshold) ? -1 : 0;
    }

    // cross-sectional rank signal (call across many instruments)
    static double rankSignal(double instrument_return,
                             const std::vector<double>& all_returns) {
        // tradeoff: O(n log n) per bar — fine for < 5000 instruments
        int rank = 1;
        for (auto r : all_returns)
            if (instrument_return > r) ++rank;
        return 2.0 * rank / all_returns.size() - 1.0;  // [-1, 1]
    }

private:
    double last_price_{0.0};
};

// --------------------------------------------------------------------
// Ornstein-Uhlenbeck Mean Reversion

class OUMeanReversion {
    double theta_, mu_, sigma_;  // OU parameters
    double dt_{1.0};
    double prev_price_;

public:
    explicit OUMeanReversion(double dt = 1.0) : dt_(dt) {}

    void estimateParameters(const std::vector<double>& prices) {
        // Simplified MLE for OU process (Bergstrom 1990 approximation)
        // dX = θ(μ - X)dt + σdW
        int n = prices.size() - 1;
        double sum_xy = 0, sum_x = 0, sum_y = 0, sum_xx = 0;

        for (int i = 0; i < n; ++i) {
            double x = prices[i];
            double y = prices[i+1] - prices[i];  // ΔX
            sum_xy += x * y;
            sum_x  += x;
            sum_y  += y;
            sum_xx += x * x;
        }
        // θ̂ = - (n*sum_xy - sum_x*sum_y) / (n*sum_xx - sum_x*sum_x) / dt
        double denom = n * sum_xx - sum_x * sum_x;
        if (std::abs(denom) < 1e-12) { theta_ = 1e-6; return; }
        theta_ = -(n * sum_xy - sum_x * sum_y) / denom / dt_;
    }

    double zScore(double current_price) {
        double dev = current_price - mu_;
        return dev / (sigma_ / std::sqrt(2.0 * theta_));
    }

    int signal(double current_price, double entry_z = 2.0) {
        double z = zScore(current_price);
        if (z > entry_z)  return -1;  // overbought → short
        if (z < -entry_z) return  1;  // oversold  → long
        return 0;
    }
};
```
