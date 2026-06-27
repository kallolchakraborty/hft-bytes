---
type: reference
title: "Vendor Eval"
description: "Market data vendor comparison: exchange direct (ITCH/Pillar direct from. Connectivity provider evaluation: compare latency SLAs, PoP locations,"
tags: ["phase-16"]
difficulty: intermediate
timestamp: "2026-06-27T03:06:09.458Z"
phase: 16
phaseName: "HFT Economics & Career"
category: "Phase 16 - HFT Economics & Career"
subcategory: "economics-career"
language: "cpp"
artifact-id: "ZHFT_VENDOR_EVAL"
---
## Key Learning Points

- Market data vendor comparison: exchange direct (ITCH/Pillar direct from
- Connectivity provider evaluation: compare latency SLAs, PoP locations,
- Exchange onboarding: certification timeline (2-8 weeks), FIX spec review,
- Contract negotiation: lock-in periods, exit fees, SLA credit structure,
- Termination clauses: notice period (30-90 days), data repatriation,
- **Build-vs-buy TCO framework**: analyze total cost over 3 years: build = (engineer salary × years × team size) + infrastructure + maintenance + opportunity cost. Buy = (vendor license × years) + integration + vendor lock-in risk + SLA credits. Threshold: if your team can build a comparable solution in < 6 months with 2 engineers, build — otherwise buy. Example: building an exchange connectivity gateway costs ~$500K/year (2 engineers × $250K) vs buying at $200K/year — buy wins. Building a market data feed handler costs ~$750K (3 engineers × $250K) vs $300K/year vendor — buy for the first 2 years, then build in-house once the team understands the requirements
- **Vendor negotiation tactics for HFT**: (a) request "tier-1" SLA with 99.995% uptime and 5µs p99 latency — most vendors offer this only on request; (b) negotiate 30-day exit clause instead of 90-day standard; (c) demand SLA credits of 10% monthly fee per 10µs p99 violation, capped at 50%; (d) request a dedicated support engineer during market hours (6am-6pm ET); (e) get a PoC period (4-8 weeks) free — any vendor that refuses is not confident in their product
- **Vendor war story: market data vendor failover**: a major market data vendor had a DNS-based failover that took 5 minutes to propagate — during the 2010 Flash Crash, their primary datacenter went offline and 5 minutes of data was lost. HFT firms that had direct exchange feeds were unaffected. Lesson: always maintain direct exchange connectivity as backup, even if you use a vendor as primary. The cost of one direct feed ($5K/month) is insurance against a 5-minute outage that could cost millions in missed trading opportunities
- **Connectivity provider evaluation criteria**: (a) PoP latency to your colo (< 100µs); (b) number of PoPs (30+ for global coverage); (c) cross-connect pricing at each PoP ($500-2000/month); (d) SLA for circuit restoration (4-hour MTTR vs 24-hour); (e) whether they offer dual-path diversity (two physically separate fibers); (f) whether they support wave division multiplexing (WDM) for future bandwidth upgrades without new fiber pulls

## Staff+ Perspective

> **Staff+ Perspective**: The biggest vendor mistake I've seen is underestimating vendor lock-in costs. A connectivity provider offered a great deal on 100G waves — $8K/month vs $12K from the competitor. But their cross-connect pricing at each exchange was $1500/month vs $500. For 5 exchanges, that's an extra $60K/year hidden cost. The negotiation advice: always ask for "all-in" pricing that includes cross-connects. The build-vs-buy decision for market data vendors was clear at the firm: we built our own feed handler (3 engineers, 6 months) and saved $250K/year vs the vendor. But the hidden cost was maintenance — each exchange protocol upgrade required re-certification, which consumed 0.5 engineer full-time. The TCO breakeven was 18 months. For exchange connectivity: we always had a direct ITCH feed as backup even with a vendor primary. During the 2020 COVID volatility, the vendor's aggregation layer saturated and we failed over to direct feeds — we were the only firm on our floor that didn't lose market data for 3 hours.

## Source Code

```cpp
#include <algorithm>
#include <cstdint>
#include <iomanip>
#include <map>
#include <numeric>
#include <optional>
#include <sstream>
#include <string>
#include <vector>

/*
 * MATRIX: Market Data Vendor Comparison
 *
 * Feature              | Exchange Direct     | Vendor A (Refinitiv) | Vendor B (Bloomberg)
 * ----------------------|---------------------|-----------------------|-----------------------
 * Mean latency          | 2µs                | 15µs                  | 35µs
 * p99 latency           | 10µs               | 45µs                  | 85µs
 * Coins covered         | 1                  | 25                    | 85
 * Normalised feed       | No (raw ITCH)      | Yes (normalised)      | Yes (normalised)
 * History               | 1 day (in mem)     | 5 years               | 20 years
 * API                   | Binary (ITCH)      | RFA/EMA               | SAPI/B-Pipe
 * Monthly cost          | $3,000             | $15,000               | $50,000
 * SLA (uptime)          | 99.99%             | 99.995%               | 99.999%
 * Termination notice    | 30 days            | 90 days               | 180 days
 */

// ---------------------------------------------------------------------------
// Vendor evaluation framework — weighted scoring.
// ---------------------------------------------------------------------------
struct VendorCapability {
  std::string name;
  double      score;       // 0.0 - 10.0
  double      weight;      // 0.0 - 1.0 (sum of weights should be 1.0)
  std::string notes;
};

struct Vendor {
  std::string               name;
  std::string               category;   // "market_data", "connectivity", "colo"
  std::vector<VendorCapability> capabilities;
  double                    total_cost_monthly;
  double                    setup_fee;
  uint32_t                  contract_months;
};

class VendorEvaluator {
public:
  struct EvaluationResult {
    std::string vendor_name;
    double      weighted_score;
    double      cost_score;      // Normalised cost (lower is better, 0-10)
    double      overall_score;   // Combined (70% weighted, 30% cost)
    std::string recommendation;
  };

  std::vector<EvaluationResult> evaluate(const std::vector<Vendor> &vendors) {
    std::vector<EvaluationResult> results;

    // Find min/max cost for normalisation.
    double max_cost = 0, min_cost = 1e12;
    for (const auto &v : vendors) {
      max_cost = std::max(max_cost, v.total_cost_monthly);
      min_cost = std::min(min_cost, v.total_cost_monthly);
    }
    double cost_range = std::max(1.0, max_cost - min_cost);

    for (const auto &v : vendors) {
      double weighted = 0;
      for (const auto &c : v.capabilities) {
        weighted += c.score * c.weight;
      }

      // Cost score: 10 for cheapest, 0 for most expensive.
      double cost_score = 10.0 * (1.0 - (v.total_cost_monthly - min_cost) / cost_range);

      double overall = weighted * 0.7 + cost_score * 0.3;

      std::string rec;
      if (overall >= 8.0)
        rec = "Strongly recommended";
      else if (overall >= 6.0)
        rec = "Recommended with caveats";
      else
        rec = "Not recommended";

      results.push_back(
          {v.name, weighted, cost_score, overall, rec});
    }

    // Sort by overall score descending.
    std::sort(results.begin(), results.end(),
              [](const auto &a, const auto &b) {
                return a.overall_score > b.overall_score;
              });

    return results;
  }
};

// ---------------------------------------------------------------------------
// Exchange onboarding tracker.
// ---------------------------------------------------------------------------
struct OnboardingMilestone {
  std::string name;
  std::string status;  // "not_started", "in_progress", "completed"
  uint64_t    target_date;
  std::string owner;
};

class ExchangeOnboardingTracker {
  std::vector<OnboardingMilestone> milestones_ = {
    {"FIX spec review",        "not_started", 0, "dev"},
    {"Conformance test setup", "not_started", 0, "dev"},
    {"Market data feed test",  "not_started", 0, "ops"},
    {"Order entry test",       "not_started", 0, "dev"},
    {"Risk validation",        "not_started", 0, "risk"},
    {"Production certification","not_started", 0, "pm"},
  };

public:
  void update(const std::string &name, const std::string &status) {
    for (auto &m : milestones_) {
      if (m.name == name) {
        m.status = status;
        return;
      }
    }
  }

  // Estimated timeline: 4–6 weeks for a typical venue.
  uint32_t estimated_days_to_completion() const {
    uint32_t incomplete = 0;
    for (const auto &m : milestones_) {
      if (m.status != "completed") incomplete++;
    }
    return incomplete * 5; // ~5 days per milestone.
  }
};
```
