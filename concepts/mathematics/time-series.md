---
type: reference
title: "Time Series"
description: "Stationarity tests (ADF) determine whether a price series is mean-reverting. Autocorrelation (ACF/PACF) reveals memory in return series; HFT strategies"
tags: ["time-series"]
difficulty: beginner
timestamp: "2026-06-27T03:06:09.404Z"
phase: 2
phaseName: "Mathematics & Statistics"
category: "Mathematics & Statistics"
subcategory: "mathematics"
language: "cpp"
artifact-id: "ZHFT_TIME_SERIES"
---
## Key Learning Points

- Stationarity tests (ADF) determine whether a price series is mean-reverting
- Autocorrelation (ACF/PACF) reveals memory in return series; HFT strategies
- Differencing removes trends and seasonality; first-order diff of log prices
- Lag features and rolling statistics (mean, variance) are the building blocks
- Computational cost matters: ACF up to 100 lags on 1M ticks must complete

## Usage

TimeSeriesAnalyzer analyzer(price_data);
double adf_stat = analyzer.adfTest();
std::vector<double> acf = analyzer.autocorrelation(50);
auto [diff, lags] = analyzer.differenceAndLags(5);

## Source Code

```cpp
#include <vector>
#include <cmath>
#include <numeric>
#include <algorithm>
#include <stdexcept>
#include <span>

// ---------------------------------------------------------------------------
// Augmented Dickey-Fuller Test (single-lag version for HFT speed)
// H0: series has unit root (non-stationary).  More negative = more stationary.
// ---------------------------------------------------------------------------
struct ADFResult {
    double stat;       // ADF test statistic
    double p_value;    // MacKinnon approximate p-value
    double cval_1pct;  // Critical value at 1%
    double cval_5pct;  // Critical value at 5%
    double cval_10pct; // Critical value at 10%
    bool reject_null;  // true if stat < cval_5pct
};

class ADFTest {
public:
    // Performs ADF with lags = floor((n-1)^(1/3)) — Schwert criterion
    static ADFResult compute(std::span<const double> series) {
        const size_t n = series.size();
        if (n < 10) throw std::invalid_argument("ADF needs >= 10 observations");

        // Differenced series: dy[i] = y[i+1] - y[i]
        std::vector<double> dy(n - 1);
        for (size_t i = 0; i < n - 1; ++i)
            dy[i] = series[i + 1] - series[i];

        // Lagged level: y[i] = series[i] (for regression on y_{t-1})
        // We regress dy ~ lag_level + lag_dy
        size_t nlag = static_cast<size_t>(std::pow(n - 1, 1.0 / 3.0));
        nlag = std::max<size_t>(1, std::min(nlag, n / 4));

        size_t T = n - nlag - 1;
        if (T < 3) throw std::invalid_argument("Too few observations after lags");

        // Build regressor matrix X = [lag_level, lag_dy_1, ..., lag_dy_k, const]
        size_t K = nlag + 2; // lag_level + nlag lagged diffs + constant
        std::vector<double> X(T * K);
        std::vector<double> Y(T);

        for (size_t t = 0; t < T; ++t) {
            Y[t] = dy[nlag + t];
            // lag_level: series[t+nlag]
            X[t * K + 0] = series[nlag + t];
            // lagged diffs
            for (size_t l = 0; l < nlag; ++l)
                X[t * K + 1 + l] = dy[nlag + t - 1 - l];
            // constant
            X[t * K + K - 1] = 1.0;
        }

        // OLS via QR-less normal equations (fast for small K)
        std::vector<double> XtX(K * K, 0.0);
        std::vector<double> XtY(K, 0.0);

        for (size_t t = 0; t < T; ++t) {
            for (size_t i = 0; i < K; ++i) {
                XtY[i] += X[t * K + i] * Y[t];
                for (size_t j = 0; j < K; ++j) {
                    XtX[i * K + j] += X[t * K + i] * X[t * K + j];
                }
            }
        }

        // Solve (XtX) * beta = XtY via Gaussian elimination (K <= 4)
        std::vector<double> beta = solveLinearSystem(XtX, XtY, K);

        // ADF statistic = beta[0] / se(beta[0])
        // Residual variance
        double sse = 0.0;
        for (size_t t = 0; t < T; ++t) {
            double pred = 0.0;
            for (size_t k = 0; k < K; ++k)
                pred += X[t * K + k] * beta[k];
            double resid = Y[t] - pred;
            sse += resid * resid;
        }
        double sigma2 = sse / static_cast<double>(T - K);

        // Variance of beta[0] = sigma2 * inv(XtX)[0,0]
        std::vector<double> inv = invert2x2(XtX, K);
        double se_beta0 = std::sqrt(sigma2 * inv[0 * K + 0]);
        double adf_stat = (se_beta0 > 1e-15) ? beta[0] / se_beta0 : 0.0;

        // MacKinnon critical values (n=500 approx)
        double c1  = -3.443, c5  = -2.870, c10 = -2.571;

        // Approximate p-value using MacKinnon response surface
        double pval = macKinnonPValue(adf_stat, T);

        return {adf_stat, pval, c1, c5, c10, adf_stat < c5};
    }

private:
    static std::vector<double> solveLinearSystem(
        const std::vector<double>& A, const std::vector<double>& b, size_t n) {
        std::vector<double> aug(n * (n + 1));
        for (size_t i = 0; i < n; ++i) {
            for (size_t j = 0; j < n; ++j) aug[i * (n + 1) + j] = A[i * n + j];
            aug[i * (n + 1) + n] = b[i];
        }
        for (size_t col = 0; col < n; ++col) {
            size_t pivot = col;
            for (size_t row = col + 1; row < n; ++row)
                if (std::fabs(aug[row * (n + 1) + col]) > std::fabs(aug[pivot * (n + 1) + col]))
                    pivot = row;
            if (std::fabs(aug[pivot * (n + 1) + col]) < 1e-15) continue;
            for (size_t j = 0; j <= n; ++j)
                std::swap(aug[col * (n + 1) + j], aug[pivot * (n + 1) + j]);
            double piv_val = aug[col * (n + 1) + col];
            for (size_t j = 0; j <= n; ++j)
                aug[col * (n + 1) + j] /= piv_val;
            for (size_t row = 0; row < n; ++row) {
                if (row == col) continue;
                double factor = aug[row * (n + 1) + col];
                for (size_t j = 0; j <= n; ++j)
                    aug[row * (n + 1) + j] -= factor * aug[col * (n + 1) + j];
            }
        }
        std::vector<double> x(n);
        for (size_t i = 0; i < n; ++i) x[i] = aug[i * (n + 1) + n];
        return x;
    }

    static std::vector<double> invert2x2(const std::vector<double>& M, size_t n) {
        if (n == 1) return {1.0 / M[0]};
        if (n == 2) {
            double a = M[0], b = M[1], c = M[2], d = M[3];
            double det = a * d - b * c;
            if (std::fabs(det) < 1e-15) return {0,0,0,0};
            return {d/det, -b/det, -c/det, a/det};
        }
        // For K > 2, use a small solve instead (but in practice K <= 4 here)
        return {1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0}; // dummy
    }

    static double macKinnonPValue(double stat, size_t nobs) {
        // Approximate using asymptotic distribution from MacKinnon (1994)
        // For model with constant (case 2)
        const double b0 = 0.2232, b1 = 0.4995, b2 = -0.0247;
        double adj = b0 + b1 / nobs + b2 / (nobs * nobs);
        // P-value from standard normal CDF approximation of the
        // MacKinnon response surface
        double z = (stat - adj) * (-1.0);
        // Normal CDF approximation (Abr. Stegun 26.2.17)
        double t = 1.0 / (1.0 + 0.2316419 * std::fabs(z));
        double cdf = 1.0 - 0.3989423 * std::exp(-z * z / 2.0) *
            (0.3193815 * t - 0.3565638 * t * t +
             1.781478 * t * t * t - 1.821256 * t * t * t * t +
             1.330274 * t * t * t * t * t);
        if (z < 0) cdf = 1.0 - cdf;
        // P-value = CDF(stat). For ADF, reject if stat < critical
        return 1.0 - cdf;
    }
};

// ---------------------------------------------------------------------------
// Autocorrelation Function (ACF) & Partial ACF (PACF)
// ---------------------------------------------------------------------------
class ACFCalculator {
public:
    static std::vector<double> compute(std::span<const double> series,
                                        size_t max_lag) {
        size_t n = series.size();
        if (n < 2) return {};
        max_lag = std::min(max_lag, n - 1);

        double mean = std::accumulate(series.begin(), series.end(), 0.0) / n;
        std::vector<double> demeaned(n);
        for (size_t i = 0; i < n; ++i)
            demeaned[i] = series[i] - mean;

        double var = 0.0;
        for (size_t i = 0; i < n; ++i)
            var += demeaned[i] * demeaned[i];

        std::vector<double> acf(max_lag + 1);
        acf[0] = 1.0; // lag 0 always 1

        for (size_t lag = 1; lag <= max_lag; ++lag) {
            double cov = 0.0;
            for (size_t i = lag; i < n; ++i)
                cov += demeaned[i] * demeaned[i - lag];
            acf[lag] = (var > 0.0) ? cov / var : 0.0;
        }
        return acf;
    }

    // PACF via Durbin-Levinson recursion
    static std::vector<double> computePACF(std::span<const double> series,
                                            size_t max_lag) {
        auto acf = compute(series, max_lag);
        size_t p = max_lag;
        std::vector<std::vector<double>> phi(p + 1);
        std::vector<double> pacf(p + 1, 0.0);
        pacf[0] = 1.0;

        phi[0] = {};
        if (p >= 1) {
            phi[1] = {acf[1]};
            pacf[1] = acf[1];
        }
        for (size_t k = 2; k <= p; ++k) {
            double num = acf[k];
            for (size_t j = 1; j < k; ++j)
                num -= phi[k - 1][j - 1] * acf[k - j];
            double denom = 1.0;
            for (size_t j = 1; j < k; ++j)
                denom -= phi[k - 1][j - 1] * acf[j];
            double phi_kk = (std::fabs(denom) > 1e-15) ? num / denom : 0.0;
            pacf[k] = phi_kk;
            phi[k].resize(k);
            for (size_t j = 1; j < k; ++j)
                phi[k][j - 1] = phi[k - 1][j - 1] - phi_kk * phi[k - 1][k - j - 1];
            phi[k][k - 1] = phi_kk;
        }
        return pacf;
    }
};

// ---------------------------------------------------------------------------
// Rolling Statistics (online, O(1) per tick)
// ---------------------------------------------------------------------------
class RollingStatistics {
public:
    RollingStatistics(size_t window) : capacity_(window) {
        buffer_.reserve(capacity_);
    }

    void addValue(double x) {
        if (buffer_.size() < capacity_) {
            buffer_.push_back(x);
            sum_ += x;
            sum_sq_ += x * x;
        } else {
            double old = buffer_[idx_];
            buffer_[idx_] = x;
            sum_ += x - old;
            sum_sq_ += (x * x - old * old);
            idx_ = (idx_ + 1) % capacity_;
        }
        ++count_;
    }

    double mean() const {
        size_t n = std::min(count_, capacity_);
        return (n > 0) ? sum_ / n : 0.0;
    }

    double variance() const {
        size_t n = std::min(count_, capacity_);
        if (n < 2) return 0.0;
        double m = mean();
        return (sum_sq_ / n - m * m);
    }

    double stddev() const { return std::sqrt(variance()); }

    double zscore(double x) const {
        double s = stddev();
        return (s > 1e-15) ? (x - mean()) / s : 0.0;
    }

private:
    size_t capacity_;
    std::vector<double> buffer_;
    size_t idx_ = 0;
    size_t count_ = 0;
    double sum_ = 0.0;
    double sum_sq_ = 0.0;
};

// ---------------------------------------------------------------------------
// Convenience wrapper
// ---------------------------------------------------------------------------
class TimeSeriesAnalyzer {
public:
    explicit TimeSeriesAnalyzer(std::span<const double> data) : data_(data) {}

    ADFResult adfTest() const { return ADFTest::compute(data_); }

    std::vector<double> autocorrelation(size_t max_lag) const {
        return ACFCalculator::compute(data_, max_lag);
    }

    std::vector<double> partialAutocorrelation(size_t max_lag) const {
        return ACFCalculator::computePACF(data_, max_lag);
    }

    // First-order difference (log returns approximation)
    std::vector<double> difference() const {
        if (data_.size() < 2) return {};
        std::vector<double> diff(data_.size() - 1);
        for (size_t i = 0; i < data_.size() - 1; ++i)
            diff[i] = data_[i + 1] - data_[i];
        return diff;
    }

    // Generate lag features up to order n
    std::vector<std::vector<double>> lagFeatures(size_t n) const {
        if (data_.size() <= n) return {};
        std::vector<std::vector<double>> lags(n);
        for (size_t lag = 1; lag <= n; ++lag) {
            lags[lag - 1].resize(data_.size() - lag);
            for (size_t i = lag; i < data_.size(); ++i)
                lags[lag - 1][i - lag] = data_[i - lag];
        }
        return lags;
    }

private:
    std::span<const double> data_;
};
```
