---
type: reference
title: "Fee Structures"
description: "Maker/taker model: liquidity provider (maker) receives rebate;. Rebate tiers: higher volume = better maker rebate. CME has 5+ tiers"
tags: ["phase-8"]
timestamp: "2026-06-27T03:06:09.431Z"
phase: 8
phaseName: "Exchange Architecture"
category: "Phase 8 - Exchange Architecture"
subcategory: "exchange-architecture"
language: "cpp"
artifact-id: "ZHFT_FEE_STRUCTURES"
---
## Key Learning Points

- Maker/taker model: liquidity provider (maker) receives rebate;
- Rebate tiers: higher volume = better maker rebate. CME has 5+ tiers
- Payment for order flow (PFOF): brokers route to wholesalers who
- Exchange-specific schedules: CME (tiered by product, membership),
- Fee impact on strategy: rebate capture strategies earn per-share

## Usage

// FeeCalculator calc;
// auto fee = calc.totalFee("CME", "ES", 0.5, Side::BUY, 1000);
// calc.setVolumeTier("CME", Tier::PLATINUM);

## Source Code

```cpp
#include <algorithm>
#include <array>
#include <bit>
#include <cstdint>
#include <cstring>
#include <string_view>
#include <unordered_map>

// ---------------------------------------------------------------------------
// Fee schedule entry
// ---------------------------------------------------------------------------
struct FeeTier {
  uint64_t min_adv;        // Minimum average daily volume
  double   maker_rebate;   // Negative = rebate to trader
  double   taker_fee;      // Positive = fee paid by trader
};

struct ExchangeFees {
  std::string_view name;
  double           maker_base;
  double           taker_base;
  std::vector<FeeTier> tiers;
};

// ---------------------------------------------------------------------------
// Predefined exchange fee schedules (as of 2025-2026)
// ---------------------------------------------------------------------------
static const ExchangeFees kCMEFees = {
  "CME", -0.0005, 0.0012,
  {
    {0,        -0.0005, 0.0012},
    {10000,    -0.0007, 0.0010},
    {50000,    -0.0009, 0.0008},
    {200000,   -0.0010, 0.0007},
  }
};

static const ExchangeFees kEurexFees = {
  "EUREX", -0.0004, 0.0010,
  {
    {0,       -0.0004, 0.0010},
    {5000,    -0.0005, 0.0009},
    {25000,   -0.0006, 0.0008},
  }
};

static const ExchangeFees kICEFees = {
  "ICE", -0.0003, 0.0008,
  {
    {0,      -0.0003, 0.0008},
    {20000,  -0.0004, 0.0007},
  }
};

static const ExchangeFees kNYSEMakerTaker = {
  "NYSE", -0.0010, 0.0015,
  {
    {0,        -0.0010, 0.0015},
    {1000000,  -0.0012, 0.0013},
  }
};

static const ExchangeFees kNASDAQMakerTaker = {
  "NASDAQ", -0.0010, 0.0015,
  {
    {0,         -0.0010, 0.0015},
    {1000000,   -0.0012, 0.0013},
    {5000000,   -0.0013, 0.0012},
  }
};

// ---------------------------------------------------------------------------
// Fee calculator
// ---------------------------------------------------------------------------
class FeeCalculator {
public:
  void setTier(std::string_view exchange, const FeeTier &tier) {
    custom_tiers_[std::string(exchange)] = tier;
  }

  struct FeeBreakdown {
    double maker_rebate;
    double taker_fee;
    double net_per_share;  // Negative = net rebate
    double total_fee;      // For full order
  };

  FeeBreakdown totalFee(std::string_view exchange, uint64_t quantity,
                        double maker_ratio) const {
    // maker_ratio = proportion of order that posts liquidity (0.0 to 1.0)
    auto *schedule = findSchedule(exchange);
    if (!schedule) return {0, 0, 0, 0};

    // Apply highest tier the volume qualifies for
    const FeeTier *active = &schedule->tiers[0];
    // In production: use actual recent ADV from internal tracking
    for (auto &t : schedule->tiers) {
      if (recent_adv_ >= t.min_adv) active = &t;
    }

    double maker = active->maker_rebate;
    double taker = active->taker_fee;

    double net = maker * maker_ratio + taker * (1.0 - maker_ratio);
    return {maker, taker, net, net * static_cast<double>(quantity)};
  }

  // Rebate arbitrage detector
  struct RebateArbSignal {
    double net_rebate;
    double spread;
    double profit_per_share;
    bool   is_arbitrage;
  };

  RebateArbSignal detectArbitrage(double bid, double ask,
                                   std::string_view buy_exchange,
                                   std::string_view sell_exchange) const {
    auto buy_fees  = totalFee(buy_exchange,  1, 1.0); // post on buy
    auto sell_fees = totalFee(sell_exchange, 1, 0.0); // take on sell

    double net_spread = (ask - bid);
    double total_fee_cost = buy_fees.net_per_share + sell_fees.net_per_share;
    // TRADEOFF: if net rebate exceeds spread, there's a rebate arb.
    // This is rare but can happen during fee tier transitions.
    return {
      buy_fees.maker_rebate + sell_fees.taker_fee,
      net_spread,
      net_spread + total_fee_cost,
      (net_spread + total_fee_cost) > 0
    };
  }

  void updateAdv(uint64_t adv) { recent_adv_ = adv; }

private:
  uint64_t recent_adv_ = 0;
  std::unordered_map<std::string, FeeTier> custom_tiers_;

  const ExchangeFees *findSchedule(std::string_view exchange) const {
    static const std::pair<std::string_view, const ExchangeFees *> kSchedules[] = {
      {"CME", &kCMEFees}, {"EUREX", &kEurexFees}, {"ICE", &kICEFees},
      {"NYSE", &kNYSEMakerTaker}, {"NASDAQ", &kNASDAQMakerTaker},
    };
    for (auto &[name, sched] : kSchedules) {
      if (name == exchange) return sched;
    }
    return nullptr;
  }
};
```
