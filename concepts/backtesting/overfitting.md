---
type: reference
title: "Overfitting"
description: "Purged walk-forward: gap between train/test to avoid leakage. Parameter stability: performance vs parameter surface (flat is good)"
tags: ["simulation"]
difficulty: advanced
timestamp: "2026-06-27T03:06:09.441Z"
phase: 11
phaseName: "Backtesting & Simulation"
category: "Phase 11 - Backtesting & Simulation"
subcategory: "backtesting"
language: "cpp"
artifact-id: "ZHFT_OVERFITTING"
---
## Key Learning Points

- Purged walk-forward: gap between train/test to avoid leakage
- Parameter stability: performance vs parameter surface (flat is good)
- Combinatorial purged cross-validation (CPCV): N choose K folds
- Deflated Sharpe ratio: adjusts for multiple testing (Bonferroni/Holm)
- Out-of-sample testing: never touch OOS until final evaluation

## Usage

WalkForwardOptimizer wfo(data, /* train= */ 50000, /* test= */ 10000, /* purge= */ 1000);

## Source Code

```cpp
/*
 *   auto best = wfo.optimize([](auto params, auto& data) { /* strategy */ });

 */
 *
 * PERFORMANCE TARGET:
 *   one fold evaluation < 1 second for 100K ticks
 * ====================================================================
 */

#include <vector>
#include <functional>

struct WalkForwardWindow {
    size_t train_start, train_end;
    size_t test_start,  test_end;
    size_t gap;  // purge gap between train and test
};

class WalkForwardOptimizer {
    std::vector<WalkForwardWindow> windows_;
    size_t purge_gap_{1000};

public:
    WalkForwardOptimizer(size_t total_len, size_t train_len,
                         size_t test_len, size_t purge) {
        purge_gap_ = purge;
        for (size_t t = 0; t + train_len + test_len <= total_len;
             t += test_len) {
            windows_.push_back({t, t + train_len,
                                t + train_len + purge,
                                t + train_len + purge + test_len,
                                purge});
        }
    }

    // optimize over grid of parameters
    template<typename Func>
    std::vector<double> optimize(const std::vector<double>& param_grid,
                                  Func&& strategy_fn) {
        std::vector<double> avg_scores(param_grid.size(), 0);
        for (size_t p = 0; p < param_grid.size(); ++p) {
            double total = 0;
            for (auto& w : windows_) {
                total += strategy_fn(param_grid[p], w);
            }
            avg_scores[p] = total / windows_.size();
        }
        return avg_scores;  // pick argmax
    }

    // Parameter stability: coefficient of variation across folds
    // tradeoff: stable but suboptimal vs peak but fragile
    double stability(size_t param_idx,
                     const std::vector<double>& fold_scores) {
        double mean = 0, var = 0;
        for (auto s : fold_scores) mean += s;
        mean /= fold_scores.size();
        for (auto s : fold_scores) var += (s - mean) * (s - mean);
        var /= fold_scores.size();
        return std::sqrt(var) / (std::abs(mean) + 1e-12);
    }
};

// --------------------------------------------------------------------
// Deflated Sharpe Ratio

class DeflatedSharpeRatio {
    // Adjusts for the number of trials (multiple testing correction)
    // DSR = SR_observed / (1 + γ * trials)  approximate
    // tradeoff: exact formula (Bailey et al.) vs approximation

public:
    static double compute(double observed_sr, int num_trials,
                          double num_observations) {
        double e_max_sr = std::sqrt(2.0 * std::log(static_cast<double>(num_trials)))
                          / std::sqrt(num_observations);
        double variance_max = 1.0 / num_observations;
        // DSR = (SR - E[max]) / sqrt(var_max)
        return (observed_sr - e_max_sr) / std::sqrt(variance_max);
    }
};
```
