---
type: decision-matrix
title: "Strategy Matrix"
description: "Market regime determines optimal strategy selection. High vol → widen spreads for MM, increase pair thresholds"
tags: ["phase-10"]
timestamp: "2026-06-27T03:06:09.439Z"
phase: 10
phaseName: "Trading Strategies"
category: "Phase 10 - Trading Strategies"
subcategory: "trading-strategies"
language: "cpp"
artifact-id: "ZHFT_STRATEGY_MATRIX"
---
## Key Learning Points

- Market regime determines optimal strategy selection
- High vol → widen spreads for MM, increase pair thresholds
- Ranging markets → mean reversion & pairs excel
- Trending markets → momentum, avoid fading strategies
- Liquid vs illiquid → execution algo choice & MM viability

## Source Code

```cpp
*
 * USAGE:
 *   StrategySelector selector;
 *   auto rec = selector.recommend(/* vol= */ 0.3, /* trend= */ -0.1, /* liquid= */ true);
 *
 * PERFORMANCE TARGET:
 *   decision < 10 ns (simple lookup)
 * ====================================================================
 */

#include <string>
#include <array>

enum class Strategy { MM, STAT_ARB, MOMENTUM, MEAN_REV, PAIRS, NONE };
enum class Regime   { HIGH_VOL, LOW_VOL, TRENDING, RANGING, LIQUID, ILLIQUID };

class StrategySelector {
    // matrix[row regime][col strategy] → score 0-5
    static constexpr int matrix[6][5] = {
        /* HIGH_VOL */  {3, 5, 1, 3, 5},
        /* LOW_VOL  */  {5, 1, 1, 5, 1},
        /* TRENDING */  {3, 1, 5, 0, 3},
        /* RANGING  */  {5, 5, 0, 5, 5},
        /* LIQUID   */  {5, 5, 5, 5, 5},
        /* ILLIQUID */  {3, 1, 1, 1, 1},
    };

public:
    std::array<Strategy, 3> recommend(double vol, double trend_slope,
                                       bool liquid) {
        Regime r;
        if (std::abs(trend_slope) > 0.05)   r = Regime::TRENDING;
        else if (vol > 0.3)                  r = Regime::HIGH_VOL;
        else if (vol < 0.1)                  r = Regime::LOW_VOL;
        else                                 r = Regime::RANGING;

        // rank strategies by score
        std::array<std::pair<int, Strategy>, 5> scored;
        for (int s = 0; s < 5; ++s)
            scored[s] = {matrix[static_cast<int>(r)][s]
                        + (liquid ? matrix[4][s] : matrix[5][s]),
                         static_cast<Strategy>(s)};
        // sort (simple bubble for 5 elements — fine)
        // tradeoff: full sort vs top-K — 5 is negligible
        for (int i = 0; i < 5; ++i)
            for (int j = i+1; j < 5; ++j)
                if (scored[j].first > scored[i].first)
                    std::swap(scored[i], scored[j]);

        return {scored[0].second, scored[1].second, scored[2].second};
    }
};
```
## Decision Matrix

| DIMENSION | MARKET MAKING | STAT ARB | MOMENTUM | MEAN REV | PAIRS |
| --- | --- | --- | --- | --- | --- |
| High Volatility | Moderate (skew wider) | Ideal | Poor | Moderate | Ideal |
| Low Volatility | Ideal | Poor | Poor | Ideal | Poor |
| Trending Market | Moderate | Poor | IDEAL | AVOID | Moderate |
| Ranging Market | Ideal | Ideal | AVOID | IDEAL | Ideal |
| Liquid Instruments | IDEAL | Ideal | Ideal | Ideal | Ideal |
| Illiquid Instruments | Moderate | Poor | Poor | Poor | Poor |
| High Capacity | Low | Moderate | High | Low | Moderate |
| Low Capacity | Ideal | Ideal | Moderate | Ideal | Ideal |
| Low Latency Required | Yes | Yes | No | No | No |
| Development Complexity | High | High | Low | Low | Medium |
| Sharpe Potential | 2-5 | 3-8 | 0.5-1.5 | 1-3 | 2-4 |
| MATRIX |

