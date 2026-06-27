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
- **Latency budget decomposition per check**: each check in the inline risk path must have a known latency budget. Measured costs (Intel Ice Lake @ 4.0 GHz): (1) order size limit — 4ns (single compare); (2) position limit — 8ns (atomic load + compare); (3) notional limit — 20ns (atomic load + 2 FP multiplies); (4) rate limiter — 30ns (bucket index calc + atomic increment + sum); (5) VaR — ~200ns (3 FP multiplies + 2 additions + table lookup). Total: ~262ns optimistic, ~400ns with cache misses. Budget target: < 500ns at p99. Each cache miss adds ~80ns (L3) — ensure risk state fits in L2 cache per core (< 1MB total). NUMA placement: risk counters must be on the same NUMA node as the order thread. Use `mmap` with `MAP_HUGETLB` and `mbind` for deterministic memory placement
- **Concurrency and contention**: multiple order-entry threads (one per venue) may hit the same risk counters. A global position counter updated atomically by 20 threads creates contention — the cache line bounces between cores, adding 100-300ns per update. Solutions: (a) **per-thread sharding** — each thread owns a subset of symbols (by hash); no shared write state; (b) **DCAS (Double Compare-And-Swap)** on 16-byte structs for multi-field updates; (c) **reduce false sharing** — pad every atomic counter to 64 bytes (`alignas(64)`); (d) **NUMA-aware partitioning** — symbols are partitioned by NUMA node, each risk checker only touches local memory. The rate limiter is the hardest — it needs a global per-symbol counter. Use a bloom-filter–based rate limiter that hashes symbol_id into a large bit array and uses approximate counting (error < 5%, no false negatives)
- **Check ordering for fail-fast**: the order of checks in the inline path determines how quickly bad orders are rejected. Optimal ordering by cheapest-to-reject: (1) rate limit (cheapest, rejects most garbage — duplicate orders, storm orders); (2) order size limit (rejects fat-finger fat orders); (3) position limit (rejects excess exposure); (4) notional limit (rejects excess gross exposure); (5) VaR (most expensive, runs last). Rationale: ~60% of rejected orders fail at the rate limiter; ~25% at size; ~10% at position; ~5% at notional/VaR. By checking rate first, the average cost per rejected order is ~30ns instead of ~200ns. The VaR check is the only one that needs full portfolio state — it should be the last gate. For orders that pass all checks: total time ~300ns. For orders that fail at rate limit: total time ~30ns
- **Aggregation risk (delta-equivalent baskets)**: a position limit per symbol is insufficient — a strategy may have 100 shares of AAPL and -100 shares of AAPL at a different venue (net zero), which is fine. But 500 shares of AAPL and -50 contracts of MES (Micro E-mini S&P 500) has net delta exposure to the S&P 500 that exceeds the symbol-level limits. Compute **delta-equivalent exposure** per risk factor: map each position to its risk factors (AAPL → equity risk in USD; MES → equity index risk × contract multiplier; options → delta × underlying). Aggregate all exposures to each risk factor, then compare to factor-level limits. Example: AAPL delta = 500 shares; MES delta = -50 × 20 (multiplier) × 1 = 1,000 index units → equivalent to ~$190K S&P 500 exposure (at 3800). If the equity risk limit is $100K, this exceeds it. The delta-equivalent check is too expensive for the inline path (> 1µs). Run it asynchronously with a 10ms latency budget, and block new orders if the last check failed (a "risk state" flag updated every 10ms)
- **Exchange vs firm risk**: the distinction between (a) exchange-imposed risk controls and (b) firm-imposed risk controls is critical. Exchange controls: price collars (reject orders > 10% away from last trade), self-trade prevention, max-message-rate per session, position limits for certain products. Firm controls: the above (position, notional, rate, VaR). An inline risk check must **not** re-check exchange-imposed limits (they check them anyway, and a false-positive rejection by the firm would cause a missed fill). Exchange controls are monitored but not enforced by the firm's risk engine. Firm controls are enforced before the order is sent. Kill-switch nuance: if an exchange blocks your session (rate limit exceeded, self-trade detected), the firm cannot override it — the kill-switch only controls firm-side blocking. The monitoring system must track both firm-side and exchange-side blocks and alert if exchange-side blocks are happening (indicates the firm's rate limit is set too high)
- **Chaos testing the risk system**: the risk system itself must be tested to ensure it actually blocks bad orders. Run a chaos testing framework that: (a) generates random order sequences that violate each limit type (100 orders from each category: exceed size, exceed position, exceed rate, exceed notional); (b) sends them to the risk engine; (c) verifies each is blocked with the correct rejection code; (d) verifies passing orders are NOT blocked. Frequency: every CI build (for unit tests), weekly in staging (for integration), monthly in production (during market close). The chaos test must also test kill-switch: (e) trigger each kill-switch level (strategy, exchange, global); (f) verify no more orders pass; (g) verify cancel-all-sessions is sent. The ultimate test: run the chaos test while the risk system is under production load (shadow orders, not real) to verify latency does not degrade
- **Risk engine state recovery**: if the risk engine crashes (killed, OOM, segfault), state must be recovered before trading can resume. Recovery strategy: (a) **WAL (Write-Ahead Log)** — every state mutation (position update, rate counter increment) is appended to a log file before the in-memory update; (b) on restart, replay the WAL to reconstruct state; (c) verify state consistency by comparing to venue drop-copy fills. Target RTO: < 1 second (WAL replay + state verification). WAL must be on a separate drive (NVMe, not shared with data logs) to avoid I/O interference during replay. If the crash occurred mid-update (partial state mutation), the WAL is the ground truth. WAL format: binary, fixed-size records (64 bytes), written and fsynced every 100ms (not per-event — too slow). On crash, replay from last fsynced position
- **Kill-switch verification**: how do you know the kill-switch works without testing it with real orders? (a) **self-test mode** — the kill-switch has a diagnostic endpoint that simulates a kill event (sets the shared-memory flag, verifies the order entry thread reads it, clears the flag). Run the self-test every 30 seconds. (b) **shadow kill** — when the kill-switch is triggered manually for testing, it sends a "shadow kill" signal that is logged but does not block orders. The shadow log is inspected to verify the kill signal would have been processed correctly. (c) **hardware kill test** — once per quarter, during market close, actually trigger the global kill-switch and verify: application-layer block < 1µs, NIC-layer block < 10µs, cancel-all-sessions sent within 1ms. Test recovery: restart all processes, verify state consistency

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
