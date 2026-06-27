---
type: reference
title: "Machine Learning Basics"
description: "Feature engineering on tick data: microprice, order-flow imbalance, rolling volatility. Overfitting is the #1 risk in HFT ML. Simple models with curated features beat complex models on noisy data."
tags: ["mathematics"]
difficulty: beginner
timestamp: "2026-06-27T03:06:09.400Z"
phase: 2
phaseName: "Mathematics & Statistics"
category: "Mathematics & Statistics"
subcategory: "mathematics"
language: "cpp"
artifact-id: "ZHFT_MACHINE_LEARNING_BASICS"
---
## Key Learning Points

- Feature engineering dominates model choice: microprice, order-flow imbalance, rolling volatility, depth ratios
- Overfitting is the #1 risk: noisy tick data makes it trivial to fit noise; walk-forward validation is mandatory
- Simple models (linear regression, logistic regression) often match or beat complex models on financial time series
- Regime detection via hidden Markov models or clustering can switch between parameters per market regime
- Online learning (streaming SGD) adapts to non-stationarity without full retrain
- Feature importance analysis prevents stale signals from degrading performance

## Usage

```cpp
#include <vector>
#include <numeric>
#include <cmath>

struct OnlineLinearModel {
    // Stochastic gradient descent on streaming features
    std::vector<double> weights;
    double learning_rate = 0.001;

    double predict(const std::vector<double>& features) {
        return std::inner_product(features.begin(), features.end(),
                                  weights.begin(), 0.0);
    }

    void update(const std::vector<double>& features, double target) {
        double pred = predict(features);
        double error = pred - target;
        for (size_t i = 0; i < weights.size(); ++i) {
            weights[i] -= learning_rate * error * features[i];
        }
    }

    // L2 regularisation to prevent overfitting
    void decay(double lambda = 0.0001) {
        for (auto& w : weights) w *= (1.0 - lambda);
    }
};

struct Features {
    static double microprice(double bid, double ask, double bidQty, double askQty) {
        return (bid * askQty + ask * bidQty) / (bidQty + askQty);
    }
    static double orderFlowImbalance(double bidTrades, double askTrades) {
        return (bidTrades - askTrades) / (bidTrades + askTrades + 1e-8);
    }
    static double rollingVolatility(const std::vector<double>& returns) {
        double mean = std::accumulate(returns.begin(), returns.end(), 0.0) / returns.size();
        double sq = 0.0;
        for (auto r : returns) sq += (r - mean) * (r - mean);
        return std::sqrt(sq / returns.size());
    }
};
```

## Source Code

```cpp
// Walk-forward validation skeleton
OnlineLinearModel model;
// Initialize weights for [microprice, ofi, vol, spread]
model.weights = {0.0, 0.0, 0.0, 0.0};
// Each tick: extract features, predict direction, compare to actual
```
