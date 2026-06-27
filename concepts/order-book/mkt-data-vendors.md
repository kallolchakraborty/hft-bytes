---
type: decision-matrix
title: "Mkt Data Vendors"
description: "Exchange direct feeds: lowest latency, highest cost. CME MDP. 0, Eurex EBS, ICE MD, LSE Millennium MD. Require exchange"
tags: ["data-engineering"]
timestamp: "2026-06-27T03:06:09.436Z"
phase: 9
phaseName: "Order Book & Microstructure"
category: "Phase 9 - Order Book & Microstructure"
subcategory: "order-book"
language: "cpp"
artifact-id: "ZHFT_MKT_DATA_VENDORS"
---
## Key Learning Points

- Exchange direct feeds: lowest latency, highest cost. CME MDP
- 0, Eurex EBS, ICE MD, LSE Millennium MD. Require exchange
- Vendor consolidated feeds: Reuters (Refinitiv), Bloomberg
- Feed comparison: direct = 1-5 us, vendor normal = 10-100 us,
- SLA management: direct feeds have no SLA (exchange provides
- Backup feed strategy: primary = direct feed (fastest), backup

## Usage

// MarketDataVendorSelector sel;
// sel.evaluate(StrategyType::MARKET_MAKING);
// auto rec = sel.recommend();

## Source Code

```cpp
/* MATRIX: Market Data Vendor Comparison
 *
 * +-------------------+------------+------------+-------------+-------------+
 * | Feature           | Exegy      | Redline    | MayStreet   | Reuters     |
 * +-------------------+------------+------------+-------------+-------------+
 * | Type              | Direct+FPGA| FPGA-based | FPGA-based  | Software    |
 * |                   | appliance  |            |             |             |
 * | Latency (co-lo)   | 1-3 us     | 2-5 us     | 3-8 us      | 10-50 us    |
 | | Coverage          | CME, EUREX,| CME, EUREX,| CME, EUREX, | Global      |
 * |                   | ICE, LSE   | ICE, LSE   | ICE, LSE    | 200+ venues |
 * | Normalization     | Normalized | Normalized | Normalized  | Native +    |
 * |                   |            |            |             | normalized  |
 * | Instrument Price  | $5-15K/mo  | $3-10K/mo  | $4-12K/mo   | $2-8K/mo    |
 * | SLA Guarantee     | Yes        | Yes        | Yes         | Yes         |
 * |                   | (99.99%)   | (99.99%)   | (99.99%)    | (99.95%)    |
 * | FPGA or Software  | FPGA       | FPGA       | FPGA        | Software    |
 * | History Recording | Optional   | Included   | Optional    | Included    |
 * +-------------------+------------+------------+-------------+-------------+
 *
 * Decision Guide:
 *   - Sub-5 us needed: Direct feed + Exegy/Redline FPGA
 *   - 5-20 us acceptable: MayStreet
 *   - Global coverage needed: Reuters (200+ venues)
 *   - Budget limited: Reuters (comprehensive, higher latency)
 *   - Lowest power/rack space: FPGA appliances (Exegy, Redline)
 *   - Need normalized feed: All vendors normalize; direct feeds are
 *     exchange-native format
 */

#include <algorithm>
#include <array>
#include <bit>
#include <cstdint>
#include <cstring>
#include <string_view>
#include <vector>

// ---------------------------------------------------------------------------
// Vendor descriptor
// ---------------------------------------------------------------------------
struct VendorDescriptor {
  std::string_view name;
  double           latency_us;       // Typical co-lo latency
  uint32_t         coverage_count;   // Number of venues covered
  double           monthly_cost_k;   // Monthly cost in $K
  bool             fpga_based;
  bool             has_sla;
  double           sla_uptime_pct;
  bool             normalized_feed;  // Normalized across venues
};

static constexpr std::array<VendorDescriptor, 5> kVendors = {{
  {"Exegy",     2.0,  4,  12.0, true,  true,  99.99, true},
  {"Redline",   3.5,  4,  8.0,  true,  true,  99.99, true},
  {"MayStreet", 5.0,  4,  10.0, true,  true,  99.99, true},
  {"Reuters",   30.0, 200,5.0,  false, true,  99.95, true},
  {"Bloomberg", 50.0, 180,8.0,  false, true,  99.95, true},
}};

// ---------------------------------------------------------------------------
// Vendor selector
// ---------------------------------------------------------------------------
class MarketDataVendorSelector {
public:
  struct Recommendation {
    std::string_view primary;
    std::string_view backup;
    double           estimated_total_latency;
    double           monthly_cost;
  };

  Recommendation recommend(double max_latency_us,
                           bool need_fpga,
                           uint32_t min_coverage) const {
    // Find best primary vendor
    const VendorDescriptor *primary = nullptr;
    for (auto &v : kVendors) {
      if (v.latency_us > max_latency_us) continue;
      if (need_fpga && !v.fpga_based) continue;
      if (v.coverage_count < min_coverage) continue;
      if (!primary || v.latency_us < primary->latency_us)
        primary = &v;
    }

    // Find backup (second fastest, different vendor)
    const VendorDescriptor *backup = nullptr;
    for (auto &v : kVendors) {
      if (&v == primary) continue;
      if (v.latency_us > max_latency_us * 3) continue; // backup can be slower
      if (!backup || v.latency_us < backup->latency_us)
        backup = &v;
    }

    return {
      primary ? primary->name : "direct",
      backup ? backup->name : "exchange-backup",
      primary ? primary->latency_us : 0,
      (primary ? primary->monthly_cost_k : 0) +
      (backup ? backup->monthly_cost_k * 0.5 : 0) // backup discount
    };
  }

  // Feasibility check
  struct Feasibility {
    bool   feasible;
    double expected_latency;
    double yearly_cost_k;
    std::string_view note;
  };

  Feasibility assess(const VendorDescriptor &v, uint64_t msg_per_sec,
                     double budget_k) const {
    // Check bandwidth
    double mbps = (500.0 * 8 * msg_per_sec) / 1'000'000.0; // full book
    double yearly = v.monthly_cost_k * 12;
    return {
      yearly <= budget_k,
      v.latency_us,
      yearly,
      mbps > 10000 ? "May need FPGA to handle bandwidth" : "Bandwidth ok"
    };
  }
};
```
## Decision Matrix

| : Market Data Vendor Comparison |
| --- |
| +-------------------+------------+------------+-------------+-------------+ |
| Feature | Exegy | Redline | MayStreet | Reuters |
| +-------------------+------------+------------+-------------+-------------+ |
| Type | Direct+FPGA | FPGA-based | FPGA-based | Software |
| appliance |
| Latency (co-lo) | 1-3 us | 2-5 us | 3-8 us | 10-50 us |
| Coverage | CME, EUREX, | CME, EUREX, | CME, EUREX, | Global |
| ICE, LSE | ICE, LSE | ICE, LSE | 200+ venues |
| Normalization | Normalized | Normalized | Normalized | Native + |
| normalized |
| Instrument Price | $5-15K/mo | $3-10K/mo | $4-12K/mo | $2-8K/mo |
| SLA Guarantee | Yes | Yes | Yes | Yes |
| (99.99%) | (99.99%) | (99.99%) | (99.95%) |
| FPGA or Software | FPGA | FPGA | FPGA | Software |
| History Recording | Optional | Included | Optional | Included |
| +-------------------+------------+------------+-------------+-------------+ |
| Decision Guide: |
| - Sub-5 us needed: Direct feed + Exegy/Redline FPGA |
| - 5-20 us acceptable: MayStreet |
| - Global coverage needed: Reuters (200+ venues) |
| - Budget limited: Reuters (comprehensive, higher latency) |
| - Lowest power/rack space: FPGA appliances (Exegy, Redline) |
| - Need normalized feed: All vendors normalize; direct feeds are |
| exchange-native format |

