---
type: reference
title: "Post Trade"
description: "Clearing and custody: DTCC (US equities), NSCC (US), ECC (Eurex), LCH. Trade affirmation: T+0 matching of trade details between counterparties;"
tags: ["phase-15"]
difficulty: staff
timestamp: "2026-06-27T03:06:09.454Z"
phase: 15
phaseName: "Testing & Production"
category: "Phase 15 - Testing & Production"
subcategory: "testing-production"
language: "cpp"
artifact-id: "ZHFT_POST_TRADE"
---
## Key Learning Points

- Clearing and custody: DTCC (US equities), NSCC (US), ECC (Eurex), LCH
- Trade affirmation: T+0 matching of trade details between counterparties;
- Allocation (giving up): fills from a block trade must be allocated to
- Margin: initial margin (IM) posted upfront; variation margin (VM)
- Fee reconciliation: exchange fees, clearing fees, broker fees — often

## Source Code

```cpp
#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <map>
#include <numeric>
#include <optional>
#include <set>
#include <sstream>
#include <string>
#include <vector>

// ---------------------------------------------------------------------------
// Trade allocator — distributes a block fill among sub-accounts.
// ---------------------------------------------------------------------------
struct Fill {
  uint64_t    fill_id;
  uint64_t    order_id;
  std::string symbol;
  int64_t     price;        // Fixed-point x10000
  uint32_t    qty;
  uint64_t    timestamp_ns;
  std::string venue;
};

struct Allocation {
  uint64_t fill_id;
  std::string account;
  uint32_t alloc_qty;
};

class TradeAllocator {
  // Pre-defined allocation splits per strategy.
  std::map<std::string, double> account_pcts_;

public:
  TradeAllocator() {
    account_pcts_["algo-1"] = 0.40;
    account_pcts_["algo-2"] = 0.35;
    account_pcts_["algo-3"] = 0.25;
  }

  std::vector<Allocation> allocate(const Fill &fill) {
    std::vector<Allocation> allocs;
    uint32_t remaining = fill.qty;
    auto it = account_pcts_.begin();

    for (size_t i = 0; i < account_pcts_.size() - 1; ++i, ++it) {
      uint32_t aqty = static_cast<uint32_t>(fill.qty * it->second);
      allocs.push_back({fill.fill_id, it->first, aqty});
      remaining -= aqty;
    }
    // Last account gets the remainder (handles rounding).
    allocs.push_back({fill.fill_id, it->first, remaining});
    return allocs;
  }
};

// ---------------------------------------------------------------------------
// Margin calculator — simplified SPAN-like logic.
// ---------------------------------------------------------------------------
struct Position {
  std::string symbol;
  int64_t     net_qty;     // Positive = long, negative = short.
  double      last_price;
  double      margin_rate; // Fraction of notional required as margin.
};

class MarginCalculator {
public:
  struct MarginBreakdown {
    std::string symbol;
    double notional;
    double initial_margin;
    double variation_margin;
  };

  std::vector<MarginBreakdown> calculate(const std::vector<Position> &positions) {
    std::vector<MarginBreakdown> breakdown;
    for (const auto &pos : positions) {
      double notional     = std::abs(double(pos.net_qty) * pos.last_price);
      double im           = notional * pos.margin_rate;
      // Variation margin = change in mark-to-market since last settlement.
      // Placeholder: assumes last_price is current MTM.
      double vm           = 0.0;
      breakdown.push_back({pos.symbol, notional, im, vm});
    }
    return breakdown;
  }

  // Cross-margining benefit: if positions in correlated products offset each
  // other, margin requirement is reduced by up to 60%.
  double cross_margin_benefit(double gross_margin,
                               const std::vector<Position> &positions) const {
    // Simplified: check if portfolio has offsetting positions.
    bool has_offset = false;
    std::set<std::string> sectors;
    for (const auto &p : positions) {
      // Assume first 2 chars of symbol = sector.
      sectors.insert(p.symbol.substr(0, 2));
    }
    has_offset = sectors.size() < positions.size(); // Some symbols share sector.

    return has_offset ? gross_margin * 0.4 : 0.0; // 40% reduction.
  }
};

// ---------------------------------------------------------------------------
// Fee reconciliation engine.
// ---------------------------------------------------------------------------
struct FeeCharge {
  uint64_t    trade_id;
  std::string fee_type;   // "exchange", "clearing", "broker", "sec"
  double      amount;
  std::string currency;
};

struct ExpectedFee {
  std::string fee_type;
  double      rate;       // Per-share or per-dollar rate.
  double      min;        // Minimum charge.
  double      max;        // Maximum charge (capped).
};

class FeeReconEngine {
  std::map<std::string, ExpectedFee> fee_schedule_ = {
    {"exchange",  {.rate = 0.0003, .min = 0.01, .max = 0.0}},  // $0.0003/share
    {"clearing",  {.rate = 0.0002, .min = 0.01, .max = 0.0}},
    {"sec",       {.rate = 0.000013, .min = 0.0, .max = 0.0}}, // SEC fee ($13/1M)
    {"broker",    {.rate = 0.0010, .min = 1.00, .max = 50.0}},
  };

public:
  struct FeeDiscrepancy {
    uint64_t    trade_id;
    std::string fee_type;
    double      expected;
    double      charged;
    double      difference;
  };

  std::vector<FeeDiscrepancy> reconcile(const std::vector<FeeCharge> &charges,
                                         const std::vector<uint64_t> &trade_qtys) {
    std::vector<FeeDiscrepancy> disc;

    for (const auto &charge : charges) {
      auto it = fee_schedule_.find(charge.fee_type);
      if (it == fee_schedule_.end()) {
        disc.push_back({charge.trade_id, charge.fee_type, 0, charge.amount, charge.amount});
        continue;
      }
      double expected = trade_qtys[charge.trade_id] * it->second.rate;
      if (it->second.min > 0 && expected < it->second.min) expected = it->second.min;
      if (it->second.max > 0 && expected > it->second.max) expected = it->second.max;

      if (std::abs(expected - charge.amount) > 0.01) {
        disc.push_back({charge.trade_id, charge.fee_type, expected, charge.amount,
                        charge.amount - expected});
      }
    }
    return disc;
  }
};
```
