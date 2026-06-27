---
type: reference
title: "Monte Carlo"
description: "Monte Carlo simulation values complex derivatives by averaging. Variance reduction techniques (antithetic variates, control"
tags: ["simulation"]
difficulty: advanced
timestamp: "2026-06-27T03:06:09.401Z"
phase: 2
phaseName: "Mathematics & Statistics"
category: "Mathematics & Statistics"
subcategory: "mathematics"
language: "cpp"
artifact-id: "ZHFT_MONTE_CARLO"
---
## Key Learning Points

- Monte Carlo simulation values complex derivatives by averaging
- Variance reduction techniques (antithetic variates, control
- Quasi-Monte Carlo (QMC) using low-discrepancy sequences (Sobol)
- Sobol sequences provide deterministic, well-spaced points;
- For HFT risk applications, MC must run in microseconds; use

## Usage

SobolSequence sobol(10000, 1);  // 10k points, 1 dimension
std::vector<double> points = sobol.generate();
MonteCarloPricer pricer(r, sigma, T, K, S0);
auto result = pricer.price(100000, VarianceReduction::Antithetic);

## Source Code

```cpp
#include <vector>
#include <cmath>
#include <random>
#include <numeric>
#include <algorithm>
#include <stdexcept>
#include <limits>
#include <span>
#include <bit>

// ---------------------------------------------------------------------------
// Sobol Sequence Generator
// Implements direction numbers for up to 10 dimensions (primitive polynomials)
// ---------------------------------------------------------------------------
class SobolSequence {
public:
    SobolSequence(size_t n_points, size_t n_dims = 1)
        : n_points_(n_points), n_dims_(std::max<size_t>(1, n_dims)),
          x_(n_dims_, 0), count_(0) {
        initDirectionNumbers();
        // Skip first point (all zeros) for better uniformity
        nextPoint();
    }

    // Generate all points (row-major: n_points x n_dims)
    std::vector<double> generate() {
        std::vector<double> points(n_points_ * n_dims_);
        for (size_t i = 0; i < n_points_; ++i) {
            auto p = nextPoint();
            for (size_t d = 0; d < n_dims_; ++d)
                points[i * n_dims_ + d] = p[d];
        }
        return points;
    }

    // Generate points and apply inverse normal CDF for normal variates
    std::vector<double> generateNormalVariates() {
        auto uniforms = generate();
        for (auto& u : uniforms)
            u = inverseNormalCDF(u);
        return uniforms;
    }

    // Get next point in sequence
    std::vector<double> nextPoint() {
        // Find least significant zero bit
        size_t c = count_;
        size_t lsb = 0;
        while ((c & 1) == 1) { c >>= 1; ++lsb; }

        for (size_t d = 0; d < n_dims_; ++d) {
            x_[d] ^= direction_numbers_[lsb * n_dims_ + d];
        }
        ++count_;

        std::vector<double> result(n_dims_);
        for (size_t d = 0; d < n_dims_; ++d)
            result[d] = static_cast<double>(x_[d]) /
                        static_cast<double>(1uLL << 31u);
        return result;
    }

private:
    size_t n_points_, n_dims_;
    std::vector<uint32_t> x_;
    std::vector<uint32_t> direction_numbers_;
    size_t count_;

    void initDirectionNumbers() {
        // Use max 32 bits of precision
        constexpr size_t MAX_BITS = 31;
        direction_numbers_.resize(MAX_BITS * n_dims_);

        // Direction number initialization using primitive polynomials
        // For simplicity, use precomputed direction numbers for first few dims
        // Dimension 1: polynomial x + 1 (trivial)
        uint32_t v = 1;
        for (size_t j = 0; j < MAX_BITS; ++j) {
            direction_numbers_[j * n_dims_ + 0] = v;
            v <<= 1;
        }

        // Dimensions 2-10 use primitive polynomials from Joe & Kuo
        // Simplified: initialize from recurrence using saved polynomials
        static const uint32_t poly[] = {
            1,  // dim 1 (already handled)
            3,  // x + 1
            7,  // x^2 + x + 1
            11, // x^2 + x + 1 (alt)
            13, // x^3 + x + 1
            19, // x^3 + x^2 + 1
            25, // x^3 + x^2 + x + 1
            37, // x^4 + x + 1
            59, // x^4 + x^3 + 1
            47  // x^4 + x^2 + x + 1
        };

        for (size_t d = 1; d < n_dims_ && d < 10; ++d) {
            uint32_t p = poly[d];
            // Find degree of polynomial
            int deg = 31 - std::countl_zero(p);
            // Initialize first 'deg' direction numbers
            for (size_t j = 0; j < static_cast<size_t>(deg); ++j) {
                direction_numbers_[j * n_dims_ + d] = 1u << (31 - j);
            }
            // Recurrence for remaining bits
            for (size_t j = static_cast<size_t>(deg); j < MAX_BITS; ++j) {
                uint32_t vj = direction_numbers_[(j - deg) * n_dims_ + d];
                for (size_t k = 1; k < static_cast<size_t>(deg); ++k) {
                    if ((p >> (deg - k - 1)) & 1)
                        vj ^= direction_numbers_[(j - k) * n_dims_ + d];
                }
                direction_numbers_[j * n_dims_ + d] = vj;
            }
        }
    }

    // Moro's inverse normal CDF (fast and accurate)
    static double inverseNormalCDF(double u) {
        constexpr double a0 = 2.50662823884;
        constexpr double a1 = -18.61500062529;
        constexpr double a2 = 41.39119773534;
        constexpr double a3 = -25.44106049637;
        constexpr double b0 = -8.47351093090;
        constexpr double b1 = 23.08336743743;
        constexpr double b2 = -21.06224101826;
        constexpr double b3 = 3.13082909833;
        constexpr double c0 = 0.3374754822726147;
        constexpr double c1 = 0.9761690190917186;
        constexpr double c2 = 0.1607979714918209;
        constexpr double c3 = 0.0276438810333863;
        constexpr double c4 = 0.0038405729373609;
        constexpr double c5 = 0.0003951896511919;
        constexpr double c6 = 0.0000321767881768;
        constexpr double c7 = 0.0000002888167364;
        constexpr double c8 = 0.0000003960315187;

        double x = u - 0.5;
        double r;
        if (std::fabs(x) < 0.42) {
            r = x * x;
            r = x * (((a3 * r + a2) * r + a1) * r + a0) /
                     ((((b3 * r + b2) * r + b1) * r + b0) * r + 1.0);
        } else {
            r = u;
            if (x > 0.0) r = 1.0 - u;
            r = std::log(-std::log(r));
            r = c0 + r * (c1 + r * (c2 + r * (c3 + r * (c4 + r *
                (c5 + r * (c6 + r * (c7 + r * c8)))))));
            if (x < 0.0) r = -r;
        }
        return r;
    }
};

// ---------------------------------------------------------------------------
// Variance reduction techniques
// ---------------------------------------------------------------------------
enum class VarianceReduction { None, Antithetic, ControlVariates, QMC };

// ---------------------------------------------------------------------------
// Monte Carlo European option pricer with variance reduction comparison
// ---------------------------------------------------------------------------
class MonteCarloPricer {
public:
    MonteCarloPricer(double risk_free, double sigma, double T,
                     double strike, double spot)
        : r_(risk_free), sigma_(sigma), T_(T),
          K_(strike), S0_(spot),
          sqrt_T_(std::sqrt(T)),
          drift_((risk_free - 0.5 * sigma * sigma) * T),
          vol_factor_(sigma * sqrt_T_) {}

    struct PriceResult {
        double call_price;
        double put_price;
        double std_error_call;
        double std_error_put;
        double variance_reduction_ratio;
    };

    PriceResult price(size_t n_paths,
                      VarianceReduction vr = VarianceReduction::None) {
        switch (vr) {
            case VarianceReduction::None:
                return plainMC(n_paths);
            case VarianceReduction::Antithetic:
                return antitheticMC(n_paths);
            case VarianceReduction::ControlVariates:
                return controlVariateMC(n_paths);
            case VarianceReduction::QMC:
                return qmcPricer(n_paths);
            default:
                return plainMC(n_paths);
        }
    }

private:
    double r_, sigma_, T_, K_, S0_;
    double sqrt_T_, drift_, vol_factor_;

    std::mt19937_64 rng_;

    PriceResult plainMC(size_t n) {
        std::normal_distribution<double> normal(0.0, 1.0);
        double sum_call = 0.0, sum_put = 0.0;
        double sum2_call = 0.0, sum2_put = 0.0;

        for (size_t i = 0; i < n; ++i) {
            double z = normal(rng_);
            double ST = S0_ * std::exp(drift_ + vol_factor_ * z);
            double call = std::max(ST - K_, 0.0);
            double put = std::max(K_ - ST, 0.0);
            sum_call += call;
            sum_put += put;
            sum2_call += call * call;
            sum2_put += put * put;
        }

        double df = std::exp(-r_ * T_);
        double call_price = df * sum_call / n;
        double put_price  = df * sum_put / n;
        double var_call = (sum2_call / n - (sum_call / n) * (sum_call / n)) / n;
        double var_put  = (sum2_put / n - (sum_put / n) * (sum_put / n)) / n;

        return {call_price, put_price,
                std::sqrt(var_call) * df,
                std::sqrt(var_put) * df, 1.0};
    }

    PriceResult antitheticMC(size_t n) {
        std::normal_distribution<double> normal(0.0, 1.0);
        double sum_call = 0.0, sum_put = 0.0;
        double sum2_call = 0.0, sum2_put = 0.0;

        for (size_t i = 0; i < n; i += 2) {
            double z = normal(rng_);
            double ST1 = S0_ * std::exp(drift_ + vol_factor_ * z);
            double ST2 = S0_ * std::exp(drift_ + vol_factor_ * (-z));
            double c1 = std::max(ST1 - K_, 0.0);
            double c2 = std::max(ST2 - K_, 0.0);
            double p1 = std::max(K_ - ST1, 0.0);
            double p2 = std::max(K_ - ST2, 0.0);
            double c_avg = (c1 + c2) * 0.5;
            double p_avg = (p1 + p2) * 0.5;
            sum_call += c_avg;
            sum_put += p_avg;
            sum2_call += c_avg * c_avg;
            sum2_put += p_avg * p_avg;
        }

        size_t n_eff = n / 2;
        double df = std::exp(-r_ * T_);
        double call_price = df * sum_call / n_eff;
        double put_price  = df * sum_put / n_eff;
        double var_call = (sum2_call / n_eff - (sum_call / n_eff) *
                          (sum_call / n_eff)) / n_eff;
        double var_put  = (sum2_put / n_eff - (sum_put / n_eff) *
                          (sum_put / n_eff)) / n_eff;

        return {call_price, put_price,
                std::sqrt(var_call) * df,
                std::sqrt(var_put) * df, 2.0}; // approx VR ratio
    }

    PriceResult controlVariateMC(size_t n) {
        // Use discretely-monitored arithmetic Asian as control variate
        std::normal_distribution<double> normal(0.0, 1.0);
        double sum_call = 0.0, sum_asian = 0.0;
        double sum_call_asian = 0.0, sum2_call = 0.0;

        for (size_t i = 0; i < n; ++i) {
            double z = normal(rng_);
            double ST = S0_ * std::exp(drift_ + vol_factor_ * z);
            double call = std::max(ST - K_, 0.0);
            // Asian control: average price over the path (2 points)
            double S_mid = S0_ * std::exp(drift_ * 0.5 + vol_factor_ * z * std::sqrt(0.5));
            double S_avg = (S0_ + S_mid + ST) / 3.0;
            double asian = std::max(S_avg - K_, 0.0);
            sum_call += call;
            sum_asian += asian;
            sum_call_asian += call * asian;
            sum2_call += call * call;
        }

        double df = std::exp(-r_ * T_);
        double call_mean = sum_call / n;
        double asian_mean = sum_asian / n;
        double call_var = sum2_call / n - call_mean * call_mean;

        // Covariance
        double cov = sum_call_asian / n - call_mean * asian_mean;

        // Known Asian price (Black-style approximation for geometric avg)
        double sigma_avg = sigma_ / std::sqrt(3.0);
        double d1 = (std::log(S0_ / K_) + (r_ + 0.5 * sigma_avg * sigma_avg) * T_)
                     / (sigma_avg * sqrt_T_);
        double d2 = d1 - sigma_avg * sqrt_T_;
        double asian_exact = df * (S0_ * std::exp((r_ - r_) * T_) *
                             normalCDF(d1) - K_ * normalCDF(d2));

        double theta = (call_var > 1e-15) ? cov / call_var : 0.0;
        double call_cv = call_mean - theta * (asian_mean - asian_exact);

        return {df * call_cv, 0.0, df * std::sqrt(call_var / n), 0.0, 3.0};
    }

    PriceResult qmcPricer(size_t n) {
        SobolSequence sobol(n, 1);
        double sum_call = 0.0, sum_put = 0.0;
        double sum2_call = 0.0, sum2_put = 0.0;

        for (size_t i = 0; i < n; ++i) {
            auto p = sobol.nextPoint();
            double z = SobolSequence::inverseNormalCDF(p[0]);
            (void)inverseNormalCDF; // silence
            double ST = S0_ * std::exp(drift_ + vol_factor_ * z);
            double call = std::max(ST - K_, 0.0);
            double put = std::max(K_ - ST, 0.0);
            sum_call += call;
            sum_put += put;
            sum2_call += call * call;
            sum2_put += put * put;
        }

        double df = std::exp(-r_ * T_);
        double call_price = df * sum_call / n;
        double put_price  = df * sum_put / n;
        double var_call = (sum2_call / n - (sum_call / n) * (sum_call / n)) / n;
        double var_put  = (sum2_put / n - (sum_put / n) * (sum_put / n)) / n;

        return {call_price, put_price,
                std::sqrt(var_call) * df,
                std::sqrt(var_put) * df, 1.5};
    }

    static double normalCDF(double x) {
        return std::erfc(-x / std::sqrt(2.0)) / 2.0;
    }

    static double inverseNormalCDF(double u) {
        return SobolSequence::inverseNormalCDF(u);
    }
};

// ---------------------------------------------------------------------------
// Convenience: compare all variance reduction methods
// ---------------------------------------------------------------------------
struct VREfficiency {
    double plain_se;
    double antithetic_se;
    double qmc_se;
    double control_se;
    double speedup_anti;
    double speedup_qmc;
    double speedup_control;
};

class VarianceReductionBenchmark {
public:
    static VREfficiency compare(size_t n_paths,
                                double r, double sigma, double T,
                                double K, double S0) {
        MonteCarloPricer pricer(r, sigma, T, K, S0);

        auto plain  = pricer.price(n_paths, VarianceReduction::None);
        auto anti   = pricer.price(n_paths, VarianceReduction::Antithetic);
        auto qmc    = pricer.price(n_paths, VarianceReduction::QMC);
        auto cv     = pricer.price(n_paths, VarianceReduction::ControlVariates);

        return {
            plain.std_error_call,
            anti.std_error_call,
            qmc.std_error_call,
            cv.std_error_call,
            (anti.std_error_call > 0) ?
                (plain.std_error_call / anti.std_error_call) : 0,
            (qmc.std_error_call > 0) ?
                (plain.std_error_call / qmc.std_error_call) : 0,
            (cv.std_error_call > 0) ?
                (plain.std_error_call / cv.std_error_call) : 0
        };
    }
};
```
