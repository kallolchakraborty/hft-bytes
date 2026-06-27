---
type: reference
title: "Options & Derivatives HFT"
description: "Options market making, implied volatility surface, delta hedging, gamma scalping, futures vs options microstructure, multi-listed option arbitration, and risk Greeks computation."
tags: ["trading"]
difficulty: staff
timestamp: "2026-06-27T03:20:00.000Z"
phase: 10
phaseName: "Trading Strategies"
category: "Trading Strategies"
subcategory: "trading-strategies"
language: "cpp"
artifact-id: "ZHFT_OPTIONS_HFT"
---
## Key Learning Points

- Options market-making: provide two-sided quotes on option series (calls/puts across strikes and expiries); manage inventory risk via delta hedging with the underlying futures/stock
- Greeks computation: delta (dPrice/dSpot), gamma (dDelta/dSpot), vega (dPrice/dVol), theta (dPrice/dTime); computed via analytic Black-Scholes or finite-difference for American-style options
- Vol surface: implied vol varies by strike (vol smile/skew) and tenor (term structure); MM must continuously update vol surface from traded prices and model arbitrage-free surface
- Delta hedging: hedge delta to near-zero after each fill; delta-neutral book isolates gamma/vega risk; hedge ratio changes with spot (gamma effect)
- Gamma scalping: profitable when realized vol > implied vol at entry; MM earns bid-ask on the option roll while gamma scalping the underlying
- Multi-listed options: single-name options trade on multiple exchanges (e.g., AMEX, CBOE, NASDAQ PHLX, NYSE Arca); arb opportunity if same series quoted at different prices
- Options auction mechanics: opening rotation, complex order auctions (COA), electronic vs floor trading; each exchange has different matching rules

## Usage

```cpp
// Delta computation (Black-Scholes for European options)
struct OptionGreeks {
    double delta;   // [-1, 1] for calls: [0,1], puts: [-1,0]
    double gamma;   // always positive
    double vega;    // sensitivity to 1% vol change
    double theta;   // time decay (typically negative)

    static OptionGreeks computeBS(double S, double K, double T,
                                  double r, double sigma, bool isCall) {
        double d1 = (std::log(S / K) + (r + sigma * sigma * 0.5) * T)
                    / (sigma * std::sqrt(T));
        double d2 = d1 - sigma * std::sqrt(T);
        auto cdf = [](double x) { return 0.5 * std::erfc(-x * M_SQRT1_2); };
        OptionGreeks g{};
        g.delta = isCall ? cdf(d1) : cdf(d1) - 1.0;
        g.gamma = std::exp(-d1 * d1 * 0.5) / (S * sigma * std::sqrt(2 * M_PI * T));
        // vega, theta omitted for brevity
        return g;
    }
};

// Options MM inventory risk
struct OptionsPosition {
    // Underlying hedge
    double underlying_delta_hedge_;  // shares/futures to neutralize delta
    // Greeks by vol surface node
    struct RiskNode {
        double strike_, expiry_;
        double gamma_, vega_, theta_;
        double net_pos_;  // signed contracts
    };
    std::vector<RiskNode> risk_book_;
    double total_gamma_;   // aggregate gamma exposure
    double total_vega_;    // aggregate vega exposure
};
```

## Source Code

```cpp
// Options symbol parsing (OPRA format)
// "AAPL  240621C00150000" -> AAPL, Jun 21 2024, Call, $150.00
struct OptionKey {
    std::string underlying;
    uint32_t expiry_yyyymmdd;
    bool is_call;
    uint64_t strike;  // scaled by 1000 for integer math

    static OptionKey fromOpra(const char* symbol);
    uint64_t toHash() const;  // for order-book key
};
```
