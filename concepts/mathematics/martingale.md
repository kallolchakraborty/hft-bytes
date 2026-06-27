---
type: reference
title: "Martingale"
description: "In efficient markets, discounted prices should follow a martingale. The martingale property implies that trading strategies have zero"
tags: ["phase-2"]
difficulty: advanced
timestamp: "2026-06-27T03:06:09.400Z"
phase: 2
phaseName: "Mathematics & Statistics"
category: "Mathematics & Statistics"
subcategory: "mathematics"
language: "cpp"
artifact-id: "ZHFT_MARTINGALE"
---
## Key Learning Points

- In efficient markets, discounted prices should follow a martingale
- The martingale property implies that trading strategies have zero
- Doob decomposition splits any adapted process into a predictable
- The Optional Stopping Theorem: expected value at a stopping time
- P&L attribution decomposes trading P&L into factor returns and

## Usage

MartingaleDifferenceTest mds_test(returns);
auto result = mdsTest.test();
// result.is_martingale = true if null not rejected
PLDecomposition pnl_decomp;
pnl_decomp.addTrade(timestamp, price, position);
auto attribution = pnl_decomp.attribution();

## Source Code

```cpp
#include <vector>
#include <cmath>
#include <numeric>
#include <algorithm>
#include <stdexcept>
#include <span>
#include <random>

// ---------------------------------------------------------------------------
// Martingale Difference Sequence (MDS) test
// Tests H0: E[return_t | F_{t-1}] = 0  (zero conditional mean)
// ---------------------------------------------------------------------------
struct MDSTestResult {
    double ljung_box_stat;   // Q-statistic for autocorrelation of returns
    double ljung_box_pvalue;
    double variance_ratio;   // VR(k) — should be 1 under MDS
    double vr_stat;
    double vr_pvalue;
    double mean_return;
    double t_stat_mean;      // H0: mean = 0
    bool is_martingale;      // true if all tests fail to reject at 5%
    std::string description;
};

class MartingaleDifferenceTest {
public:
    explicit MartingaleDifferenceTest(std::span<const double> returns)
        : returns_(returns.begin(), returns.end()) {}

    MDSTestResult test() const {
        size_t n = returns_.size();
        if (n < 10) throw std::invalid_argument("Need >= 10 observations");

        MDSTestResult result;
        result.mean_return = std::accumulate(returns_.begin(),
                                              returns_.end(), 0.0) / n;
        result.t_stat_mean = result.mean_return / std::sqrt(variance() / n);

        // Ljung-Box Q-test for serial correlation up to lag floor(sqrt(n))
        size_t max_lag = static_cast<size_t>(std::sqrt(n));
        result.ljung_box_stat = ljungBox(max_lag);
        result.ljung_box_pvalue = chiSquaredCDF(max_lag,
            result.ljung_box_stat);

        // Variance ratio test
        size_t k = std::max<size_t>(2, n / 20);
        result.variance_ratio = varianceRatio(k);
        result.vr_stat = (result.variance_ratio - 1.0) /
                          std::sqrt(2.0 * (2 * k - 1) * (k - 1) / (3 * k * n));
        result.vr_pvalue = 2.0 * (1.0 - normalCDF(std::fabs(result.vr_stat)));

        // Overall verdict
        bool is_mds = result.ljung_box_pvalue > 0.05 &&
                      result.vr_pvalue > 0.05 &&
                      std::fabs(result.t_stat_mean) < 1.96;

        result.is_martingale = is_mds;

        if (is_mds) {
            result.description = "Series appears to be a martingale " \
                "difference sequence (no evidence against MDS)";
        } else if (result.ljung_box_pvalue <= 0.05) {
            result.description = "Rejected: significant autocorrelation " \
                "detected in returns";
        } else if (result.vr_pvalue <= 0.05) {
            result.description = "Rejected: variance ratio differs " \
                "significantly from 1 (mean reversion or trending)";
        } else {
            result.description = "Rejected: non-zero mean return " \
                "(possible drift or miscalibration)";
        }

        return result;
    }

    // Doob decomposition: return = predictable + martingale
    struct DoobDecomposition {
        std::vector<double> predictable;   // E[return_t | F_{t-1}]
        std::vector<double> martingale;     // return - predictable
    };

    DoobDecomposition decompose(size_t window = 20) const {
        // Estimate predictable component via rolling mean
        DoobDecomposition result;
        result.predictable.resize(returns_.size(), 0.0);
        result.martingale.resize(returns_.size(), 0.0);

        double sum = 0.0;
        for (size_t i = 0; i < returns_.size(); ++i) {
            if (i >= window) {
                sum -= returns_[i - window];
            }
            sum += returns_[i];
            double pred = (i + 1 >= window) ?
                          sum / std::min(i + 1, window) : 0.0;
            result.predictable[i] = pred;
            result.martingale[i] = returns_[i] - pred;
        }
        return result;
    }

private:
    std::vector<double> returns_;

    double variance() const {
        if (returns_.size() < 2) return 0.0;
        double mean = result_mean();
        double var = 0.0;
        for (auto r : returns_)
            var += (r - mean) * (r - mean);
        return var / (returns_.size() - 1);
    }

    double result_mean() const {
        return std::accumulate(returns_.begin(), returns_.end(), 0.0) /
               returns_.size();
    }

    double autocovariance(size_t lag) const {
        size_t n = returns_.size();
        if (lag >= n) return 0.0;
        double mean = result_mean();
        double cov = 0.0;
        for (size_t i = lag; i < n; ++i)
            cov += (returns_[i] - mean) * (returns_[i - lag] - mean);
        return cov / n;  // MLE-style
    }

    double ljungBox(size_t max_lag) const {
        size_t n = returns_.size();
        double Q = 0.0;
        for (size_t k = 1; k <= max_lag; ++k) {
            double rho_k = autocovariance(k) / autocovariance(0);
            Q += rho_k * rho_k / (n - k);
        }
        return n * (n + 2) * Q;
    }

    double varianceRatio(size_t k) const {
        size_t n = returns_.size();
        if (n < k + 1) return 1.0;

        // Var(return_t) = gamma_0
        double var1 = autocovariance(0);

        // Var(sum_{j=0}^{k-1} return_{t-j}) / k
        // = gamma_0 + 2 * sum_{j=1}^{k-1} (1 - j/k) * gamma_j
        double var_k = var1;
        for (size_t j = 1; j < k; ++j)
            var_k += 2.0 * (1.0 - static_cast<double>(j) / k) *
                     autocovariance(j);

        return var_k / (k * var1 + 1e-15);
    }

    static double normalCDF(double x) {
        return std::erfc(-x / std::sqrt(2.0)) / 2.0;
    }

    // Chi-squared CDF approximation
    static double chiSquaredCDF(double k, double x) {
        if (x <= 0) return 0.0;
        // For integer k, use incomplete gamma function ratio
        return std::gamma_p(k / 2.0, x / 2.0);
    }
};

// ---------------------------------------------------------------------------
// P&L Decomposition Framework
// Attributes trading P&L into alpha (expected) and noise (martingale)
// ---------------------------------------------------------------------------
class PLDecomposition {
public:
    struct Trade {
        double timestamp;
        double price;
        double position;     // +1 buy, -1 sell
        double signal;       // alpha signal (-1 to 1)
    };

    struct Attribution {
        double total_pnl;
        double alpha_pnl;       // P&L explained by signal
        double idiosyncratic_pnl; // unexplained (should be MDS)
        double r_squared;       // fraction explained
        double sharpe_ratio;    // of total P&L
        double mds_test_stat;   // Ljung-Box on idiosyncratic
        std::vector<double> residuals; // per-trade residuals
    };

    void addTrade(double ts, double price, double position,
                  double signal = 0.0) {
        if (!trades_.empty()) {
            double prev_price = trades_.back().price;
            double ret = (price - prev_price) / prev_price;
            double pnl = position * ret;
            total_pnl_ += pnl;
            total_pnl_sq_ += pnl * pnl;
        }

        trades_.push_back({ts, price, position, signal});
    }

    Attribution attribution(double risk_free_rate = 0.0) const {
        if (trades_.size() < 2)
            return {0, 0, 0, 0, 0, 0, {}};

        size_t n = trades_.size();
        std::vector<double> pnl_vec(n - 1);
        std::vector<double> signal_vec(n - 1);
        std::vector<double> residual_vec(n - 1);

        for (size_t i = 1; i < n; ++i) {
            double prev_price = trades_[i - 1].price;
            double curr_price = trades_[i].price;
            double ret = (curr_price - prev_price) / prev_price;
            double position = trades_[i - 1].position;
            pnl_vec[i - 1] = position * ret;
            signal_vec[i - 1] = trades_[i - 1].signal;
        }

        // Regress pnl on signal (alpha model)
        // pnl_t = alpha * signal_t + epsilon_t
        double sum_s = 0.0, sum_p = 0.0, sum_ss = 0.0, sum_sp = 0.0;
        for (size_t i = 0; i < n - 1; ++i) {
            sum_s += signal_vec[i];
            sum_p += pnl_vec[i];
            sum_ss += signal_vec[i] * signal_vec[i];
            sum_sp += signal_vec[i] * pnl_vec[i];
        }

        double alpha_coeff = 0.0;
        double ss_denom = (n - 1) * sum_ss - sum_s * sum_s;
        if (std::fabs(ss_denom) > 1e-15)
            alpha_coeff = ((n - 1) * sum_sp - sum_s * sum_p) / ss_denom;

        double total_ss = 0.0, explained_ss = 0.0, residual_ss = 0.0;
        double mean_pnl = sum_p / (n - 1);
        double pnl_sum = 0.0, pnl_sum_sq = 0.0;

        for (size_t i = 0; i < n - 1; ++i) {
            double predicted = alpha_coeff * signal_vec[i];
            double residual = pnl_vec[i] - predicted;
            residual_vec[i] = residual;

            pnl_sum += pnl_vec[i];
            pnl_sum_sq += pnl_vec[i] * pnl_vec[i];

            total_ss += (pnl_vec[i] - mean_pnl) * (pnl_vec[i] - mean_pnl);
            explained_ss += (predicted - mean_pnl) * (predicted - mean_pnl);
            residual_ss += residual * residual;
        }

        double r_squared = (total_ss > 0) ? explained_ss / total_ss : 0.0;
        double total_pnl = std::accumulate(pnl_vec.begin(), pnl_vec.end(), 0.0);
        double mean_pnl_t = total_pnl / (n - 1);
        double std_pnl = std::sqrt(pnl_sum_sq / (n - 1) -
                          mean_pnl_t * mean_pnl_t);
        double sharpe = (std_pnl > 0) ? (mean_pnl_t - risk_free_rate) / std_pnl *
                        std::sqrt(static_cast<double>(n - 1)) : 0.0;

        // MDS test on residuals
        MartingaleDifferenceTest mds_test(residual_vec);
        auto mds_result = mds_test.test();

        Attribution attr;
        attr.total_pnl = total_pnl;
        attr.alpha_pnl = alpha_coeff * (sum_s / (n - 1)) * (n - 1);
        attr.idiosyncratic_pnl = total_pnl - attr.alpha_pnl;
        attr.r_squared = r_squared;
        attr.sharpe_ratio = sharpe;
        attr.mds_test_stat = mds_result.ljung_box_stat;
        attr.residuals = std::move(residual_vec);

        return attr;
    }

    // Optional Stopping Theorem check: expected P&L at stop-loss should
    // equal current P&L if strategy is a martingale
    struct StoppingTimeCheck {
        double current_pnl;
        double expected_continuation_pnl;
        double observed_continuation_pnl;
        bool optional_stopping_holds;
    };

    StoppingTimeCheck checkOptionalStopping(double stop_loss_pct) const {
        if (trades_.empty()) return {0, 0, 0, true};

        double current_pnl = total_pnl_;
        double entry_price = trades_[0].price;
        double stop_price = entry_price * (1.0 - stop_loss_pct);

        // Simulate continuation to stop-loss (simplified)
        double expected_continuation = 0.0;
        // Under martingale, expected continuation P&L = 0
        for (size_t i = 1; i < trades_.size(); ++i) {
            if (trades_[i].price <= stop_price) {
                double ret = (trades_[i].price - entry_price) / entry_price;
                expected_continuation = trades_[i].position * ret;
                break;
            }
        }

        return {current_pnl, 0.0, expected_continuation,
                std::fabs(expected_continuation) < 0.01};
    }

    void reset() {
        trades_.clear();
        total_pnl_ = 0.0;
        total_pnl_sq_ = 0.0;
    }

private:
    std::vector<Trade> trades_;
    double total_pnl_ = 0.0;
    double total_pnl_sq_ = 0.0;
};

// ---------------------------------------------------------------------------
// Fair Game / Martingale property test for a single price series
// Tests E[P_{t+1} | F_t] = P_t
// ---------------------------------------------------------------------------
class FairGameTest {
public:
    static bool testMartingaleProperty(std::span<const double> price) {
        if (price.size() < 3) return false;

        // Test: regress P_{t+1} on P_t, coefficient should be 1
        size_t n = price.size() - 1;
        double sum_x = 0.0, sum_y = 0.0, sum_xx = 0.0, sum_xy = 0.0;

        for (size_t i = 0; i < n; ++i) {
            double x = price[i];
            double y = price[i + 1];
            sum_x += x;
            sum_y += y;
            sum_xx += x * x;
            sum_xy += x * y;
        }

        double beta = (n * sum_xy - sum_x * sum_y) /
                      (n * sum_xx - sum_x * sum_x + 1e-15);
        double alpha = (sum_y - beta * sum_x) / n;

        // Compute residuals
        double sse = 0.0;
        for (size_t i = 0; i < n; ++i) {
            double pred = alpha + beta * price[i];
            double res = price[i + 1] - pred;
            sse += res * res;
        }

        double se_beta = std::sqrt(sse / (n - 2) /
                         (sum_xx - sum_x * sum_x / n));
        double t_stat = (beta - 1.0) / (se_beta + 1e-15);

        // |t_stat| < 2 => fail to reject martingale at 5%
        return std::fabs(t_stat) < 2.0;
    }
};
```
