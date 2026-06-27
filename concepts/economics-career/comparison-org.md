---
type: reference
title: "Comparison Org"
description: "HFT firms are typically organised into: Quant (algorithm research, signal. Compensation structure: base salary (cover living costs) + annual bonus"
tags: ["phase-16"]
difficulty: beginner
timestamp: "2026-06-27T03:06:09.455Z"
phase: 16
phaseName: "HFT Economics & Career"
category: "Phase 16 - HFT Economics & Career"
subcategory: "economics-career"
language: "cpp"
artifact-id: "ZHFT_COMP_ORG"
---
## Key Learning Points

- HFT firms are typically organised into: Quant (algorithm research, signal
- Compensation structure: base salary (cover living costs) + annual bonus
- Non-compete and garden leave: standard in HFT; 3-12 months paid leave
- Recruitment patterns: coding challenges (LeetCode medium/hard + system

## Source Code

```cpp
#include <algorithm>
#include <cstdint>
#include <iomanip>
#include <map>
#include <optional>
#include <sstream>
#include <string>
#include <vector>

// ---------------------------------------------------------------------------
// Compensation benchmark table.
// ---------------------------------------------------------------------------
/*
 * Compensation Benchmarks (USD, 2025-2026, top-tier HFT firms)
 *
 * Role              | Level      | Base      | Bonus (typ) | P&L Share | TC (typ)
 * ------------------|------------|-----------|-------------|-----------|-----------
 * Quant Researcher  | Junior     | $200-250k | $100-200k   | -         | $300-450k
 * Quant Researcher  | Mid        | $250-350k | $200-500k   | -         | $450-850k
 * Quant Researcher  | Senior/PM  | $300-400k | $500k-2M    | 5-15%     | $1-5M+
 * C++ Developer     | Junior     | $175-225k | $75-150k    | -         | $250-375k
 * C++ Developer     | Mid        | $225-300k | $150-400k   | -         | $375-700k
 * C++ Developer     | Senior     | $300-400k | $300-800k   | -         | $600-1.2M
 * FPGA Engineer     | Mid        | $250-350k | $200-500k   | -         | $450-850k
 * FPGA Engineer     | Senior     | $350-450k | $300-800k   | -         | $650-1.3M
 * Ops/Infra Eng     | Mid        | $200-275k | $100-250k   | -         | $300-525k
 * Ops/Infra Eng     | Senior     | $275-350k | $200-400k   | -         | $475-750k
 */

// ---------------------------------------------------------------------------
// Org structure template.
// ---------------------------------------------------------------------------
struct OrgRole {
  std::string title;
  uint32_t    headcount;
  std::string reports_to;
};

struct OrgChart {
  std::string firm_name;
  std::vector<OrgRole> roles;

  std::string render() const {
    std::ostringstream out;
    out << "=== " << firm_name << " Org Chart ===\n";
    for (const auto &r : roles) {
      out << "  " << r.title << " (" << r.headcount << "x)";
      if (!r.reports_to.empty())
        out << " → reports to " << r.reports_to;
      out << "\n";
    }
    return out.str();
  }
};

namespace OrgTemplates {

inline OrgChart midSizeHFT() {
  return {
      .firm_name = "Mid-Size HFT (50-100 people)",
      .roles = {
        {"CEO / Founder", 1, ""},
        {"Head of Research", 1, "CEO"},
        {"Head of Engineering", 1, "CEO"},
        {"Head of Risk & Ops", 1, "CEO"},
        {"Quant Researcher", 8, "Head of Research"},
        {"Quant Developer", 6, "Head of Engineering"},
        {"C++ Core Dev", 10, "Head of Engineering"},
        {"FPGA Engineer", 4, "Head of Engineering"},
        {"Infrastructure Engineer", 4, "Head of Engineering"},
        {"Trading Operations", 4, "Head of Risk & Ops"},
        {"Risk Manager", 2, "Head of Risk & Ops"},
        {"Compliance", 1, "Head of Risk & Ops"},
      },
  };
}

} // namespace OrgTemplates

// ---------------------------------------------------------------------------
// Compensation parser — computes TC from base + bonus + P&L share.
// ---------------------------------------------------------------------------
struct CompOffer {
  std::string role;
  double      base;
  double      expected_bonus;
  double      pl_share_percent;  // e.g., 10 for 10%
  double      strategy_pl;       // Annual P&L of strategy (for P&L share).
  double      deferred_amount;
  uint32_t    vest_years;
};

class CompCalculator {
public:
  double total_compensation(const CompOffer &offer) const {
    double bonus = offer.expected_bonus;
    double pl    = offer.strategy_pl * (offer.pl_share_percent / 100.0);
    double deferred_annual = offer.deferred_amount / offer.vest_years;
    return offer.base + bonus + pl + deferred_annual;
  }

  struct Comparison {
    std::string firm_a;
    double tc_a;
    std::string firm_b;
    double tc_b;
    double diff;
    std::string recommendation;
  };

  Comparison compare(const CompOffer &a, const CompOffer &b) const {
    double tca = total_compensation(a);
    double tcb = total_compensation(b);
    Comparison cmp{a.role, tca, b.role, tcb, tca - tcb, ""};

    // Recommendation based on TC and deferred structure.
    if (tca > tcb * 1.15) {
      cmp.recommendation = "Firm A offers significantly higher TC";
    } else if (tcb > tca * 1.15) {
      cmp.recommendation = "Firm B offers significantly higher TC";
    } else {
      cmp.recommendation = "TC is comparable; evaluate deferred vesting, non-compete, and culture";
    }

    return cmp;
  }
};
```
