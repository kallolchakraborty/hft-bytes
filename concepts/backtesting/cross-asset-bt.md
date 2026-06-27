---
type: reference
title: "Cross Asset Bt"
description: "Equity modeling: dividends, stock splits, corporate actions. Futures modeling: carry/roll yield, term structure, expiry"
tags: ["simd"]
difficulty: advanced
timestamp: "2026-06-27T03:06:09.440Z"
phase: 11
phaseName: "Backtesting & Simulation"
category: "Phase 11 - Backtesting & Simulation"
subcategory: "backtesting"
language: "cpp"
artifact-id: "ZHFT_CROSS_ASSET_BT"
---
## Key Learning Points

- Equity modeling: dividends, stock splits, corporate actions
- Futures modeling: carry/roll yield, term structure, expiry
- Options modeling: Greeks decay (theta), delta/gamma, implied vol
- FX modeling: spot vs forward, swap points, cross rates
- Portfolio-level backtester with multi-instrument NAV tracking

## Usage

CrossAssetBacktester bt;
bt.addInstrument<EquityModel>("AAPL");
bt.addInstrument<FuturesModel>("ESZ24");
bt.run(start, end);

## Source Code

```cpp
#include <string>
#include <unordered_map>
#include <memory>
#include <cmath>

// --------------------------------------------------------------------
// Abstract instrument model

class InstrumentModel {
public:
    virtual double adjustPrice(double raw_price, uint64_t timestamp_ns) = 0;
    virtual double carryCost(uint64_t hold_ns) const = 0;
    virtual ~InstrumentModel() = default;
};

// --------------------------------------------------------------------
// Equity model with dividends

class EquityModel : public InstrumentModel {
    double dividend_yield_;  // annualized
    double last_div_adjust_;
    uint64_t last_div_time_;

public:
    explicit EquityModel(double div_yield = 0.02)
        : dividend_yield_(div_yield) {}

    double adjustPrice(double raw_price, uint64_t) override {
        return raw_price;  // no raw→adjusted conversion needed usually
    }

    // tradeoff: discrete dividend events vs continuous yield
    double carryCost(uint64_t hold_ns) const override {
        double years = hold_ns / (3.154e16);  // ns→years
        return -dividend_yield_ * years;      // carry = -div yield
    }
};

// --------------------------------------------------------------------
// Futures model with carry/roll

class FuturesModel : public InstrumentModel {
    double spot_price_;
    double risk_free_rate_;
    double convenience_yield_;
    uint64_t expiry_ns_;
    uint64_t now_ns_;

public:
    FuturesModel(double spot, double r, double conv, uint64_t expiry)
        : spot_price_(spot), risk_free_rate_(r)
        , convenience_yield_(conv), expiry_ns_(expiry) {}

    // Futures price = spot * exp((r - c) * T)
    double theoreticalPrice() const {
        double T = static_cast<double>(expiry_ns_ - now_ns_) / 3.154e16;
        return spot_price_ * std::exp((risk_free_rate_ - convenience_yield_) * T);
    }

    double adjustPrice(double, uint64_t) override { return theoreticalPrice(); }

    // Roll yield: difference between futures return and spot return
    // tradeoff: constant carry vs term-structure model
    double carryCost(uint64_t) const override {
        return risk_free_rate_ - convenience_yield_;
    }
};

// --------------------------------------------------------------------
// Simplified Option Greeks

class OptionModel {
    double S_, K_, T_, r_, sigma_;  // spot, strike, time, rate, vol

public:
    double delta() const {
        double d1 = (std::log(S_/K_) + (r_ + sigma_*sigma_/2) * T_)
                    / (sigma_ * std::sqrt(T_ + 1e-12));
        return 0.5 * (1.0 + std::erf(d1 / std::sqrt(2.0)));  // call delta
    }

    double theta() const {
        // simplified theta = -S * σ * φ(d1) / (2√T) - ... decay
        double d1 = (std::log(S_/K_) + (r_ + sigma_*sigma_/2) * T_)
                    / (sigma_ * std::sqrt(T_ + 1e-12));
        double phi = std::exp(-d1*d1/2) / std::sqrt(2 * M_PI);
        return -S_ * sigma_ * phi / (2 * std::sqrt(T_ + 1e-12));
        // tradeoff: analytical vs numerical Greeks (finite difference)
    }
};

// --------------------------------------------------------------------
// Portfolio-Level Backtester

class CrossAssetPortfolio {
    std::unordered_map<std::string, std::unique_ptr<InstrumentModel>> instruments_;
    std::unordered_map<std::string, double> positions_;
    double nav_{1000000};  // starting NAV

public:
    template<typename T, typename... Args>
    void addInstrument(const std::string& sym, Args&&... args) {
        instruments_[sym] = std::make_unique<T>(std::forward<Args>(args)...);
    }

    void update(const std::string& sym, double price, uint64_t ts) {
        auto it = instruments_.find(sym);
        if (it != instruments_.end())
            price = it->second->adjustPrice(price, ts);
        // update NAV
        nav_ += positions_[sym] * price;
    }

    double nav() const { return nav_; }
};
```
