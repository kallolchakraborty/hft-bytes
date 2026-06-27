---
type: reference
title: "Case Sim"
description: "Knight Capital (2012): rogue order generator → 7B in 45 min. 2010 Flash Crash: liquidity drop + stub quotes → 1000pt Dow drop"
tags: ["phase-11"]
difficulty: advanced
timestamp: "2026-06-27T03:06:09.440Z"
phase: 11
phaseName: "Backtesting & Simulation"
category: "Phase 11 - Backtesting & Simulation"
subcategory: "backtesting"
language: "cpp"
artifact-id: "ZHFT_CASE_SIM"
---
## Key Learning Points

- Knight Capital (2012): rogue order generator → 7B in 45 min
- 2010 Flash Crash: liquidity drop + stub quotes → 1000pt Dow drop
- Fat-finger: erroneous large orders → circuit breaker testing
- Simulate via scenario injection framework in the backtester

## Source Code

```cpp
*
 * USAGE:
 *   ScenarioInjector si(backtester);
 *   si.inject<FlashCrashScenario>(/* start_ns= */ 34200000000000);
 *   si.inject<KnightRogueOrders>(/* probability= */ 0.001);
 *
 * PERFORMANCE TARGET:
 *   scenario injection overhead < 100 ns per event check
 * ====================================================================
 */

#include <memory>
#include <vector>
#include <random>

struct ScenarioEvent {
    uint64_t trigger_ns;
    std::function<void()> action;
};

class ScenarioInjector {
    std::vector<ScenarioEvent> scheduled_;
    std::mt19937_64 rng_;

public:
    void check(uint64_t now_ns) {
        for (auto& se : scheduled_) {
            if (se.trigger_ns == now_ns) {
                se.action();
            }
        }
    }
};

// --------------------------------------------------------------------
// Flash Crash Scenario

class FlashCrashScenario {
public:
    static void inject(uint64_t start_ns) {
        // Phase 1: rapid sell-off (liquidity drops to 10%)
        // Phase 2: stub quotes appear (bid=0.01, ask=99999.99)
        // Phase 3: circuit breakers halt
        // Phase 4: recovery with price reversion
        // tradeoff: realistic multi-phase vs simple price manipulation
    }
};

// --------------------------------------------------------------------
// Knight Capital Rogue Order Generator

class KnightRogueOrders {
public:
    static std::vector<ScenarioEvent> events(uint64_t start_ns) {
        // Generates geometrically increasing order flow
        // tradeoff: exact replication vs abstract "order storm"
        std::vector<ScenarioEvent> evts;
        uint64_t order_interval_ns = 1000000;  // 1ms
        double order_mult = 1.5;
        for (int i = 0; i < 100; ++i) {
            uint64_t ts = start_ns + i * order_interval_ns;
            double size = 100 * std::pow(order_mult, i);
            // tradeoff: no size check → unlimited exposure
            evts.push_back({
                ts,
                [=]() {
                    // send order without risk checks
                    // exchange->sendOrder(size, MARKET, BUY);
                }
            });
        }
        return evts;
    }
};
```
