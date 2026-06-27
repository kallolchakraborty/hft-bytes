---
type: reference
title: "Pairs Trading"
description: "Engle-Granger test: regress Y on X, test residuals for stationarity (ADF). Johansen test: eigenvalue-based cointegration for multiple series"
tags: ["phase-10"]
difficulty: advanced
timestamp: "2026-06-27T03:06:09.438Z"
phase: 10
phaseName: "Trading Strategies"
category: "Phase 10 - Trading Strategies"
subcategory: "trading-strategies"
language: "cpp"
artifact-id: "ZHFT_PAIRS_TRADING"
---
## Key Learning Points

- Engle-Granger test: regress Y on X, test residuals for stationarity (ADF)
- Johansen test: eigenvalue-based cointegration for multiple series
- Spread normalization via z-score for entry/exit thresholds
- Kalman filter for dynamic hedge ratio (time-varying beta)
- Entry when z-score crosses ±2σ, exit when crosses ±0.5σ

## Usage

KalmanPairsTrader trader(0.001, 0.01);
trader.update(price_a, price_b);
if (auto sig = trader.signal()) { exec->trade(*sig); }

## Source Code

```cpp
#include <cmath>
#include <vector>
#include <optional>

// --------------------------------------------------------------------
// Kalman Filter for Dynamic Hedge Ratio
// State: [hedge_ratio, bias]^T
// Observation: price_a = hedge_ratio * price_b + bias + noise

class KalmanPairsTrader {
    double delta_;       // transition covariance (how fast beta changes)
    double ev_;          // evolution variance
    double ox_;          // observation variance
    double dt_;          // measurement noise scaling

    // state
    double beta_;        // hedge ratio
    double beta_var_;    // uncertainty
    double bias_;        // constant offset
    double bias_var_;

    double z_score_;
    int    position_;    // +1 long pair, -1 short pair, 0 flat

public:
    KalmanPairsTrader(double delta = 0.001, double ev = 0.01)
        : delta_(delta), ev_(ev), ox_(0.001), dt_(1.0)
        , beta_(1.0), beta_var_(1.0), bias_(0.0), bias_var_(1.0)
        , z_score_(0.0), position_(0) {}

    void update(double price_a, double price_b) {
        // Predict step: add evolution noise
        // tradeoff: constant variance model — simpler than GARCH, adequate for intraday
        beta_var_ += ev_;
        bias_var_ += delta_;

        // Observation: spread = price_a - beta * price_b - bias
        double predicted_spread = price_a - beta_ * price_b - bias_;
        double h_var = price_b * price_b * beta_var_ + bias_var_ + ox_;

        // Kalman gain
        double k_beta  = (beta_var_ * price_b) / h_var;
        double k_bias  = bias_var_ / h_var;

        // Update
        beta_ += k_beta * predicted_spread;
        bias_ += k_bias * predicted_spread;
        beta_var_ *= (1.0 - k_beta * price_b);
        bias_var_ *= (1.0 - k_bias);

        // Normalized spread (z-score) using EWMA of spread stddev
        updateZScore(predicted_spread);
    }

    std::optional<int> signal() {
        // entry: |z| > 2.0, exit: |z| < 0.5
        if (position_ == 0) {
            if (z_score_ > 2.0)  return position_ = -1;  // short spread
            if (z_score_ < -2.0) return position_ =  1;  // long spread
        } else {
            if (std::abs(z_score_) < 0.5) {
                position_ = 0;
                return 0;  // exit
            }
        }
        return std::nullopt;
    }

private:
    double spread_ewma_{0};  // running mean
    double spread_ewvar_{1};
    double alpha_{0.01};     // EWMA decay

    void updateZScore(double spread) {
        // tradeoff: single EWMA vs full window — no history needed
        spread_ewma_  = alpha_ * spread + (1 - alpha_) * spread_ewma_;
        spread_ewvar_ = alpha_ * (spread - spread_ewma_) * (spread - spread_ewma_)
                       + (1 - alpha_) * spread_ewvar_;
        z_score_ = (spread - spread_ewma_) / std::sqrt(spread_ewvar_ + 1e-12);
    }
};
```
