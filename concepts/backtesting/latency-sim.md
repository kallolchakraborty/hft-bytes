---
type: reference
title: "Latency Sim"
description: "Network latency distribution: normal vs exponential vs empirical. Exchange processing latency: matching engine + gateway delay"
tags: ["performance"]
difficulty: advanced
timestamp: "2026-06-27T03:06:09.441Z"
phase: 11
phaseName: "Backtesting & Simulation"
category: "Phase 11 - Backtesting & Simulation"
subcategory: "backtesting"
language: "cpp"
artifact-id: "ZHFT_LATENCY_SIM"
---
## Key Learning Points

- Network latency distribution: normal vs exponential vs empirical
- Exchange processing latency: matching engine + gateway delay
- Colocation distance → speed-of-light delay (~1μs per 300m fiber)
- Coordinated omission: when measurement skips slow events, bias is severe
- Pluggable distribution models for Monte Carlo simulation

## Usage

LatencySim sim(LatencyModel::createExponential(50e-6));
auto delay = sim.sample();  // microseconds

## Source Code

```cpp
#include <random>
#include <memory>
#include <cmath>
#include <vector>

// --------------------------------------------------------------------
// Abstract latency distribution

class LatencyDistribution {
public:
    virtual double sample() = 0;
    virtual ~LatencyDistribution() = default;
};

class NormalLatency : public LatencyDistribution {
    std::mt19937_64 rng_{42};  // deterministic seed for reproducibility
    std::normal_distribution<double> dist_;
public:
    explicit NormalLatency(double mean, double stddev)
        : dist_(mean, stddev) {}
    double sample() override { return std::max(0.0, dist_(rng_)); }
};

class ExponentialLatency : public LatencyDistribution {
    std::mt19937_64 rng_{42};
    std::exponential_distribution<double> dist_;
public:
    explicit ExponentialLatency(double rate_us)
        : dist_(1.0 / rate_us) {}
    double sample() override { return dist_(rng_); }
};

class EmpiricalLatency : public LatencyDistribution {
    std::mt19937_64 rng_{42};
    std::vector<double> samples_;
    std::uniform_int_distribution<size_t> idx_;
public:
    EmpiricalLatency(const std::vector<double>& measured)
        : samples_(measured), idx_(0, measured.size() - 1) {}
    double sample() override { return samples_[idx_(rng_)]; }
};

// --------------------------------------------------------------------
// Colocation Distance Calculator

class ColoDistanceCalc {
    // approximate great-circle distance → fiber path delay (+40% detour)
    static constexpr double FIBER_DETOUR = 1.4;
    static constexpr double SPEED_OF_LIGHT_NS_PER_M = 3.335;  // ns/m in vacuum
    static constexpr double FIBER_INDEX = 1.48;  // refraction index of glass

public:
    struct Location {
        double lat, lon;  // degrees
    };

    // tradeoff: Haversine vs Vincenty (sub-meter vs sub-mm)
    static double haversine(const Location& a, const Location& b) {
        double dlat = (b.lat - a.lat) * M_PI / 180.0;
        double dlon = (b.lon - a.lon) * M_PI / 180.0;
        double alat = a.lat * M_PI / 180.0;
        double blat = b.lat * M_PI / 180.0;
        double h = std::sin(dlat/2)*std::sin(dlat/2)
                 + std::cos(alat)*std::cos(blat)
                 * std::sin(dlon/2)*std::sin(dlon/2);
        return 2 * 6371000 * std::asin(std::sqrt(h));  // meters
    }

    static double latencyNs(const Location& a, const Location& b) {
        double dist_m = haversine(a, b) * FIBER_DETOUR;
        return dist_m * SPEED_OF_LIGHT_NS_PER_M * FIBER_INDEX;
    }
};

// --------------------------------------------------------------------
// Pluggable Latency Simulator

class LatencySim {
    std::unique_ptr<LatencyDistribution> dist_;
    double base_{0};  // fixed base latency

public:
    LatencySim(std::unique_ptr<LatencyDistribution> dist, double base = 0)
        : dist_(std::move(dist)), base_(base) {}

    double sample() { return base_ + dist_->sample(); }
};
```
