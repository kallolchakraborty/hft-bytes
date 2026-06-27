---
type: reference
title: "Kalman Filter"
description: "State-space representation decomposes an observed time series into. The predict-update cycle: state prediction using process model,"
tags: ["time-series"]
timestamp: "2026-06-27T03:06:09.400Z"
phase: 2
phaseName: "Mathematics & Statistics"
category: "Mathematics & Statistics"
subcategory: "mathematics"
language: "cpp"
artifact-id: "ZHFT_KALMAN_FILTER"
---
## Key Learning Points

- State-space representation decomposes an observed time series into
- The predict-update cycle: state prediction using process model,
- Kalman gain balances model uncertainty vs measurement noise; high gain
- Covariance dynamics track estimation uncertainty through predict
- Adaptive tuning via covariance matching or maximum-likelihood

## Usage

KalmanFilter<1, 1> kf;
kf.setInitialState(100.0, 1.0);
for (double price : ticks) {
kf.predict(/* A= */ 1.0, /* Q= */ 0.01);

## Source Code

```cpp
*       kf.update(price, /* H= */ 1.0, /* R= */ 0.1);
 *       double filtered = kf.state()[0];
 *   }
 *
 * PERFORMANCE TARGET:
 *   Single predict+update for dim=1: <20ns
 *   Single predict+update for dim=6: <150ns
 *   Batch of 1M ticks (dim=1): <25ms
 * ====================================================================
 */

#include <array>
#include <cmath>
#include <stdexcept>
#include <span>
#include <type_traits>

// ---------------------------------------------------------------------------
// Fixed-size matrix class for Kalman filter linear algebra
// Stack-allocated for cache locality; avoids Eigen dependency
// ---------------------------------------------------------------------------
template <size_t R, size_t C>
struct Matrix {
    std::array<std::array<double, C>, R> data{};

    double& operator()(size_t r, size_t c) { return data[r][c]; }
    const double& operator()(size_t r, size_t c) const { return data[r][c]; }

    Matrix<C, R> transpose() const {
        Matrix<C, R> t;
        for (size_t i = 0; i < R; ++i)
            for (size_t j = 0; j < C; ++j)
                t(j, i) = data[i][j];
        return t;
    }

    template <size_t C2>
    Matrix<R, C2> operator*(const Matrix<C, C2>& o) const {
        Matrix<R, C2> r{};
        for (size_t i = 0; i < R; ++i)
            for (size_t k = 0; k < C; ++k)
                for (size_t j = 0; j < C2; ++j)
                    r(i, j) += data[i][k] * o(k, j);
        return r;
    }

    Matrix<R, C> operator+(const Matrix<R, C>& o) const {
        Matrix<R, C> r{};
        for (size_t i = 0; i < R; ++i)
            for (size_t j = 0; j < C; ++j)
                r(i, j) = data[i][j] + o(i, j);
        return r;
    }

    Matrix<R, C> operator-(const Matrix<R, C>& o) const {
        Matrix<R, C> r{};
        for (size_t i = 0; i < R; ++i)
            for (size_t j = 0; j < C; ++j)
                r(i, j) = data[i][j] - o(i, j);
        return r;
    }

    Matrix<R, C>& operator+=(const Matrix<R, C>& o) {
        for (size_t i = 0; i < R; ++i)
            for (size_t j = 0; j < C; ++j)
                data[i][j] += o(i, j);
        return *this;
    }

    Matrix<R, C> operator*(double s) const {
        Matrix<R, C> r = *this;
        for (size_t i = 0; i < R; ++i)
            for (size_t j = 0; j < C; ++j)
                r(i, j) *= s;
        return r;
    }

    // Set to identity matrix (square only)
    void setIdentity() {
        for (size_t i = 0; i < R; ++i)
            for (size_t j = 0; j < C; ++j)
                data[i][j] = (i == j) ? 1.0 : 0.0;
    }

    // Invert square matrix via Gauss-Jordan
    Matrix<R, R> inverse() const {
        static_assert(R == C, "Inverse requires square matrix");
        Matrix<R, R> inv;
        inv.setIdentity();
        Matrix<R, R> a = *this;

        for (size_t col = 0; col < R; ++col) {
            size_t pivot = col;
            for (size_t row = col + 1; row < R; ++row)
                if (std::fabs(a(row, col)) > std::fabs(a(pivot, col)))
                    pivot = row;
            if (std::fabs(a(pivot, col)) < 1e-15) {
                // Singular — return identity (caller should handle)
                inv.setIdentity();
                return inv;
            }
            for (size_t j = 0; j < R; ++j) {
                std::swap(a(col, j), a(pivot, j));
                std::swap(inv(col, j), inv(pivot, j));
            }
            double piv_val = a(col, col);
            for (size_t j = 0; j < R; ++j) {
                a(col, j) /= piv_val;
                inv(col, j) /= piv_val;
            }
            for (size_t row = 0; row < R; ++row) {
                if (row == col) continue;
                double factor = a(row, col);
                for (size_t j = 0; j < R; ++j) {
                    a(row, j) -= factor * a(col, j);
                    inv(row, j) -= factor * inv(col, j);
                }
            }
        }
        return inv;
    }
};

// Column vector = Matrix<Dim, 1>
template <size_t N>
using Vector = Matrix<N, 1>;

// ---------------------------------------------------------------------------
// Generic Kalman Filter with compile-time dimensions
//   State:     x (DimX x 1)
//   Control:   u (DimU x 1)
//   Measure:   z (DimZ x 1)
//   State trans: A (DimX x DimX)
//   Control model: B (DimX x DimU)
//   Measure model: H (DimZ x DimX)
//   Process cov: Q (DimX x DimX)
//   Measure cov: R (DimZ x DimZ)
// ---------------------------------------------------------------------------
template <size_t DimX, size_t DimZ, size_t DimU = 0>
class KalmanFilter {
public:
    KalmanFilter() {
        P_.setIdentity();
    }

    // Set initial state estimate and covariance
    void setInitialState(const Vector<DimX>& x0,
                          const Matrix<DimX, DimX>& P0) {
        x_ = x0;
        P_ = P0;
    }

    // Convenience for 1D case
    void setInitialState(double x0, double P0) {
        static_assert(DimX == 1);
        x_(0, 0) = x0;
        P_(0, 0) = P0;
    }

    // Predict step: x_pred = A*x + B*u;  P_pred = A*P*A' + Q
    void predict(const Matrix<DimX, DimX>& A,
                  const Matrix<DimX, DimX>& Q) {
        // x = A * x
        Matrix<DimX, 1> x_new{};
        for (size_t i = 0; i < DimX; ++i)
            for (size_t k = 0; k < DimX; ++k)
                x_new(i, 0) += A(i, k) * x_(k, 0);
        x_ = x_new;

        // P = A * P * A' + Q
        Matrix<DimX, DimX> AP = A * P_;
        Matrix<DimX, DimX> APA = AP * A.transpose();
        P_ = APA + Q;
    }

    // Predict with control input
    void predict(const Matrix<DimX, DimX>& A,
                  const Matrix<DimX, DimU>& B,
                  const Vector<DimU>& u,
                  const Matrix<DimX, DimX>& Q) {
        // x = A*x + B*u
        Matrix<DimX, 1> x_new{};
        for (size_t i = 0; i < DimX; ++i) {
            for (size_t k = 0; k < DimX; ++k)
                x_new(i, 0) += A(i, k) * x_(k, 0);
            for (size_t k = 0; k < DimU; ++k)
                x_new(i, 0) += B(i, k) * u(k, 0);
        }
        x_ = x_new;
        // P = A*P*A' + Q
        P_ = (A * P_ * A.transpose()) + Q;
    }

    // Update step: K = P*H' * inv(H*P*H' + R)
    //              x = x + K*(z - H*x)
    //              P = (I - K*H)*P
    void update(const Vector<DimZ>& z,
                 const Matrix<DimZ, DimX>& H,
                 const Matrix<DimZ, DimZ>& R) {
        // Innovation: y = z - H*x
        Vector<DimZ> y;
        for (size_t i = 0; i < DimZ; ++i) {
            y(i, 0) = z(i, 0);
            for (size_t k = 0; k < DimX; ++k)
                y(i, 0) -= H(i, k) * x_(k, 0);
        }

        // S = H * P * H' + R
        Matrix<DimZ, DimX> HP = H * P_;
        Matrix<DimZ, DimZ> S = HP * H.transpose();
        S = S + R;

        // K = P * H' * inv(S)
        Matrix<DimX, DimZ> PHt = P_ * H.transpose();
        Matrix<DimZ, DimZ> Sinv = S.inverse();
        Matrix<DimX, DimZ> K = PHt * Sinv;

        // x = x + K * y
        for (size_t i = 0; i < DimX; ++i)
            for (size_t k = 0; k < DimZ; ++k)
                x_(i, 0) += K(i, k) * y(k, 0);

        // P = (I - K*H) * P
        Matrix<DimX, DimX> I;
        I.setIdentity();
        Matrix<DimX, DimX> KH = K * H;
        Matrix<DimX, DimX> ImKH = I - KH;
        P_ = ImKH * P_;
    }

    // Scalar measurement convenience
    void update(double z,
                 double H_val,
                 double R_val) {
        static_assert(DimZ == 1);
        Vector<1> z_vec;
        z_vec(0, 0) = z;
        Matrix<1, DimX> H_mat;
        H_mat(0, 0) = H_val;
        if constexpr (DimX > 1) {
            for (size_t i = 1; i < DimX; ++i)
                H_mat(0, i) = 0.0;
        }
        Matrix<1, 1> R_mat;
        R_mat(0, 0) = R_val;
        update(z_vec, H_mat, R_mat);
    }

    // Accessors
    const Vector<DimX>& state() const { return x_; }
    double state(size_t i) const { return x_(i, 0); }
    const Matrix<DimX, DimX>& covariance() const { return P_; }
    double covariance(size_t i, size_t j) const { return P_(i, j); }

    // Innovation (pre-fit residual) - useful for adaptive tuning
    Vector<DimZ> innovation(const Vector<DimZ>& z,
                             const Matrix<DimZ, DimX>& H) const {
        Vector<DimZ> y;
        for (size_t i = 0; i < DimZ; ++i) {
            y(i, 0) = z(i, 0);
            for (size_t k = 0; k < DimX; ++k)
                y(i, 0) -= H(i, k) * x_(k, 0);
        }
        return y;
    }

private:
    Vector<DimX> x_{};          // State estimate
    Matrix<DimX, DimX> P_{};    // Estimate covariance
};

// ---------------------------------------------------------------------------
// Adaptive Kalman Filter: tunes Q and R from innovation sequence
// Uses covariance matching: adjusts R so innovation covariance matches
// theoretical S = H*P*H' + R
// ---------------------------------------------------------------------------
template <size_t DimX, size_t DimZ>
class AdaptiveKalmanFilter : private KalmanFilter<DimX, DimZ> {
    using Base = KalmanFilter<DimX, DimZ>;

public:
    using Base::predict;
    using Base::state;
    using Base::covariance;

    void update(const Vector<DimZ>& z,
                const Matrix<DimZ, DimX>& H,
                Matrix<DimZ, DimZ>& R_adapt) {
        // Compute innovation before update
        Vector<DimZ> innov = Base::innovation(z, H);

        // Update running innovation covariance
        ++n_innov_;
        for (size_t i = 0; i < DimZ; ++i) {
            double delta = innov(i, 0) - innov_mean_[i];
            innov_mean_[i] += delta / n_innov_;
            double delta2 = innov(i, 0) - innov_mean_[i];
            innov_var_[i] += delta * delta2;
        }

        // Adaptive R: match empirical innovation covariance
        // Theoretical S = H*P*H' + R. If empirical S > theoretical,
        // increase R; if empirical < theoretical, decrease R.
        if (n_innov_ > adaptation_delay_) {
            double emp_var = innov_var_[0] / n_innov_;
            // Simple scaling heuristic
            double scale = std::clamp(emp_var / std::max(1e-10,
                (H * Base::covariance() * H.transpose())(0,0) + R_adapt(0,0)),
                                      0.1, 10.0);
            for (size_t i = 0; i < DimZ; ++i)
                R_adapt(i, i) *= scale;
        }

        // Standard KF update
        Base::update(z, H, R_adapt);
    }

private:
    static constexpr size_t adaptation_delay_ = 100;
    size_t n_innov_ = 0;
    std::array<double, DimZ> innov_mean_{};
    std::array<double, DimZ> innov_var_{};
};

// ---------------------------------------------------------------------------
// Example: Mid-price estimation from noisy bid/ask quotes
// State: [mid_price, fair_spread]
// Measure: bid_price, ask_price
// ---------------------------------------------------------------------------
class MidPriceEstimator {
    using KF = KalmanFilter<2, 2>;
    KF kf_;

public:
    MidPriceEstimator() {
        // Initial state: price=100, half-spread=0.01
        Vector<2> x0;
        x0(0, 0) = 100.0;
        x0(1, 0) = 0.01;
        Matrix<2, 2> P0;
        P0(0, 0) = 1.0;   P0(0, 1) = 0.0;
        P0(1, 0) = 0.0;   P0(1, 1) = 0.01;
        kf_.setInitialState(x0, P0);
    }

    struct Quote {
        double bid, ask;
    };

    double processQuote(double bid, double ask) {
        Quote q{bid, ask};

        // Predict: random walk for mid, mean-reverting for spread
        Matrix<2, 2> A;
        A(0, 0) = 1.0;   A(0, 1) = 0.0;
        A(1, 0) = 0.0;   A(1, 1) = 0.95;  // spread mean-reverts
        Matrix<2, 2> Q;
        Q(0, 0) = 0.01;  Q(0, 1) = 0.0;
        Q(1, 0) = 0.0;   Q(1, 1) = 1e-6;
        kf_.predict(A, Q);

        // Measurement: H maps [mid, half_spread] -> [bid=mid-half, ask=mid+half]
        Matrix<2, 2> H;
        H(0, 0) = 1.0;   H(0, 1) = -1.0;
        H(1, 0) = 1.0;   H(1, 1) = 1.0;
        Matrix<2, 2> R;
        R(0, 0) = 0.01;  R(0, 1) = 0.0;
        R(1, 0) = 0.0;   R(1, 1) = 0.01;

        Vector<2> z;
        z(0, 0) = q.bid;
        z(1, 0) = q.ask;
        kf_.update(z, H, R);

        return kf_.state(0); // filtered mid-price
    }

    double estimatedSpread() const { return kf_.state(1) * 2.0; }
};
```
