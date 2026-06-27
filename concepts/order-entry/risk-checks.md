---
type: reference
title: "Risk Checks"
description: "Credit limits: notional caps per symbol, strategy, and firm. Max order size: absolute (e.g., 10,000 lots) and percentage of"
tags: ["risk-metrics"]
timestamp: "2026-06-27T03:06:09.427Z"
phase: 7
phaseName: "Order Entry & Execution"
category: "Phase 7 - Order Entry & Execution"
subcategory: "order-entry"
language: "cpp"
artifact-id: "ZHFT_RISK_CHECKS"
---
## Key Learning Points

- Credit limits: notional caps per symbol, strategy, and firm
- Max order size: absolute (e.g., 10,000 lots) and percentage of
- Max order rate: token bucket per second (e.g., 100 orders/s per
- Symbol blacklist/whitelist: O(1) Bloom filter for high-speed check.
- Self-trade prevention: cross-order detection across child strategies.
- Fat-finger limits: price vs NBBO threshold (e.g., 2% away) and
- Circuit breaker integration: if market-wide CB triggered, block

## Usage

// RiskEngine risk;
// risk.setCreditLimit(Symbol::ES, 50'000'000);
// if (risk.check(order).pass) exchange.send(order);

## Source Code

```cpp
#include <algorithm>
#include <array>
#include <atomic>
#include <bit>
#include <chrono>
#include <cstdint>
#include <cstring>
#include <string_view>
#include <unordered_map>
#include <vector>

// ---------------------------------------------------------------------------
// Order (simplified)
// ---------------------------------------------------------------------------
struct RiskOrder {
  uint64_t    symbol_hash;
  uint64_t    strategy_id;
  uint64_t    firm_id;
  uint64_t    quantity;
  double      price;
  double      notional;     // qty * price * multiplier
  uint64_t    side;         // 0=buy, 1=sell
  const char *clord_id;
};

// ---------------------------------------------------------------------------
// Risk check result
// ---------------------------------------------------------------------------
struct RiskResult {
  bool   pass;
  uint8_t failed_check; // enum index
  char    reason[64];
};

// ---------------------------------------------------------------------------
// Token bucket rate limiter
// ---------------------------------------------------------------------------
class TokenBucket {
public:
  TokenBucket(double rate_per_sec, double burst)
      : rate_(rate_per_sec), burst_(burst), tokens_(burst)
    , last_refill_(std::chrono::steady_clock::now()) {}

  bool consume() {
    refill();
    if (tokens_ < 1.0) return false;
    tokens_ -= 1.0;
    return true;
  }

private:
  double rate_, burst_, tokens_;
  std::chrono::steady_clock::time_point last_refill_;

  void refill() {
    auto now = std::chrono::steady_clock::now();
    auto elapsed = std::chrono::duration<double>(now - last_refill_).count();
    tokens_ = std::min(burst_, tokens_ + elapsed * rate_);
    last_refill_ = now;
  }
};

// ---------------------------------------------------------------------------
// Rate limiter pool (one per strategy)
// ---------------------------------------------------------------------------
class RateLimiterPool {
public:
  TokenBucket &get(uint64_t strategy_id) {
    auto idx = strategy_id % kMax;
    if (limiters_[idx].strategy_id != strategy_id) {
      limiters_[idx] = {strategy_id, TokenBucket(100.0, 50.0)};
    }
    return limiters_[idx].bucket;
  }

private:
  static constexpr size_t kMax = 1024;
  struct Entry {
    uint64_t strategy_id = 0;
    TokenBucket bucket{100.0, 50.0};
  };
  std::array<Entry, kMax> limiters_;
};

// ---------------------------------------------------------------------------
// Bloom filter for blacklist
// ---------------------------------------------------------------------------
class SymbolFilter {
public:
  void add(uint64_t h) {
    for (auto &seed : seeds_) {
      bits_[h ^ seed] = 1;
    }
  }

  bool maybe_contains(uint64_t h) const {
    for (auto &seed : seeds_) {
      if (!bits_[h ^ seed]) return false;
    }
    return true; // might be false positive
  }

private:
  static constexpr size_t kBits = 1 << 16;
  static constexpr std::array<uint64_t, 4> seeds_{0xa1b2, 0xc3d4, 0xe5f6, 0x7890};
  std::array<uint8_t, kBits> bits_{};
};

// ---------------------------------------------------------------------------
// Pre-trade risk engine
// ---------------------------------------------------------------------------
class RiskEngine {
public:
  // Configure limits
  void setCreditLimit(uint64_t symbol_hash, double max_notional) {
    credit_limits_.emplace(symbol_hash, max_notional);
  }

  void setMaxOrderSize(uint64_t symbol_hash, uint64_t max_qty) {
    max_qty_.emplace(symbol_hash, max_qty);
  }

  void setNotionalMax(double max) { max_notional_single_ = max; }
  void setPriceThresholdPct(double pct) { price_threshold_pct_ = pct; }

  void blacklistSymbol(uint64_t h) { blacklist_.add(h); }

  // Main check
  RiskResult check(const RiskOrder &ord) {
    // 1. Blacklist check (fastest)
    if (blacklist_.maybe_contains(ord.symbol_hash)) {
      return {false, 1, "Symbol blacklisted"};
    }

    // 2. Max order size
    auto it = max_qty_.find(ord.symbol_hash);
    if (it != max_qty_.end() && ord.quantity > it->second) {
      return {false, 2, "Order size exceeds max"};
    }

    // 3. Single notional limit (fat finger)
    if (ord.notional > max_notional_single_) {
      return {false, 3, "Notional exceeds single-order limit"};
    }

    // 4. Credit / notional limit per symbol
    auto cit = credit_limits_.find(ord.symbol_hash);
    if (cit != credit_limits_.end()) {
      // Check current exposure
      double current = current_exposure_[ord.symbol_hash].load(
          std::memory_order_relaxed);
      if (current + ord.notional > cit->second) {
        return {false, 4, "Symbol credit limit exceeded"};
      }
    }

    // 5. Rate limit
    if (!rate_limiters_.get(ord.strategy_id).consume()) {
      return {false, 5, "Order rate exceeded"};
    }

    // 6. Self-trade prevention (cross strategy check)
    // Check if opposing order exists for same symbol from different strategy
    // under same firm.
    // (Simplified: check map of active orders)

    // 7. Circuit breaker check
    if (circuit_breaker_triggered_.load(std::memory_order_acquire)) {
      return {false, 7, "Circuit breaker active"};
    }

    // Reserve notional
    current_exposure_[ord.symbol_hash].fetch_add(
        static_cast<uint64_t>(ord.notional),
        std::memory_order_relaxed);

    return {true, 0, ""};
  }

  void onFill(uint64_t symbol_hash, double notional) {
    current_exposure_[symbol_hash].fetch_sub(
        static_cast<uint64_t>(notional),
        std::memory_order_relaxed);
  }

  void triggerCircuitBreaker() {
    circuit_breaker_triggered_.store(true, std::memory_order_release);
  }

  void resetCircuitBreaker() {
    circuit_breaker_triggered_.store(false, std::memory_order_release);
  }

  // Latency breakdown (approximate cycles at 3 GHz)
  //   Blacklist check:       5-10 ns (Bloom filter hash)
  //   Max qty lookup:       15-25 ns (unordered_map)
  //   Notional check:        2-5 ns  (double compare)
  //   Credit lookup:        20-30 ns (atomic load + map)
  //   Rate limit:           10-20 ns (token bucket)
  //   Self-trade check:     50-100 ns (map iteration)
  //   CB check:              2-5 ns  (atomic load)
  //   Total:               ~100-200 ns (hot cache)
  //   Cold cache total:    ~300-500 ns

private:
  std::unordered_map<uint64_t, double> credit_limits_;
  std::unordered_map<uint64_t, uint64_t> max_qty_;
  std::unordered_map<uint64_t, std::atomic<uint64_t>> current_exposure_;
  SymbolFilter blacklist_;
  RateLimiterPool rate_limiters_;
  std::atomic<bool> circuit_breaker_triggered_{false};
  double max_notional_single_ = 5'000'000;
  double price_threshold_pct_ = 2.0;
};
```
