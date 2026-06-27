---
type: reference
title: "Colo Budget"
description: "Rack pricing varies by data centre: $1,500–$5,000/month for a full cabinet;. Power is the dominant cost: $150–$400/kW/month; a 30kW rack costs"
tags: ["phase-16"]
difficulty: intermediate
timestamp: "2026-06-27T03:06:09.455Z"
phase: 16
phaseName: "HFT Economics & Career"
category: "Phase 16 - HFT Economics & Career"
subcategory: "economics-career"
language: "cpp"
artifact-id: "ZHFT_COLO_BUDGET"
---
## Key Learning Points

- Rack pricing varies by data centre: $1,500–$5,000/month for a full cabinet;
- Power is the dominant cost: $150–$400/kW/month; a 30kW rack costs
- Cross-connect fees: $300–$1,000/month per fibre pair; a typical HFT setup
- Wave circuits: dedicated fibre/dark fibre; $2,000–$20,000/month depending
- Hardware depreciation: 3-year straight line for servers, 5-year for
- TCO model includes all of the above plus staffing, software licences, and

## Source Code

```cpp
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <iomanip>
#include <map>
#include <numeric>
#include <optional>
#include <sstream>
#include <string>
#include <vector>

// ---------------------------------------------------------------------------
// Infrastructure cost line item.
// ---------------------------------------------------------------------------
struct CostLineItem {
  std::string category;       // "colo_rack", "power", "cross_connect", "wave", "hardware"
  std::string description;
  double      monthly_cost;
  double      upfront_cost;
  uint32_t    depreciation_months; // 0 = operating expense (no depreciation).
};

// ---------------------------------------------------------------------------
// TCO calculator — aggregates all costs and computes annual total + per-µs cost.
// ---------------------------------------------------------------------------
class TcoCalculator {
  std::vector<CostLineItem> items_;

public:
  void add_item(const CostLineItem &item) { items_.push_back(item); }

  struct TcoBreakdown {
    double monthly_opex;
    double monthly_capex_amortised;
    double total_monthly;
    double total_annual;
    double pnl_per_us_per_year; // P&L improvement needed per µs to break even.
    std::map<std::string, double> category_breakdown;
  };

  TcoBreakdown calculate(double latency_ns = 0, double pnl_per_us = 0) const {
    TcoBreakdown b{};
    for (const auto &item : items_) {
      b.monthly_opex += item.depreciation_months == 0 ? item.monthly_cost : 0;
      b.monthly_capex_amortised +=
          item.depreciation_months > 0
              ? (item.upfront_cost / item.depreciation_months)
              : 0;
      b.category_breakdown[item.category] += item.monthly_cost +
          (item.depreciation_months > 0
               ? (item.upfront_cost / item.depreciation_months)
               : 0);
    }
    b.total_monthly = b.monthly_opex + b.monthly_capex_amortised;
    b.total_annual  = b.total_monthly * 12;

    // If latency and P&L sensitivity provided, compute break-even.
    if (latency_ns > 0) {
      double latency_us = latency_ns / 1000.0;
      b.pnl_per_us_per_year = b.total_annual / latency_us;
    }

    return b;
  }
};

// ---------------------------------------------------------------------------
// ROI projection tool.
// ---------------------------------------------------------------------------
class RoiProjector {
public:
  struct Projection {
    double total_investment;
    double annual_benefit;
    double payback_months;
    double three_year_roi;
  };

  Projection project(double upfront_investment,
                     double monthly_opex,
                     double expected_monthly_pnl_improvement) {
    double total_investment = upfront_investment;
    double annual_benefit   = expected_monthly_pnl_improvement * 12 - monthly_opex * 12;
    double payback_months   = total_investment /
                              std::max(0.01, expected_monthly_pnl_improvement - monthly_opex);
    double three_year_roi = (annual_benefit * 3 - total_investment) / total_investment * 100;

    return {total_investment, annual_benefit, payback_months, three_year_roi};
  }
};

// ---------------------------------------------------------------------------
// Sample budget for a typical mid-frequency equity HFT setup.
// ---------------------------------------------------------------------------
namespace BudgetTemplates {

inline std::vector<CostLineItem> typicalHFTSetup() {
  return {
      {"colo_rack",      "NY4 cage (1/4 cage, 10 racks)", 15000, 0, 0},
      {"power",          "30kW at $250/kW",               7500,  0, 0},
      {"cross_connect",  "8 cross-connects at $500",      4000,  0, 0},
      {"wave",           "Dark fibre NY4-NY4 loop",       3000,  0, 0},
      {"wave",           "Dark fibre NY4-CHI",            12000, 0, 0},
      {"hardware",       "10 servers (48-core EPYC)",     0,   250000, 36},
      {"hardware",       "2 switches (Mellanox SN2700)",  0,   60000, 60},
      {"hardware",       "4 FPGA cards (Xilinx Alveo)",   0,   80000, 24},
      {"software",       "Market data licences",          5000, 0, 0},
      {"software",       "Exchange connectivity fees",    2000, 0, 0},
  };
}

} // namespace BudgetTemplates
```
