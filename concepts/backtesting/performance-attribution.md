---
type: reference
title: "Performance Attribution"
description: "Alpha decomposition: timing (entry/exit skill) vs selection (instrument choice). Transaction cost analysis: spread cost + market impact + delay/slippage"
tags: ["phase-11"]
timestamp: "2026-06-27T03:06:09.442Z"
phase: 11
phaseName: "Backtesting & Simulation"
category: "Phase 11 - Backtesting & Simulation"
subcategory: "backtesting"
language: "cpp"
artifact-id: "ZHFT_PERF_ATTRIBUTION"
---
## Key Learning Points

- Alpha decomposition: timing (entry/exit skill) vs selection (instrument choice)
- Transaction cost analysis: spread cost + market impact + delay/slippage
- Signal decay analysis: how alpha degrades from signal → execution
- Sharpe ratio decomposition: hit rate, avg win/loss, frequency

## Usage

PerformanceAttribution pa;
pa.addTrade(trade, benchmark_return);
auto r = pa.report();

## Source Code

```cpp
#include <vector>
#include <numeric>
#include <cmath>

struct Trade {
    double entry_price, exit_price;
    double entry_benchmark, exit_benchmark;
    double shares;
    double spread_paid;
    double market_impact_est;
    uint64_t entry_ns, exit_ns;
};

class TransactionCostAnalysis {
    double total_spread_{0};
    double total_impact_{0};
    double total_delay_{0};  // from signal → execution price drift
    uint64_t trade_count_{0};

public:
    void addTrade(const Trade& t) {
        total_spread_  += t.spread_paid;
        total_impact_  += t.market_impact_est;
        total_delay_   += (t.entry_price - t.entry_benchmark) * t.shares;
        trade_count_++;
    }

    struct TCAReport {
        double spread_bps;    // per trade average in bps
        double impact_bps;
        double delay_bps;
        double total_bps;
    };

    TCAReport report(double avg_trade_notional) const {
        if (trade_count_ == 0) return {};
        double avg = avg_trade_notional;
        return {
            total_spread_ / avg * 10000,
            total_impact_ / avg * 10000,
            total_delay_ / avg * 10000,
            (total_spread_ + total_impact_ + total_delay_) / avg * 10000
        };
    }
};

// --------------------------------------------------------------------
// Alpha Decomposition

class AlphaDecomposition {
    double timing_return_{0};
    double selection_return_{0};
    double market_return_{0};
    double total_return_{0};

public:
    // Brinson-style attribution (simplified)
    // tradeoff: single-period vs multi-period attribution (Carino smoothing)
    void decompose(const std::vector<Trade>& trades,
                   const std::vector<double>& benchmark_returns) {
        for (size_t i = 0; i < trades.size(); ++i) {
            auto& t = trades[i];
            double b = benchmark_returns[i];
            double instrument_excess = (t.exit_price - t.entry_price) / t.entry_price;
            double timing = (t.exit_benchmark - t.entry_benchmark) / t.entry_benchmark;
            market_return_ += t.shares * t.entry_price * b;
            timing_return_ += t.shares * t.entry_price * (timing - b);
            selection_return_ += t.shares * t.entry_price * (instrument_excess - timing);
            total_return_ += t.shares * (t.exit_price - t.entry_price);
        }
    }
};

// --------------------------------------------------------------------
// Sharpe Decomposition

struct SharpeDecomposition {
    double hit_rate;      // % profitable trades
    double avg_win_bps;
    double avg_loss_bps;
    double avg_hold_ns;
    double sharpe_ratio;
    double sharpe_annualized;

    static SharpeDecomposition compute(const std::vector<double>& returns_bps) {
        if (returns_bps.empty()) return {};
        int wins = 0;
        double sum_win = 0, sum_loss = 0;
        for (auto r : returns_bps) {
            if (r > 0) { ++wins; sum_win += r; }
            else       { sum_loss += r; }
        }
        double avg = std::accumulate(returns_bps.begin(), returns_bps.end(), 0.0)
                     / returns_bps.size();
        double var = 0;
        for (auto r : returns_bps) var += (r - avg) * (r - avg);
        var /= returns_bps.size();
        double sr = avg / (std::sqrt(var) + 1e-12);
        return {
            static_cast<double>(wins) / returns_bps.size(),
            sum_win / std::max(wins, 1),
            sum_loss / std::max(static_cast<int>(returns_bps.size()) - wins, 1),
            0, sr, sr * std::sqrt(252 * 6.5 * 3600)  // annualized intraday
        };
    }
};
```
