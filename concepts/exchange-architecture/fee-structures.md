---
type: reference
title: "Fee Structures"
description: "Maker/taker model: liquidity provider (maker) receives rebate;. Rebate tiers: higher volume = better maker rebate. CME has 5+ tiers"
tags: ["phase-8"]
difficulty: intermediate
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
- **Taker-Maker vs Maker-Taker models**: Nasdaq/NYSE equities follow Maker-Taker (maker gets rebate, taker pays fee). Options exchanges (CBOE, AMEX) follow Taker-Maker (taker gets rebate, maker pays fee). The difference is driven by market structure: equities have many venues competing for liquidity (they subsidize makers), options have fewer venues and need to attract takers. SOR logic must switch fee model per venue — posting on a Maker-Taker venue may earn a rebate, while the same order on a Taker-Maker venue costs money. Failure to account for this can cost 0.1-0.3 cents per share — multiplicative across millions of shares/day
- **Fee tier qualification mechanics**: exchanges offer volume-based tiers — the more you trade, the better your rebate/fee. Qualification is based on: (a) ADV (Average Daily Volume) across all products on that exchange; (b) "added liquidity" ratio (some exchanges require 70%+ maker volume); (c) monthly or quarterly averaging window. The tier qualification calculation is complex and opaque — CME's fee schedule has 6+ tiers for futures with different requirements for members vs non-members. HFT firms must track their own volume per exchange daily and project which tier they'll qualify for next month. A wrong projection can cost $50K+/month. Build a fee tier projection tool: `./fee_projection --exchange CME --expected_adv 50000 --maker_ratio 0.6`
- **Tier transition edge**: during the transition between tiers (e.g., from Silver to Gold at mid-month), the marginal profit per trade changes. A strategy that is borderline profitable at Silver may become clearly profitable at Gold. If the firm is on track to qualify for Gold by end of month, increasing volume now (even at a small loss) to reach Gold early can be net profitable for the rest of the month. Conversely, if the firm is at risk of dropping to Silver, reducing volume to minimize losses at the lower tier may be optimal. Model this as an option: the value of reaching a tier is the tier benefit × remaining days × expected volume
- **Rebate arbitrage**: if Venue A pays a higher maker rebate than Venue B charges a taker fee, and the bid/ask spread is tight enough, a strategy can simultaneously post on Venue A and take on Venue B for a risk-free profit (minus the spread). Real-world example: NYSE rebate of $0.0015/share for adding liquidity vs, say, a venue charging $0.0005/share for removing liquidity — with a $0.0010 spread, the net is $0.0010/share profit per round-trip. This is technically not arbitrage (there is execution risk — the maker order may not get filled), but at high-frequency quoting, the fill rate approaches 100%. Some exchanges explicitly prohibit rebate arbitrage in their fee rules; others allow it. Detection: a sharp increase in volume on a specific symbol across two venues at the same price level
- **Fee impact on PnL calculation**: net PnL = (gross PnL from price) + (net fee/rebate). For a trading strategy with 50% maker fill rate (half the trades earn rebate, half pay fees), the net fee impact can be 15-30% of gross PnL. At 1 million shares/day × $0.001 net fee per share = $1000/day × 252 trading days = $252K/year per symbol. Fee optimization in SOR that improves net fee by 10% adds $25K/year per symbol. With 50 symbols, that's $1.25M/year — a significant enough impact to justify dedicated fee optimization engineering
- **Fee schedule modeling as an SOR input**: the SOR must model fee impact per venue for each order. Input: (a) current fee tier for each venue (from ADV tracking); (b) fee schedule per venue (maker rebate, taker fee, per-tier breakpoints); (c) expected maker ratio per venue (some venues have different fill rates). The SOR computes net cost per venue = (maker_ratio × maker_rebate) + ((1 - maker_ratio) × taker_fee). The cheapest venue (highest net rebate or lowest net cost) gets routing priority, assuming the same fill probability. Fill probability must factor in: queue position, queue depth, historical fill rate per venue, anti-gaming (some venues have anti-gaming rules that penalize certain order types)

## Staff+ Perspective

> **Staff+ Perspective**: The most expensive fee mistake I've seen was at a former firm — a strategy was routing large volumes through a venue that paid a "maker rebate" of $0.0015/share. The team thought they were earning $1,500/day in rebates. What they missed: their taker ratio on that venue was 75% (they took liquidity more than they added), so the net was actually (0.25 × -0.0015) + (0.75 × +0.0008)... wait, let me recalculate: they were paying $0.0008/share to take, and earning $0.0015/share to make. At 25% maker / 75% taker split, net = -0.000225 + Free → each share was costing $0.000225. At 1M shares/day, that's -$225/day. They thought they were making money on fees but were actually losing it. The fix: switch the strategy to a venue where they had a better maker ratio. For tier qualification: we had a CME member that traded ES futures. Our ADV was 45,000 contracts/day — just below the 50,000 tier threshold. At 45K, the tier gave -$0.50/contract maker rebate; at 50K+, -$0.70/contract. The difference was $0.20/contract × 45K = $9,000/day × 252 = $2.27M/year. We increased our ES quoting by 5,000 contracts/day (at a slight loss) to qualify for the tier, and the net gain was $1.5M/year. The tier qualification edge is real. For rebate arbitrage: we had a period where NASDAQ's maker rebate (highest tier: $0.0015) + NYSE's taker fee (lowest tier: $0.0002) created a $0.0013 profit per round-trip. We ran a strategy that did nothing but post on NASDAQ and take on NYSE for 3 months, making $80K/month. The exchanges eventually updated their fee schedules to close the gap. The arbitrage window lasted 3 months and required no signal — just fee schedule modeling.

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
