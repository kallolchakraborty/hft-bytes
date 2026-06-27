---
type: reference
title: "Anomaly Detection"
description: "Spoofing pattern detection: layering — placing large orders at. Quote stuffing: rapid fire of order add/cancel on same symbol"
tags: ["phase-9"]
difficulty: advanced
timestamp: "2026-06-27T03:06:09.433Z"
phase: 9
phaseName: "Order Book & Microstructure"
category: "Phase 9 - Order Book & Microstructure"
subcategory: "order-book"
language: "cpp"
artifact-id: "ZHFT_ANOMALY_DETECTION"
---
## Key Learning Points

- Spoofing pattern detection: layering — placing large orders at
- Quote stuffing: rapid fire of order add/cancel on same symbol
- Wash trading: same entity both sides of trade, creating false
- Abnormal fill rate: an order fills much faster than historical
- Statistical detectors: use z-score, EWMA, or CUSUM on order

## Usage

// AnomalyDetector ad;
// ad.onOrderAdd({order, timestamp});
// ad.onOrderCancel({order_id, timestamp});
// ad.onTrade({buy_id, sell_id, qty, px, timestamp});
// if (auto alert = ad.detect()) { /* pause or investigate */ }

## Source Code

```cpp
*
 * PERFORMANCE TARGET:
 *   Per-event check < 100 ns; full scan (1s window) < 1 us
 * ====================================================================
 */

#include <algorithm>
#include <array>
#include <bit>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <deque>
#include <optional>
#include <string_view>
#include <unordered_map>
#include <vector>

// ---------------------------------------------------------------------------
// Anomaly types
// ---------------------------------------------------------------------------
enum class AnomalyType : uint8_t {
  SpoofingLayering,
  QuoteStuffing,
  WashTrading,
  AbnormalFillRate,
  OrderFlowToxicity,
  CancelSurge,
};

struct AnomalyAlert {
  AnomalyType type;
  uint64_t    timestamp_ns;
  double      score;         // Confidence 0-1
  std::string_view symbol;
  std::string details;
  bool        critical;      // Requires immediate action
};

// ---------------------------------------------------------------------------
// Spoofing detector (layering)
// ---------------------------------------------------------------------------
class SpoofingDetector {
public:
  struct LayeringSignal {
    double price;
    uint64_t size;
    uint64_t distance_ticks; // From best bid/ask
    uint64_t duration_ms;    // How long order lived
  };

  void onOrderAdd(uint64_t order_id, double price, uint64_t size,
                  double best_bid, double best_ask, double tick_size) {
    double distance = std::min(std::abs(price - best_bid),
                                std::abs(price - best_ask));
    uint64_t ticks = static_cast<uint64_t>(distance / tick_size);

    if (ticks > 5 && size > 1000) {
      // Potential spoof — track this order
      active_orders_[order_id] = {
          price, size, ticks, ticks,
          std::chrono::steady_clock::now()
      };
    }
  }

  void onOrderCancel(uint64_t order_id) {
    auto it = active_orders_.find(order_id);
    if (it == active_orders_.end()) return;

    auto now = std::chrono::steady_clock::now();
    auto duration = std::chrono::duration_cast<std::chrono::milliseconds>(
        now - it->second.created).count();

    // TRADEOFF: spoofing orders are typically cancelled within 10-500ms.
    // Threshold of 100ms catches most cases with few false positives.
    if (duration < 100 && it->second.distance_ticks > 5) {
      alerts_.push_back({
          AnomalyType::SpoofingLayering,
          (uint64_t)now.time_since_epoch().count(),
          0.8,
          "SPOOF_SYM",
          "Large order at " + std::to_string(it->second.distance_ticks) +
          " ticks cancelled in " + std::to_string(duration) + "ms",
          false
      });
    }

    active_orders_.erase(it);
  }

  std::vector<AnomalyAlert> pendingAlerts() {
    auto out = alerts_;
    alerts_.clear();
    return out;
  }

private:
  struct TrackedOrder {
    double price;
    uint64_t size;
    uint64_t ticks;
    uint64_t distance_ticks;
    std::chrono::steady_clock::time_point created;
  };
  std::unordered_map<uint64_t, TrackedOrder> active_orders_;
  std::vector<AnomalyAlert> alerts_;
};

// ---------------------------------------------------------------------------
// Quote stuffing detector
// ---------------------------------------------------------------------------
class QuoteStuffingDetector {
public:
  void onOrderAdd(std::string_view symbol) {
    auto &state = states_[std::string(symbol)];
    auto now = std::chrono::steady_clock::now();
    auto win_start = now - std::chrono::seconds(1);
    state.adds++;

    // Trim old records
    while (!state.timestamps.empty() && state.timestamps.front() < win_start)
      state.timestamps.pop_front();
    state.timestamps.push_back(now);
  }

  void onOrderCancel(std::string_view symbol) {
    auto &state = states_[std::string(symbol)];
    state.cancels++;
  }

  struct StuffingSignal {
    bool stuffed;
    double cancel_ratio;   // cancels / (adds + cancels)
    uint64_t order_rate;   // orders per second
  };

  StuffingSignal detect(std::string_view symbol) {
    auto &state = states_[std::string(symbol)];
    uint64_t total = state.adds + state.cancels;
    double ratio = total > 0
        ? static_cast<double>(state.cancels) / total
        : 0;

    // CRITICAL: >90% cancel ratio = likely stuffing
    // Also check raw rate > 200 orders/sec
    bool stuffed = (ratio > 0.90 && total > 200);
    if (stuffed) {
      alerts_.push_back({
          AnomalyType::QuoteStuffing,
          0, 0.95, symbol,
          "Cancel ratio: " + std::to_string(ratio) +
          ", rate: " + std::to_string(total) + "/sec",
          true
      });
    }

    // Reset counters periodically
    state.adds = 0;
    state.cancels = 0;

    return {stuffed, ratio, total};
  }

  std::vector<AnomalyAlert> alerts() { auto out = alerts_; alerts_.clear(); return out; }

private:
  struct PerSymbolState {
    uint64_t adds = 0;
    uint64_t cancels = 0;
    std::deque<std::chrono::steady_clock::time_point> timestamps;
  };
  std::unordered_map<std::string, PerSymbolState> states_;
  std::vector<AnomalyAlert> alerts_;
};

// ---------------------------------------------------------------------------
// Wash trading detector
// ---------------------------------------------------------------------------
class WashTradingDetector {
public:
  void onTrade(uint64_t buy_order_id, uint64_t sell_order_id,
               uint64_t qty, std::string_view symbol, uint64_t firm_id) {
    // Check if both sides are from same firm
    auto &buy_firm = order_firms_[buy_order_id];
    auto &sell_firm = order_firms_[sell_order_id];

    if (buy_firm == sell_firm && buy_firm != 0) {
      // Same firm on both sides — potential wash trade
      alerts_.push_back({
          AnomalyType::WashTrading,
          0, 0.9, symbol,
          "Same firm " + std::to_string(firm_id) +
          " on both sides, qty=" + std::to_string(qty),
          true
      });
    }
  }

  void registerOrderFirm(uint64_t order_id, uint64_t firm_id) {
    order_firms_[order_id] = firm_id;
  }

  std::vector<AnomalyAlert> alerts() { auto out = alerts_; alerts_.clear(); return out; }

private:
  std::unordered_map<uint64_t, uint64_t> order_firms_;
  std::vector<AnomalyAlert> alerts_;
};

// ---------------------------------------------------------------------------
// Abnormal fill rate detector (statistical)
// ---------------------------------------------------------------------------
class AbnormalFillDetector {
public:
  void recordFill(std::string_view symbol, uint64_t fill_qty,
                  uint64_t time_to_fill_us) {
    auto &stats = fill_stats_[std::string(symbol)];
    stats.times.push_back(time_to_fill_us);

    // EWMA mean and stddev
    if (stats.count == 0) {
      stats.mean = time_to_fill_us;
      stats.std = 0;
    } else {
      double alpha = 0.05; // smoothing factor
      double prev_mean = stats.mean;
      stats.mean = alpha * time_to_fill_us + (1 - alpha) * stats.mean;
      stats.std = std::sqrt(
          alpha * std::pow(time_to_fill_us - prev_mean, 2) +
          (1 - alpha) * stats.std * stats.std);
    }
    stats.count++;
  }

  std::optional<AnomalyAlert> check(std::string_view symbol,
                                     uint64_t time_to_fill_us) {
    auto &stats = fill_stats_[std::string(symbol)];
    if (stats.count < 10) return {}; // not enough data

    double z = (static_cast<double>(time_to_fill_us) - stats.mean)
             / (stats.std + 0.001);

    // |z| > 5 => 5-sigma event, ~1 in 3.5M probability (normal dist)
    if (std::abs(z) > 5.0) {
      return AnomalyAlert{
          AnomalyType::AbnormalFillRate,
          0, std::min(1.0, std::abs(z) / 10.0),
          symbol,
          "Fill time " + std::to_string(time_to_fill_us) +
          "us vs mean " + std::to_string((uint64_t)stats.mean) +
          "us (z=" + std::to_string(z) + ")",
          std::abs(z) > 7.0
      };
    }
    return {};
  }

private:
  struct FillStats {
    double mean = 0;
    double std = 0;
    uint64_t count = 0;
    std::deque<uint64_t> times;
  };
  std::unordered_map<std::string, FillStats> fill_stats_;
};

// ---------------------------------------------------------------------------
// Master anomaly detector
// ---------------------------------------------------------------------------
class AnomalyDetector {
public:
  void onOrderAdd(uint64_t order_id, double price, uint64_t size,
                  double bid, double ask, double tick,
                  std::string_view symbol) {
    spoof_detector_.onOrderAdd(order_id, price, size, bid, ask, tick);
    quote_stuffing_detector_.onOrderAdd(symbol);
  }

  void onOrderCancel(uint64_t order_id, std::string_view symbol) {
    spoof_detector_.onOrderCancel(order_id);
    quote_stuffing_detector_.onOrderCancel(symbol);
  }

  void onTrade(uint64_t buy_id, uint64_t sell_id, uint64_t qty,
               std::string_view symbol, uint64_t firm_id,
               uint64_t time_to_fill_us) {
    wash_detector_.onTrade(buy_id, sell_id, qty, symbol, firm_id);

    auto alert = fill_detector_.check(symbol, time_to_fill_us);
    if (alert) alerts_.push_back(*alert);
  }

  std::vector<AnomalyAlert> detect() {
    // Gather from all sub-detectors
    for (auto &a : spoof_detector_.pendingAlerts())
      alerts_.push_back(a);
    for (auto &a : quote_stuffing_detector_.alerts())
      alerts_.push_back(a);
    for (auto &a : wash_detector_.alerts())
      alerts_.push_back(a);

    auto out = alerts_;
    alerts_.clear();
    return out;
  }

private:
  SpoofingDetector spoof_detector_;
  QuoteStuffingDetector quote_stuffing_detector_;
  WashTradingDetector wash_detector_;
  AbnormalFillDetector fill_detector_;
  std::vector<AnomalyAlert> alerts_;
};
```
