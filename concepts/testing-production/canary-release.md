---
type: reference
title: "Canary Release"
description: "Shadow trading: new version receives market data but does not send orders;. Dark launch: new version trades but P&L is not realised — paper trade only,"
tags: ["deployment"]
difficulty: advanced
timestamp: "2026-06-27T03:06:09.450Z"
phase: 15
phaseName: "Testing & Production"
category: "Phase 15 - Testing & Production"
subcategory: "testing-production"
language: "cpp"
artifact-id: "ZHFT_CANARY_RELEASE"
---
## Key Learning Points

- Shadow trading: new version receives market data but does not send orders;
- Dark launch: new version trades but P&L is not realised — paper trade only,
- Staged symbol rollout: roll out new logic on 1 symbol, then 5, then all
- Canary by venue: deploy new version on a secondary venue first (e.g., EDGX
- Rollback procedures: kill canary, drain orders, revert config — must be

## Source Code

```cpp
#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <functional>
#include <map>
#include <optional>
#include <set>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

// ---------------------------------------------------------------------------
// Canary deployment manager.
// ---------------------------------------------------------------------------
enum class DeployMode {
  Baseline,    // Current production version (unchanged)
  Shadow,      // Receives data, no orders sent
  DarkLaunch,  // Trades but P&L is paper-only
  LiveCanary,  // Trades live on a subset of symbols
};

struct CanaryConfig {
  std::string version_label;          // "v2.3.1-canary"
  DeployMode  mode;
  std::set<std::string> symbols;      // Symbols this version can trade (empty = all)
  std::string venue_override;         // e.g., "EDGX" (empty = all venues)
  uint64_t    max_exposure_usd;       // Max notional in canary mode
  uint32_t    ramp_up_delay_seconds;  // Between stages (e.g., 300s)

  // Health gate: fail canary if latency exceeds this.
  uint64_t max_p99_latency_us = 1000;
};

class CanaryDeployManager {
  std::atomic<DeployMode> active_mode_{DeployMode::Baseline};
  CanaryConfig            config_;
  std::string deploy_path_; // Path to the canary binary.

public:
  explicit CanaryDeployManager(const CanaryConfig &cfg) : config_(cfg) {}

  // Deploy the canary (launch process).
  bool deploy_shadow() {
    active_mode_ = DeployMode::Shadow;
    // Launch canary process with --mode=shadow --symbols=AAPL
    std::string cmd = deploy_path_ + " --mode shadow --symbols ";
    for (const auto &s : config_.symbols) cmd += s + ",";
    int rc = std::system(cmd.c_str());
    return rc == 0;
  }

  // Promote to dark launch (paper trading).
  bool promote_to_dark() {
    if (active_mode_ != DeployMode::Shadow) return false;
    active_mode_ = DeployMode::DarkLaunch;
    return true;
  }

  // Promote to live canary (small risky trade).
  bool promote_to_live() {
    if (active_mode_ != DeployMode::DarkLaunch) return false;
    active_mode_ = DeployMode::LiveCanary;
    return true;
  }

  // Rollback: kill canary, resume baseline.
  void rollback() {
    // Kill canary process.
    std::system(("pkill -f " + config_.version_label).c_str());
    // Cancel any live orders from canary.
    // Revert config to baseline.
    active_mode_ = DeployMode::Baseline;
  }

  // Health check gate — called every N seconds by the monitoring loop.
  struct HealthCheck {
    bool   passed;
    double p99_latency_us;
    double exposure_usd;
    std::string reason;
  };

  HealthCheck check_health() const {
    // In production, read from Prometheus metrics.
    double p99 = 200.0; // Placeholder.
    double exp = 0.0;
    if (active_mode_ >= DeployMode::DarkLaunch) {
      exp = 1000000.0; // Placeholder: computed from order flow.
    }
    bool passed = p99 <= config_.max_p99_latency_us &&
                  exp <= config_.max_exposure_usd;

    return {.passed          = passed,
            .p99_latency_us  = p99,
            .exposure_usd    = exp,
            .reason          = passed ? "" : "Health gate failed"};
  }
};

// ---------------------------------------------------------------------------
// Shadow trading comparator — compares output of baseline vs shadow.
// ---------------------------------------------------------------------------
struct ShadowOrder {
  uint64_t    id;
  std::string symbol;
  int64_t     price;
  uint32_t    qty;
  bool        buy;
  uint64_t    timestamp_ns;
};

class ShadowComparator {
  // Stores shadow version's intended orders.
  std::vector<ShadowOrder> shadow_orders_;

public:
  struct Mismatch {
    uint64_t    shadow_id;
    std::string field;      // "price", "side", "symbol"
    std::string expected;
    std::string actual;
  };

  // Compare shadow's order against baseline's behaviour.
  std::vector<Mismatch> compare(const ShadowOrder &baseline,
                                 const ShadowOrder &shadow) {
    std::vector<Mismatch> mismatches;
    if (baseline.price != shadow.price) {
      mismatches.push_back({shadow.id, "price",
                            std::to_string(baseline.price),
                            std::to_string(shadow.price)});
    }
    if (baseline.buy != shadow.buy) {
      mismatches.push_back({shadow.id, "side",
                            baseline.buy ? "buy" : "sell",
                            shadow.buy ? "buy" : "sell"});
    }
    return mismatches;
  }
};
```
