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
