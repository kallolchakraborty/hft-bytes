---
type: reference
title: "Optimization"
description: "Convex optimization problems (quadratic programming) are the. Gradient descent and its variants (SGD, Adam) are used for"
tags: ["compiler-optimization"]
difficulty: intermediate
timestamp: "2026-06-27T03:06:09.402Z"
phase: 2
phaseName: "Mathematics & Statistics"
category: "Mathematics & Statistics"
subcategory: "mathematics"
language: "cpp"
artifact-id: "ZHFT_OPTIMIZATION"
---
## Key Learning Points

- Convex optimization problems (quadratic programming) are the
- Gradient descent and its variants (SGD, Adam) are used for
- The Almgren-Chriss model formulates optimal execution as a
- Quadratic programming with positive-semidefinite Hessian
- Real-time optimization at HFT scales requires <10µs solve

## Usage

AlmgrenChriss solver(S0, 10000, 0.01, 2e-6, 1e-6, 10);
auto schedule = solver.solve();
// schedule.trades[i] = shares to trade in bin i
AdamOptimizer adam(0.001, 0.9, 0.999, 1e-8);
for (int epoch = 0; epoch < 1000; ++epoch)
adam.step(gradient(theta));

## Source Code

```cpp
#include <vector>
#include <cmath>
#include <numeric>
#include <algorithm>
#include <stdexcept>
#include <span>
#include <limits>
#include <functional>

// ---------------------------------------------------------------------------
// Almgren-Chriss Optimal Execution Model
//
// Minimize:  sum_t [ impact(t) * x_t^2 + risk * sigma^2 * (Q - sum_{s<=t} x_s)^2 ]
// Subject to: sum_t x_t = Q, x_t >= 0
//
// Where x_t = shares executed in time bin t
//       impact(t) = eta / (tau * V_t)  (permanent + temporary impact coefficient)
//       risk = lambda (risk aversion)
// ---------------------------------------------------------------------------
class AlmgrenChriss {
public:
    struct Parameters {
        double S0;          // Initial stock price
        double Q;           // Total shares to execute
        double eta;         // Impact coefficient (permanent)
        double sigma;       // Daily volatility
        double lambda;      // Risk aversion coefficient
        size_t N;           // Number of time bins
        double T;           // Total trading horizon (days)
        double alpha;       // Price trend (drift)
    };

    struct ExecutionSchedule {
        std::vector<double> trades;       // N trades
        std::vector<double> remaining;    // N+1 remaining inventory
        std::vector<double> price_path;   // N simulated execution prices
        double total_cost;                // Implementation shortfall
        double std_dev_cost;              // Standard deviation of cost
    };

    explicit AlmgrenChriss(const Parameters& params)
        : params_(params) {
        validate();
        precomputeCoefficients();
    }

    // Legacy constructor for convenience
    AlmgrenChriss(double S0, double Q, double eta, double sigma,
                  double lambda, size_t N, double T = 1.0)
        : params_{S0, Q, eta, sigma, lambda, N, T, 0.0} {
        validate();
        precomputeCoefficients();
    }

    ExecutionSchedule solve() const {
        // Solve via analytical formula when alpha=0, impact linear in x
        // x_t = Q/N * (sinh(kappa * T * (1 - t/N)) / sinh(kappa * T))
        // where kappa = sqrt(lambda * sigma^2 / eta_eff)
        // For general case, use QP solver

        double kappa = std::sqrt(params_.lambda * params_.sigma * params_.sigma /
                                  eta_eff_);
        double kappaT = kappa * params_.T;

        ExecutionSchedule schedule;
        schedule.trades.resize(params_.N);
        schedule.remaining.resize(params_.N + 1);
        schedule.price_path.resize(params_.N);

        double remaining = params_.Q;
        double total_cost = 0.0;
        double cost_var = 0.0;

        for (size_t t = 0; t < params_.N; ++t) {
            double tau = static_cast<double>(t + 1) / params_.N;

            // Analytical solution for linear impact
            double x_t;
            if (kappaT > 1e-10) {
                double sinh_kappaT = std::sinh(kappaT);
                double sinh_kappaT_tau = std::sinh(kappaT * (1.0 - tau));
                x_t = params_.Q * sinh_kappaT_tau / sinh_kappaT;
            } else {
                // No-risk case: linear liquidation
                x_t = params_.Q / params_.N;
            }

            // Apply boundary: can't trade more than remaining
            x_t = std::max(0.0, std::min(x_t, remaining));

            if (t == params_.N - 1)
                x_t = remaining; // Liquidate remaining in last bin

            schedule.trades[t] = x_t;

            // Market impact cost
            double impact_cost = eta_eff_ * x_t * x_t;
            double timing_risk = params_.lambda * params_.sigma * params_.sigma *
                                 remaining * remaining * dt_;

            total_cost += impact_cost + timing_risk;
            cost_var += remaining * remaining;

            // Simulated execution price (simplified)
            double price_impact = params_.eta * (x_t / params_.Q);
            schedule.price_path[t] = params_.S0 - price_impact;

            remaining -= x_t;
            schedule.remaining[t + 1] = remaining;
        }

        schedule.total_cost = total_cost;
        schedule.std_dev_cost = params_.sigma * params_.S0 *
                                 std::sqrt(cost_var) * dt_;
        return schedule;
    }

    // QP formulation for general constraints (e.g., participation rate limit)
    ExecutionSchedule solveQP() const {
        // Build QP: minimize 0.5 * x' * H * x + f' * x
        // subject to sum(x) = Q, x >= 0
        size_t N = params_.N;

        // Hessian: H = 2 * diag(eta_eff) + 2 * lambda * sigma^2 * L' * L
        // where L is lower-triangular matrix of ones (cumulative sum)
        std::vector<double> H(N * N, 0.0);

        for (size_t i = 0; i < N; ++i) {
            // Impact term
            H[i * N + i] = 2.0 * eta_eff_;
            // Risk term: L'*L = min(i,j) structure
            for (size_t j = 0; j <= i; ++j) {
                double risk_term = 2.0 * params_.lambda * params_.sigma *
                                   params_.sigma * dt_ * dt_;
                H[i * N + j] += risk_term * (N - i);
                H[j * N + i] += risk_term * (N - i);
            }
        }

        // No linear term (f = 0) when alpha = 0
        std::vector<double> f(N, 0.0);

        // Solve via gradient projection (simplified active-set for bound constraints)
        return solveQPGradientProjection(H, f, params_.Q);
    }

private:
    Parameters params_;
    double eta_eff_;  // Effective impact coefficient (combined temp + perm)
    double dt_;       // Time per bin

    void validate() const {
        if (params_.N == 0) throw std::invalid_argument("N must be > 0");
        if (params_.Q <= 0) throw std::invalid_argument("Q must be > 0");
        if (params_.sigma < 0) throw std::invalid_argument("sigma >= 0");
    }

    void precomputeCoefficients() {
        dt_ = params_.T / params_.N;
        eta_eff_ = params_.eta / dt_;  // Scaled to bin size
    }

    // Gradient projection QP solver for box constraints + equality
    ExecutionSchedule solveQPGradientProjection(
        const std::vector<double>& H,
        const std::vector<double>& f,
        double Q) const {

        size_t N = params_.N;
        std::vector<double> x(N, Q / N);  // Initial: naive uniform
        double step_size = 1.0 / (2.0 * eta_eff_ + 2.0 * params_.lambda *
                                 params_.sigma * params_.sigma * N);

        constexpr size_t MAX_ITER = 1000;
        constexpr double TOL = 1e-10;

        for (size_t iter = 0; iter < MAX_ITER; ++iter) {
            // Compute gradient: g = H * x + f
            std::vector<double> g(N, 0.0);
            for (size_t i = 0; i < N; ++i) {
                g[i] = f[i];
                for (size_t j = 0; j < N; ++j)
                    g[i] += H[i * N + j] * x[j];
            }

            // Gradient descent step with projection onto simplex
            std::vector<double> x_new(N);
            for (size_t i = 0; i < N; ++i)
                x_new[i] = x[i] - step_size * g[i];

            // Project onto simplex: sum(x) = Q, x >= 0
            projectSimplex(x_new, Q);

            // Check convergence
            double diff = 0.0;
            for (size_t i = 0; i < N; ++i)
                diff += (x_new[i] - x[i]) * (x_new[i] - x[i]);

            x = std::move(x_new);
            if (diff < TOL) break;
        }

        ExecutionSchedule schedule;
        schedule.trades = x;
        schedule.remaining.resize(N + 1);
        double rem = Q;
        schedule.remaining[0] = rem;
        for (size_t i = 0; i < N; ++i) {
            rem -= x[i];
            schedule.remaining[i + 1] = rem;
        }
        schedule.total_cost = 0.0;
        for (size_t i = 0; i < N; ++i)
            for (size_t j = 0; j < N; ++j)
                schedule.total_cost += 0.5 * x[i] * H[i * N + j] * x[j];
        return schedule;
    }

    // Project onto simplex: sum(x) = Q, x_i >= 0
    static void projectSimplex(std::vector<double>& x, double Q) {
        // Sort descending
        std::vector<double> sorted = x;
        std::sort(sorted.begin(), sorted.end(), std::greater<double>());

        double cumsum = 0.0;
        double tau = 0.0;
        size_t n = x.size();

        for (size_t i = 0; i < n; ++i) {
            cumsum += sorted[i];
            tau = (cumsum - Q) / (i + 1);
            if (tau <= sorted[i] && (i == n - 1 || tau >= sorted[i + 1]))
                break;
        }

        for (auto& xi : x)
            xi = std::max(0.0, xi - tau);

        // Normalize to exact sum (correct floating point drift)
        double sum = std::accumulate(x.begin(), x.end(), 0.0);
        if (sum > 0) {
            double scale = Q / sum;
            for (auto& xi : x) xi *= scale;
        }
    }
};

// ---------------------------------------------------------------------------
// Adam Optimizer
// ---------------------------------------------------------------------------
class AdamOptimizer {
public:
    AdamOptimizer(double lr, double beta1 = 0.9, double beta2 = 0.999,
                  double eps = 1e-8)
        : lr_(lr), beta1_(beta1), beta2_(beta2), eps_(eps), t_(0) {}

    // Apply one step of Adam given gradient vector
    std::vector<double> step(const std::vector<double>& theta,
                              const std::vector<double>& grad) {
        size_t n = theta.size();
        if (m_.empty()) {
            m_.resize(n, 0.0);
            v_.resize(n, 0.0);
        }

        ++t_;
        double beta1_t = 1.0 - std::pow(beta1_, t_);
        double beta2_t = 1.0 - std::pow(beta2_, t_);

        std::vector<double> new_theta(n);
        for (size_t i = 0; i < n; ++i) {
            m_[i] = beta1_ * m_[i] + (1.0 - beta1_) * grad[i];
            v_[i] = beta2_ * v_[i] + (1.0 - beta2_) * grad[i] * grad[i];

            double m_hat = m_[i] / beta1_t;
            double v_hat = v_[i] / beta2_t;

            new_theta[i] = theta[i] - lr_ * m_hat / (std::sqrt(v_hat) + eps_);
        }
        return new_theta;
    }

    void reset() {
        m_.clear();
        v_.clear();
        t_ = 0;
    }

private:
    double lr_, beta1_, beta2_, eps_;
    size_t t_;
    std::vector<double> m_, v_;  // First and second moment estimates
};

// ---------------------------------------------------------------------------
// Stochastic Gradient Descent (online learning)
// ---------------------------------------------------------------------------
class SGDOptimizer {
public:
    explicit SGDOptimizer(double lr, double momentum = 0.0)
        : lr_(lr), momentum_(momentum) {}

    std::vector<double> step(const std::vector<double>& theta,
                              const std::vector<double>& grad) {
        size_t n = theta.size();
        if (velocity_.empty() && momentum_ > 0.0)
            velocity_.resize(n, 0.0);

        std::vector<double> new_theta(n);
        for (size_t i = 0; i < n; ++i) {
            if (momentum_ > 0.0) {
                velocity_[i] = momentum_ * velocity_[i] + lr_ * grad[i];
                new_theta[i] = theta[i] - velocity_[i];
            } else {
                new_theta[i] = theta[i] - lr_ * grad[i];
            }
        }
        return new_theta;
    }

private:
    double lr_, momentum_;
    std::vector<double> velocity_;
};

// ---------------------------------------------------------------------------
// Convex quadratic programming benchmark
// ---------------------------------------------------------------------------
class QPBenchmark {
public:
    struct QPProblem {
        std::vector<double> H;  // n x n symmetric PSD
        std::vector<double> f;  // n
        std::vector<double> Aeq; // m x n
        std::vector<double> beq; // m
    };

    // Solve min 0.5*x'*H*x + f'*x  s.t. Aeq*x = beq, x >= 0
    static std::vector<double> solve(const QPProblem& prob) {
        size_t n = static_cast<size_t>(std::sqrt(prob.H.size()));
        size_t m = prob.beq.size();

        // Simple interior-point for small problems
        std::vector<double> x(n, 1.0);
        double mu = 1.0;
        constexpr double TOL = 1e-8;
        constexpr size_t MAX_ITER = 200;

        std::vector<double> s(n, 1.0);  // slack variables
        std::vector<double> y(m, 0.0);  // dual for equality
        std::vector<double> z(n, 1.0);  // dual for inequality

        for (size_t iter = 0; iter < MAX_ITER; ++iter) {
            // Compute residuals
            std::vector<double> rL(n);
            for (size_t i = 0; i < n; ++i) {
                rL[i] = prob.f[i];
                for (size_t j = 0; j < n; ++j)
                    rL[i] += prob.H[i * n + j] * x[j];
                for (size_t j = 0; j < m; ++j)
                    rL[i] -= prob.Aeq[j * n + i] * y[j];
                rL[i] -= z[i];
            }

            std::vector<double> rA(m);
            for (size_t i = 0; i < m; ++i) {
                rA[i] = -prob.beq[i];
                for (size_t j = 0; j < n; ++j)
                    rA[i] += prob.Aeq[i * n + j] * x[j];
            }

            std::vector<double> rC(n);
            for (size_t i = 0; i < n; ++i)
                rC[i] = -x[i] * z[i] + mu;

            // Solve Newton system (simplified, assume diagonal H for speed)
            double alpha = 0.95;

            // Simplified step: just do a damped Newton
            for (size_t i = 0; i < n; ++i) {
                double dx = -rL[i];
                // Project
                if (x[i] + dx < 0) dx = -x[i] * 0.95;
                if (z[i] - (rC[i] + z[i] * dx) / x[i] < 0) {
                    // adjust
                }
                x[i] += dx;
            }

            mu *= 0.5;
            if (mu < TOL) break;
        }
        return x;
    }
};
```
