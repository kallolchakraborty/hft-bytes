---
type: reference
title: "Signal Proc"
description: "Fourier Transform detects periodicities in order flow and spread. Moving average crossover (fast/slow MA) is the simplest trend"
tags: ["time-series"]
timestamp: "2026-06-27T03:06:09.402Z"
phase: 2
phaseName: "Mathematics & Statistics"
category: "Mathematics & Statistics"
subcategory: "mathematics"
language: "cpp"
artifact-id: "ZHFT_SIGNAL_PROC"
---
## Key Learning Points

- Fourier Transform detects periodicities in order flow and spread
- Moving average crossover (fast/slow MA) is the simplest trend
- Volatility estimation at高频: realized variance (RV), Parkinson
- Multi-scale analysis via wavelets decomposes price into components
- All computations must be streaming (O(1) per tick) for real-time

## Usage

RollingZScore zscore(100);  // window of 100 ticks
for (double p : prices) {
double z = zscore.update(p);
if (z > 3.0) signal_sell = true;
}
FFTCycleDetector fft(1024);
auto freq = fft.detectDominantFrequencies(price_segment);

## Source Code

```cpp
#include <vector>
#include <cmath>
#include <complex>
#include <numeric>
#include <algorithm>
#include <numbers>
#include <span>
#include <array>
#include <cstring>
#include <x86intrin.h>

// ---------------------------------------------------------------------------
// Rolling Z-score (online normalization)
// ---------------------------------------------------------------------------
class RollingZScore {
public:
    explicit RollingZScore(size_t window)
        : window_(window), buffer_(window_), idx_(0), count_(0),
          sum_(0.0), sum_sq_(0.0) {}

    double update(double x) {
        if (count_ < window_) {
            buffer_[idx_] = x;
            sum_ += x;
            sum_sq_ += x * x;
            ++count_;
        } else {
            double old = buffer_[idx_];
            buffer_[idx_] = x;
            sum_ += x - old;
            sum_sq_ += (x * x - old * old);
        }
        idx_ = (idx_ + 1) % window_;

        size_t n = std::min(count_, window_);
        if (n < 2) return 0.0;

        double mean = sum_ / n;
        double var = sum_sq_ / n - mean * mean;
        double std = (var > 1e-15) ? std::sqrt(var) : 1.0;
        return (x - mean) / std;
    }

    double mean() const {
        size_t n = std::min(count_, window_);
        return (n > 0) ? sum_ / n : 0.0;
    }

    double stddev() const {
        size_t n = std::min(count_, window_);
        if (n < 2) return 0.0;
        double m = sum_ / n;
        double var = sum_sq_ / n - m * m;
        return (var > 0) ? std::sqrt(var) : 0.0;
    }

private:
    size_t window_;
    std::vector<double> buffer_;
    size_t idx_, count_;
    double sum_, sum_sq_;
};

// ---------------------------------------------------------------------------
// Fast Fourier Transform (Cooley-Tukey, radix-2, in-place)
// ---------------------------------------------------------------------------
class FFT {
public:
    static void forward(std::vector<std::complex<double>>& data) {
        size_t n = data.size();
        if (n == 0 || (n & (n - 1)) != 0)
            throw std::invalid_argument("FFT requires power-of-2 length");

        // Bit-reversal permutation
        for (size_t i = 1, j = 0; i < n; ++i) {
            size_t bit = n >> 1;
            for (; j & bit; bit >>= 1)
                j ^= bit;
            j ^= bit;
            if (i < j) std::swap(data[i], data[j]);
        }

        // Cooley-Tukey butterfly
        for (size_t len = 2; len <= n; len <<= 1) {
            double ang = -2.0 * std::numbers::pi / len;
            std::complex<double> wlen(std::cos(ang), std::sin(ang));
            for (size_t i = 0; i < n; i += len) {
                std::complex<double> w(1.0, 0.0);
                for (size_t j = 0; j < len / 2; ++j) {
                    std::complex<double> u = data[i + j];
                    std::complex<double> v = data[i + j + len / 2] * w;
                    data[i + j] = u + v;
                    data[i + j + len / 2] = u - v;
                    w *= wlen;
                }
            }
        }
    }

    // Power spectrum (squared magnitude of FFT coefficients)
    static std::vector<double> powerSpectrum(std::span<const double> input) {
        size_t n = nextPow2(input.size());
        std::vector<std::complex<double>> data(n, 0.0);
        for (size_t i = 0; i < input.size(); ++i)
            data[i] = std::complex<double>(input[i], 0.0);

        forward(data);

        std::vector<double> spectrum(n / 2);
        for (size_t i = 0; i < n / 2; ++i)
            spectrum[i] = std::norm(data[i]); // |X|^2
        return spectrum;
    }

private:
    static size_t nextPow2(size_t n) {
        size_t p = 1;
        while (p < n) p <<= 1;
        return p;
    }
};

// ---------------------------------------------------------------------------
// FFT-based cycle detector
// ---------------------------------------------------------------------------
class FFTCycleDetector {
public:
    explicit FFTCycleDetector(size_t fft_size) : fft_size_(fft_size) {
        if ((fft_size & (fft_size - 1)) != 0)
            throw std::invalid_argument("FFT size must be power of 2");
    }

    struct DominantFrequency {
        double normalized_freq; // 0 .. 0.5 (cycles per sample)
        double magnitude;
        double period_in_ticks; // 1/freq
    };

    std::vector<DominantFrequency> detectDominantFrequencies(
        std::span<const double> samples, size_t top_n = 3) {
        auto spectrum = FFT::powerSpectrum(samples);

        // Ignore DC (index 0)
        std::vector<std::pair<double, size_t>> freq_mag;
        for (size_t i = 1; i < spectrum.size(); ++i)
            freq_mag.emplace_back(spectrum[i], i);

        std::sort(freq_mag.begin(), freq_mag.end(),
            [](auto& a, auto& b) { return a.first > b.first; });

        std::vector<DominantFrequency> result;
        size_t n = std::min(top_n, freq_mag.size());
        for (size_t j = 0; j < n; ++j) {
            auto [mag, idx] = freq_mag[j];
            double norm_freq = static_cast<double>(idx) / (2.0 * spectrum.size());
            result.push_back({norm_freq, std::sqrt(mag),
                (norm_freq > 0) ? 1.0 / norm_freq : 0.0});
        }
        return result;
    }

private:
    size_t fft_size_;
};

// ---------------------------------------------------------------------------
// Moving Average Crossover Signal
// ---------------------------------------------------------------------------
class MACrossover {
public:
    MACrossover(size_t fast, size_t slow)
        : fast_sum_(0), slow_sum_(0),
          fast_count_(0), slow_count_(0),
          fast_idx_(0), slow_idx_(0),
          fast_window_(fast), slow_window_(slow),
          fast_buffer_(fast, 0.0), slow_buffer_(slow, 0.0) {}

    // Returns +1 (golden cross: fast > slow), -1 (death cross), 0 (no cross)
    int update(double price) {
        if (fast_count_ < fast_window_) {
            fast_buffer_[fast_count_] = price;
            fast_sum_ += price;
            ++fast_count_;
        } else {
            fast_sum_ -= fast_buffer_[fast_idx_];
            fast_buffer_[fast_idx_] = price;
            fast_sum_ += price;
            fast_idx_ = (fast_idx_ + 1) % fast_window_;
        }

        if (slow_count_ < slow_window_) {
            slow_buffer_[slow_count_] = price;
            slow_sum_ += price;
            ++slow_count_;
        } else {
            slow_sum_ -= slow_buffer_[slow_idx_];
            slow_buffer_[slow_idx_] = price;
            slow_sum_ += price;
            slow_idx_ = (slow_idx_ + 1) % slow_window_;
        }

        if (fast_count_ < fast_window_ || slow_count_ < slow_window_)
            return 0;

        double fast_ma = fast_sum_ / fast_window_;
        double slow_ma = slow_sum_ / slow_window_;

        int signal = 0;
        if (fast_ma > slow_ma && prev_fast_ <= prev_slow_)
            signal = 1;  // golden cross
        else if (fast_ma < slow_ma && prev_fast_ >= prev_slow_)
            signal = -1; // death cross

        prev_fast_ = fast_ma;
        prev_slow_ = slow_ma;
        return signal;
    }

private:
    size_t fast_window_, slow_window_;
    double fast_sum_, slow_sum_;
    size_t fast_count_, slow_count_;
    size_t fast_idx_, slow_idx_;
    std::vector<double> fast_buffer_, slow_buffer_;
    double prev_fast_ = 0.0, prev_slow_ = 0.0;
};

// ---------------------------------------------------------------------------
// Volatility Estimators
// ---------------------------------------------------------------------------
class VolatilityEstimators {
public:
    // Realized Volatility (closing prices only)
    static double realizedVol(std::span<const double> log_returns) {
        double sum_sq = 0.0;
        for (auto r : log_returns) sum_sq += r * r;
        return std::sqrt(sum_sq);
    }

    // Parkinson Volatility (high-low only) — efficient for continuous trading
    static double parkinson(std::span<const double> high,
                             std::span<const double> low) {
        size_t n = std::min(high.size(), low.size());
        if (n < 1) return 0.0;
        double sum = 0.0;
        for (size_t i = 0; i < n; ++i) {
            double hl = std::log(high[i] / low[i]);
            sum += hl * hl;
        }
        return std::sqrt(sum / (4.0 * std::log(2.0) * n));
    }

    // Yang-Zhang Volatility (as in ZHFT_STOCHASTIC_CALC, repeated for completeness)
    static double yangZhang(std::span<const double> open,
                              std::span<const double> high,
                              std::span<const double> low,
                              std::span<const double> close) {
        size_t n = std::min({open.size(), high.size(), low.size(), close.size()});
        if (n < 2) return 0.0;

        double vo = 0.0; // overnight gap variance
        for (size_t i = 1; i < n; ++i) {
            double gap = std::log(open[i] / close[i - 1]);
            vo += gap * gap;
        }
        vo /= (n - 1);

        double vc = 0.0; // open-close variance
        for (size_t i = 0; i < n; ++i) {
            double r = std::log(close[i] / open[i]);
            vc += r * r;
        }
        vc /= n;

        double vrs = 0.0; // Rogers-Satchell
        for (size_t i = 0; i < n; ++i) {
            double h = std::log(high[i] / open[i]);
            double l = std::log(low[i] / open[i]);
            double c = std::log(close[i] / open[i]);
            vrs += h * (h - c) + l * (l - c);
        }
        vrs /= n;

        double k = 0.34 / (1.34 + (n + 1.0) / (n - 1.0));
        return std::sqrt(vo + vc + k * vrs);
    }
};

// ---------------------------------------------------------------------------
// Simple Haar wavelet transform for multi-scale decomposition
// ---------------------------------------------------------------------------
class HaarWavelet {
public:
    // In-place forward Haar 1D transform
    static void forward(std::vector<double>& data) {
        size_t n = data.size();
        std::vector<double> tmp(n);
        while (n > 1) {
            n >>= 1;
            for (size_t i = 0; i < n; ++i) {
                tmp[i] = (data[2 * i] + data[2 * i + 1]) * 0.5;
                tmp[n + i] = (data[2 * i] - data[2 * i + 1]) * 0.5;
            }
            std::memcpy(data.data(), tmp.data(), 2 * n * sizeof(double));
        }
    }

    // Extract detail coefficient energy at each scale
    static std::vector<double> scaleEnergies(std::span<const double> input) {
        std::vector<double> data(input.begin(), input.end());
        forward(data);

        std::vector<double> energies;
        size_t n = input.size() / 2;
        while (n >= 1) {
            double e = 0.0;
            for (size_t i = n; i < 2 * n && i < data.size(); ++i)
                e += data[i] * data[i];
            energies.push_back(std::sqrt(e));
            n >>= 1;
        }
        return energies;
    }
};

// ---------------------------------------------------------------------------
// Combined signal processor for real-time use
// ---------------------------------------------------------------------------
class MarketSignalProcessor {
public:
    MarketSignalProcessor(size_t zscore_window,
                          size_t ma_fast, size_t ma_slow)
        : zscore_(zscore_window), macd_(ma_fast, ma_slow) {}

    struct Signals {
        double zscore;
        int ma_cross;       // -1, 0, or 1
        double zscore_signal; // 0 unless |zscore| > 3
    };

    Signals processTick(double price) {
        double z = zscore_.update(price);
        int cross = macd_.update(price);
        double z_sig = (std::fabs(z) > 3.0) ? z : 0.0;
        return {z, cross, z_sig};
    }

    const RollingZScore& zscore() const { return zscore_; }

private:
    RollingZScore zscore_;
    MACrossover macd_;
};
```
