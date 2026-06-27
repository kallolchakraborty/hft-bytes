---
type: reference
title: "Stochastic Calc"
description: "Wiener processes (Brownian motion) are the foundational building. Ito's lemma relates the differential of a function of a stochastic"
tags: ["phase-2"]
timestamp: "2026-06-27T03:06:09.403Z"
phase: 2
phaseName: "Mathematics & Statistics"
category: "Mathematics & Statistics"
subcategory: "mathematics"
language: "cpp"
artifact-id: "ZHFT_STOCHASTIC_CALC"
---
## Key Learning Points

- Wiener processes (Brownian motion) are the foundational building
- Ito's lemma relates the differential of a function of a stochastic
- Geometric Brownian Motion (GBM) models log-normal prices under the
- Variance estimation from high-frequency returns must account for
- Jump detection separates continuous diffusion from discontinuous

## Usage

GBMPathGenerator gbm(0.0, 0.2, 0.01, 252); // mu, sigma, dt, steps
std::vector<double> path = gbm.simulate(42); // seed=42
double rv = RealizedVariance::compute(returns);
auto [diffusion, jumps] = JumpDetector::bipowerVariation(returns);

## Source Code

```cpp
#include <vector>
#include <cmath>
#include <random>
#include <numeric>
#include <algorithm>
#include <stdexcept>
#include <span>
#include <x86intrin.h>

// ---------------------------------------------------------------------------
// Geometric Brownian Motion path generator
// dS = mu * S * dt + sigma * S * dW
// ---------------------------------------------------------------------------
class GBMPathGenerator {
public:
    GBMPathGenerator(double mu, double sigma, double dt, size_t steps)
        : mu_(mu), sigma_(sigma), dt_(dt), steps_(steps),
          sqrt_dt_(std::sqrt(dt)), rng_(std::mt19937_64(0)),
          dist_(0.0, 1.0) {}

    // Returns log-return path (preferred for numerics) and price path
    struct PathResult {
        std::vector<double> log_returns;  // length = steps
        std::vector<double> prices;       // length = steps + 1
    };

    PathResult simulate(uint64_t seed, double S0 = 100.0) {
        rng_.seed(seed);
        PathResult result;
        result.log_returns.resize(steps_);
        result.prices.resize(steps_ + 1);
        result.prices[0] = S0;

        double logS = std::log(S0);
        double drift = (mu_ - 0.5 * sigma_ * sigma_) * dt_;

        for (size_t i = 0; i < steps_; ++i) {
            double z = dist_(rng_);
            double dlogS = drift + sigma_ * sqrt_dt_ * z;
            result.log_returns[i] = dlogS;
            logS += dlogS;
            result.prices[i + 1] = std::exp(logS);
        }
        return result;
    }

    // Parallel batch simulation using multiple generators
    std::vector<PathResult> simulateBatch(uint64_t base_seed,
                                           size_t num_paths,
                                           double S0 = 100.0) {
        std::vector<PathResult> paths(num_paths);
        for (size_t p = 0; p < num_paths; ++p)
            paths[p] = simulate(base_seed + p, S0);
        return paths;
    }

private:
    double mu_, sigma_, dt_, sqrt_dt_;
    size_t steps_;
    std::mt19937_64 rng_;
    std::normal_distribution<double> dist_;
};

// ---------------------------------------------------------------------------
// Realized Variance (core high-frequency volatility estimator)
// ---------------------------------------------------------------------------
class RealizedVariance {
public:
    // Standard realized variance: sum of squared log-returns
    static double compute(std::span<const double> log_returns) {
        if (log_returns.empty()) return 0.0;
        double sum_sq = 0.0;
        for (auto r : log_returns)
            sum_sq += r * r;
        return sum_sq;
    }

    // Scaled to annualized volatility
    static double annualizedVol(double rv, size_t n_obs, double annual_factor) {
        // annual_factor = number of observations in a year (e.g. 252*390 for min bars)
        return std::sqrt(rv * annual_factor / static_cast<double>(n_obs));
    }

    // Subsampled realized variance for noise reduction
    static double subsampled(std::span<const double> log_returns,
                              size_t subsample_period) {
        if (subsample_period == 0) subsample_period = 1;
        double total = 0.0;
        size_t count = 0;
        for (size_t offset = 0; offset < subsample_period; ++offset) {
            double sum_sq = 0.0;
            size_t n = 0;
            for (size_t i = offset; i + subsample_period < log_returns.size();
                 i += subsample_period) {
                double r = 0.0;
                for (size_t k = 0; k < subsample_period; ++k)
                    r += log_returns[i + k];
                sum_sq += r * r;
                ++n;
            }
            if (n > 0) {
                total += sum_sq;
                count += n;
            }
        }
        return (count > 0) ? total : 0.0;
    }
};

// ---------------------------------------------------------------------------
// Bipower Variation (jump-robust volatility estimator)
// Separates continuous diffusion variance from jump component
// ---------------------------------------------------------------------------
struct JumpDecomposition {
    double integrated_variance;   // continuous component (bipower variation)
    double jump_variation;        // discontinuous component
    double jump_ratio;            // proportion of total variance from jumps
};

class JumpDetector {
public:
    static JumpDecomposition bipowerVariation(
        std::span<const double> log_returns) {
        size_t n = log_returns.size();
        if (n < 3) return {0, 0, 0};

        // mu1 = E(|Z|) for standard normal = sqrt(2/pi)
        const double mu1 = std::sqrt(2.0 / M_PI);
        double bpv = 0.0;
        double rv = 0.0;

        for (size_t i = 1; i < n; ++i) {
            double r1 = std::fabs(log_returns[i - 1]);
            double r2 = std::fabs(log_returns[i]);
            bpv += r1 * r2;
            rv += log_returns[i] * log_returns[i];
        }
        // Include first return in RV
        rv += log_returns[0] * log_returns[0];

        bpv *= (M_PI / 2.0);     // scale by 1/mu1^2
        bpv *= (n / (n - 1.0));  // finite-sample correction

        double iv = bpv;
        double jv = std::max(0.0, rv - bpv);
        double ratio = (rv > 0.0) ? jv / rv : 0.0;

        return {iv, jv, ratio};
    }

    // Z-test for significant jumps (Barndorff-Nielsen & Shephard)
    static double jumpStatistic(std::span<const double> log_returns) {
        auto [iv, jv, _] = bipowerVariation(log_returns);
        size_t n = log_returns.size();
        if (n < 3 || iv < 1e-15) return 0.0;

        // Tri-power quarticity (TPQ) for asymptotic variance
        double mu43 = std::pow(2.0, 2.0 / 3.0) *
                      std::tgamma(7.0 / 6.0) / std::tgamma(0.5);
        double tpq = 0.0;
        for (size_t i = 2; i < n; ++i) {
            double r1 = std::fabs(log_returns[i - 2]);
            double r2 = std::fabs(log_returns[i - 1]);
            double r3 = std::fabs(log_returns[i]);
            tpq += std::pow(r1, 4.0 / 3.0) *
                   std::pow(r2, 4.0 / 3.0) *
                   std::pow(r3, 4.0 / 3.0);
        }
        tpq *= n / (n - 2.0) * std::pow(mu43, -3.0);

        double rv = RealizedVariance::compute(log_returns);
        double num = rv - iv;
        double den = std::sqrt(tpq * std::max(1.0,
            iv * iv / (tpq + 1e-15)));
        return (den > 1e-15) ? num / den : 0.0;
    }
};

// ---------------------------------------------------------------------------
// Volatility Estimator: combines RV + Parkinson + Yang-Zhang
// ---------------------------------------------------------------------------
class HFTVolatilityEstimator {
public:
    // Compute from OHLCV data vectors
    static double yangZhang(std::span<const double> open,
                             std::span<const double> high,
                             std::span<const double> low,
                             std::span<const double> close) {
        size_t n = open.size();
        if (n < 2) return 0.0;

        // Overnight gap (close-to-open) volatility
        double sigma_overnight = 0.0;
        for (size_t i = 1; i < n; ++i) {
            double gap = std::log(open[i] / close[i - 1]);
            sigma_overnight += gap * gap;
        }
        sigma_overnight /= (n - 1);

        // Open-to-close volatility
        double sigma_oc = 0.0;
        for (size_t i = 0; i < n; ++i) {
            double ret = std::log(close[i] / open[i]);
            sigma_oc += ret * ret;
        }
        sigma_oc /= n;

        // Rogers-Satchell (high-low) volatility
        double sigma_rs = 0.0;
        for (size_t i = 0; i < n; ++i) {
            double h = std::log(high[i] / open[i]);
            double l = std::log(low[i] / open[i]);
            double c = std::log(close[i] / open[i]);
            sigma_rs += h * (h - c) + l * (l - c);
        }
        sigma_rs /= n;

        // Yang-Zhang = overnight + open-close + k * Rogers-Satchell
        double k = 0.34 / (1.34 + (n + 1) / (n - 1));
        return std::sqrt(sigma_overnight + sigma_oc + k * sigma_rs);
    }
};

// ---------------------------------------------------------------------------
// Diffusion vs Jump simulation for testing
// ---------------------------------------------------------------------------
class StochasticProcessSimulator {
public:
    // Simulate a price process with both diffusion and Poisson jumps
    static std::vector<double> simulateJumpDiffusion(
        uint64_t seed, double S0, double mu, double sigma,
        double lambda_jump, double mu_jump, double sigma_jump,
        double dt, size_t steps) {

        std::mt19937_64 rng(seed);
        std::normal_distribution<double> normal(0.0, 1.0);
        std::poisson_distribution<int> poisson(lambda_jump * dt);
        std::normal_distribution<double> jump_size(mu_jump, sigma_jump);

        std::vector<double> prices(steps + 1);
        prices[0] = S0;
        double logS = std::log(S0);
        double drift = (mu - 0.5 * sigma * sigma) * dt;
        double sqrt_dt = std::sqrt(dt);

        for (size_t i = 0; i < steps; ++i) {
            double dlogS = drift + sigma * sqrt_dt * normal(rng);
            // Add jumps
            int n_jumps = poisson(rng);
            for (int j = 0; j < n_jumps; ++j)
                dlogS += jump_size(rng);
            logS += dlogS;
            prices[i + 1] = std::exp(logS);
        }
        return prices;
    }
};
```
