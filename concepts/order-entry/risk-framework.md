---
type: reference
title: "Risk Management Framework"
description: "Real-time risk infrastructure: position limits, notional/size limits, rate limits, credit checks, VaR pre-trade, P&L stop-loss triggers, market risk by symbol/portfolio, and cross-venue kill-switch architecture."
tags: ["risk"]
difficulty: staff
timestamp: "2026-06-27T03:20:00.000Z"
phase: 7
phaseName: "Order Entry & Execution"
category: "Order Entry"
subcategory: "order-entry"
language: "cpp"
artifact-id: "ZHFT_RISK_FRAMEWORK"
---
## Key Learning Points

- Risk checks run inline on the order path (pre-trade) and asynchronously (post-trade); inline checks must complete in < 500 ns to avoid adding to the critical path
- Position limits: max long/short per symbol, max gross notional per portfolio, max net notional per trader/strategy; checked before each new order
- Notional/size limits: max order size, max order value, max outstanding orders per symbol; prevents fat-finger errors
- Rate limits: max orders/sec per symbol, per strategy, per gateway; sliding-window counter with microsecond precision
- Credit checks: exchange-granted credit limit, daily MTM against credit, block order if credit < notional + cushion
- VaR pre-trade: estimated PnL impact of order given current positions and vol; parametric VaR (delta-normal) computed on instrument risk factors
- Stop-loss triggers: mark-to-market PnL per strategy; if PnL < threshold, auto-flatten positions and disable strategy
- Kill-switch: multi-level circuit breakers: per-strategy, per-exchange, global; manual (GUI/hotkey) and automatic (credit exhausted, VaR breach)
- Order rate monitor: detect anomalous order-to-trade ratio (> 100:1) and throttle or block

## Usage

```cpp
struct PreTradeRisk {
    const RiskLimits* limits_;
    const PortfolioState* portfolio_;

    RiskResult check(const Order& order) {
        // 1. Order size limit
        if (order.qty > limits_->max_order_size(order.symbol))
            return RiskResult::EXCEEDS_MAX_SIZE;
        // 2. Position limit (post-fill projection)
        auto new_pos = portfolio_->position(order.symbol) + order.side * order.qty;
        if (std::abs(new_pos) > limits_->max_position(order.symbol))
            return RiskResult::EXCEEDS_POSITION_LIMIT;
        // 3. Notional limit (gross exposure)
        double new_notional = portfolio_->grossNotional() + order.qty * order.price;
        if (new_notional > limits_->max_gross_notional)
            return RiskResult::EXCEEDS_NOTIONAL;
        // 4. Rate limit (sliding window)
        if (!rateLimiter_.tryAcquire(order.symbol, 1))
            return RiskResult::RATE_LIMITED;
        // 5. VaR check (pre-trade incremental VaR)
        double incr_var = computeIncrementalVaR(order, portfolio_);
        if (incr_var > limits_->max_var_per_order)
            return RiskResult::VAR_BREACH;
        return RiskResult::PASS;
    }
};

// Kill-switch architecture
// Inline risk -> async risk -> strategy level -> exchange level -> global
// Each level can block orders independently
// Global kill-switch: set a shared memory flag checked at the NIC driver level
struct KillSwitch {
    std::atomic<bool> global_blocked_{false};
    std::atomic<uint64_t> blocked_strategies_mask_{0};
    bool isBlocked(uint64_t strategy_id) const {
        return global_blocked_.load(std::memory_order_acquire) ||
               (blocked_strategies_mask_.load(std::memory_order_acquire) & (1ULL << strategy_id));
    }
};
```

## Source Code

```cpp
// Order rate limiter with sliding window (microsecond buckets)
class OrderRateLimiter {
    static constexpr size_t BUCKETS = 1024;
    static constexpr uint64_t WINDOW_NS = 1'000'000'000; // 1 second
    std::array<std::atomic<uint32_t>, BUCKETS> buckets_{};

    bool tryAcquire(uint64_t symbol_id, uint32_t count = 1) {
        auto now = rdtscp();
        size_t idx = (now / (WINDOW_NS / BUCKETS)) % BUCKETS;
        // Reset stale bucket
        // Accumulate across all buckets in window
        // Check if total < max_per_sec
        return true; // simplified
    }
};
```
