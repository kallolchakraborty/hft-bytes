---
type: reference
title: "Arbitrage"
description: "Latency arb: race to slow venue when price moves on fast venue. Statistical arb: trade mean-reverting spread of cointegrated basket"
tags: ["trading"]
difficulty: advanced
timestamp: "2026-06-27T03:06:09.437Z"
phase: 10
phaseName: "Trading Strategies"
category: "Phase 10 - Trading Strategies"
subcategory: "trading-strategies"
language: "cpp"
artifact-id: "ZHFT_ARBITRAGE"
---
## Key Learning Points

- Latency arb: race to slow venue when price moves on fast venue
- Statistical arb: trade mean-reverting spread of cointegrated basket
- Triangular arb: detect FX cross-rate discrepancies (3-leg cycle)
- ETF arb: exploit NAV vs market price divergence

## Usage

EtfArbDetector arb(exchange);
if (auto opp = arb.scan()) { exec->transact(*opp); }

## Source Code

```cpp
#include <array>
#include <vector>
#include <string>
#include <functional>

class TriangularArbFinder {
    struct FXRate {
        std::string pair;   // "EURUSD"
        double bid, ask;
        uint64_t ts_ns;
    };

    // cycle: EUR→USD→GBP→EUR  =>  EURUSD * USDGBP * GBPEUR
    struct ArbCycle {
        std::array<std::string, 3> legs;
        double theoretical;  // product of rates
        double market;       // actual cross
        double profit_bps;
    };

    std::vector<FXRate> rates_;

public:
    void updateRate(const FXRate& r) {
        // tradeoff: O(n) scan — fine for ~30 major pairs
        for (auto& existing : rates_) {
            if (existing.pair == r.pair) {
                existing = r;
                return;
            }
        }
        rates_.push_back(r);
    }

    std::vector<ArbCycle> findCycles() {
        std::vector<ArbCycle> cycles;
        // naive O(n^3) — acceptable for < 100 pairs
        for (size_t i = 0; i < rates_.size(); ++i)
            for (size_t j = 0; j < rates_.size(); ++j)
                for (size_t k = 0; k < rates_.size(); ++k) {
                    auto& a = rates_[i], b = rates_[j], c = rates_[k];
                    if (!formsCycle(a.pair, b.pair, c.pair)) continue;
                    double theoretical = a.bid * b.bid * c.bid;  // simplified
                    double market = getCrossRate(a.pair, b.pair, c.pair);
                    if (std::abs(theoretical - market) > 1e-6)
                        cycles.push_back({a.pair, b.pair, c.pair,
                                          theoretical, market,
                                          (theoretical/market - 1.0)*10000});
                }
        return cycles;
    }

private:
    bool formsCycle(const std::string&, const std::string&, const std::string&);
    double getCrossRate(const std::string&, const std::string&, const std::string&);
};

// --------------------------------------------------------------------
// ETF Arbitrage Detector

class EtfArbDetector {
    double nav_;          // net asset value from constituent prices
    double etf_price_;
    double creation_cost_;  // fee to create/redeem
    double threshold_;      // min arb profit to trigger

public:
    // opportunity: buy ETF cheap, redeem for NAV    OR    buy basket, create ETF, sell
    enum class ArbType { NONE, BUY_ETF_SELL_BASKET, BUY_BASKET_SELL_ETF };

    struct Opportunity {
        ArbType type;
        double profit_bps;
        double size;      // max executable
    };

    Opportunity scan() {
        double diff = (etf_price_ - nav_) / nav_;
        if (std::abs(diff) < threshold_ + creation_cost_)
            return {ArbType::NONE, 0, 0};

        if (diff < 0)  // ETF undervalued: buy ETF, redeem
            return {ArbType::BUY_ETF_SELL_BASKET, -diff * 10000, 100000};
        else            // ETF overvalued: buy basket, create ETF, sell
            return {ArbType::BUY_BASKET_SELL_ETF, diff * 10000, 100000};
    }
};
```
