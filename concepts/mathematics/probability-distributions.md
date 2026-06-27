---
type: reference
title: "Probability Distributions"
description: "Log-normal and normal distributions model asset returns; Poisson models discrete event arrivals (orders, trades). GEV captures tail risk. Sampling from custom distributions with C++."
tags: ["mathematics"]
timestamp: "2026-06-27T03:06:09.400Z"
phase: 2
phaseName: "Mathematics & Statistics"
category: "Mathematics & Statistics"
subcategory: "mathematics"
language: "cpp"
artifact-id: "ZHFT_PROBABILITY_DISTRIBUTIONS"
---
## Key Learning Points

- Log-normal distribution models multiplicative price changes; normal models additive returns
- Poisson process models discrete event arrivals (orders, trades, ticks) with inter-arrival times following exponential distribution
- Generalised Extreme Value (GEV) distribution captures tail risk and extreme market moves
- Mixture models handle multi-modal distributions (e.g., bid/ask spread regimes)
- Empirical distribution functions (ECDF) avoid parametric assumptions for large tick datasets
- Sampling efficiency matters: Box-Muller for normal, inverse-CDF via binary search over ECDF

## Usage

```cpp
#include <random>
#include <cmath>

struct DistributionSampler {
    std::mt19937_64 rng{std::random_device{}()};

    // Log-normal price move (mu = drift, sigma = volatility)
    double logNormalMove(double mu, double sigma) {
        std::lognormal_distribution<double> dist(mu, sigma);
        return dist(rng);
    }

    // Poisson order arrivals (lambda = expected arrivals per interval)
    int poissonArrivals(double lambda) {
        std::poisson_distribution<int> dist(lambda);
        return dist(rng);
    }

    // GEV block-maxima for extreme value estimation
    double gevSample(double xi, double mu, double sigma) {
        // GEV: mu + sigma * (U^{-xi} - 1) / xi  for xi != 0
        std::uniform_real_distribution<double> uniform(0.0, 1.0);
        double u = uniform(rng);
        return mu + sigma * (std::pow(-std::log(u), -xi) - 1.0) / xi;
    }

    // ECDF sampling from observed data
    double sampleECDF(const std::vector<double>& data) {
        std::uniform_int_distribution<size_t> idx(0, data.size() - 1);
        return data[idx(rng)];
    }
};
```

## Source Code

```cpp
// Benchmark: sampling 1M log-normal variates should complete in < 50ms
DistributionSampler ds;
double sum = 0.0;
for (int i = 0; i < 1'000'000; ++i) {
    sum += ds.logNormalMove(0.0, 0.01);
}
```
