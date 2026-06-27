---
type: reference
title: "Algorithmic Governance for HFT"
description: "Governance framework for algorithmic trading: strategy versioning and CI/CD pipelines, shadow deployment with PnL comparison, A/B testing with statistical significance, model registry and rollback, compliance approval workflows, and audit trail requirements."
tags: ["governance", "algorithms", "compliance", "testing", "deployment"]
difficulty: staff
timestamp: "2026-06-27T18:30:00.000Z"
phase: 6
phaseName: "System Architecture"
category: "Testing & Production"
subcategory: "testing-production"
language: "cpp"
artifact-id: "ZHFT_ALGO_GOVERNANCE"
---

## Key Learning Points

- **Strategy versioning and CI/CD**: every trading strategy is a git repository with versioned code. A commit triggers a CI pipeline: (a) compile with production flags (O3, LTO, PGO); (b) run deterministic replay tests against 30 days of historical market data; (c) compute PnL, Sharpe, max drawdown, win rate vs the previous version; (d) gate on: PnL change < 5%, no regression in latency, no new PnL outliers (nanotrade rejections). Only green builds can be deployed. Use semantic versioning (`v2.3.1`) — the version is embedded in every order tag and log line
- **Shadow deployment**: run the new strategy version alongside the production version. Both receive the same market data and make trading decisions, but only the production version's orders are sent to the exchange. The shadow version's orders are logged and PnL-calculated but never executed. Compare: (a) how often does the shadow agree with production (same order at the same price)? (b) when they disagree, which one's PnL would have been better? (c) latency comparison — is the shadow adding overhead? Shadow mode runs for at least 5 trading days before the new version is approved for production. Detect shadow divergence > 10% — investigate before promotion
- **A/B testing with PnL significance**: when both versions are deployed (A = control, B = treatment) on a small percentage of symbols (5-10%), measure PnL difference. Statistical significance test: use a two-sample t-test on daily PnL per symbol, with p < 0.05 threshold. Important: PnL is non-normal, so use bootstrap resampling (10,000 resamples) for confidence intervals. Minimum test duration: at least 20 trading days for statistical power (not 2-3 days). A/B test allocation must be randomized per symbol, not per-day (day-of-week effects confound per-day allocation). Monitor: is the A/B test itself affecting production PnL (market impact)? If total PnL drops > 5% during the test, stop and revert
- **Model registry and rollback**: every deployed strategy version is recorded in a registry (database or file): git commit hash, build artifact path, deployment timestamp, target symbols, PnL metrics, approved-by. The registry enables: (a) instant rollback — the previous version's artifact is pre-loaded in memory and can be swapped in <100ms; (b) audit trail — regulators ask "which version was trading on March 15?" and the answer must be available within 24 hours; (c) performance tracking — plot PnL per version over time to detect degradation. Rollback protocol: if the new version's cumulative PnL drops > 10% below baseline at any point in the first week, auto-rollback to the previous version
- **Compliance approval workflow**: deploying a new strategy version requires approval from: (a) the quant who wrote it (code review); (b) the risk team (position limits, market impact analysis); (c) the compliance officer (regulatory review). The workflow is encoded in a YAML file in the git repo:
  ```
  approval:
    stages:
      - name: code-review
        approver: senior-quant
        auto-approve: false
      - name: shadow-test
        duration: 5-days
        metrics: [pnl, sharpe, latency]
        thresholds: {pnl-diff: 0.05, latency-p99: 100us}
      - name: risk-review
        approver: risk-team
        checks: [position-limits, fat-finger, rate-limit]
      - name: compliance
        approver: compliance-officer
        checks: [regulatory-filing, circ-breaker]
  ```
  Each stage gate must pass before the next. The pipeline halts on any failure — no force-push override. Audit logs record who approved what and when
- **Audit trail requirements**: regulators (SEC, FCA, ESMA) require: (a) every order modification event logged (New → PendingNew → New → Cancelled → DoneForDay); (b) timestamp precision to at least 1ms (100µs preferred); (c) strategy version ID in every order; (d) logs retained for 5-7 years; (e) ability to replay any day's trading with millisecond granularity. Implementation: a centralized audit logger that receives all order events via a ring buffer (lossless, non-blocking). Write to compressed files daily. Index by date+symbol+strategy. Provide a replay tool: `./replay --date 2026-03-15 --strategy v2.3.1 --symbols AAPL,MSFT`
- **Kill switch and circuit breakers**: every strategy must have a software kill switch that all- cancels all open orders and stops trading. The kill switch must: (a) be triggerable by an operator (GUI button, API call, hotkey); (b) auto-trigger on PnL threshold (configurable — e.g., -$50K in 5 minutes); (c) auto-trigger on order rate spike (> 1000/s); (d) auto-trigger on exchange disconnect. The kill switch stops all venues within 1ms. After kill, the strategy enters a "locked" state — must be manually unlocked by a senior trader or risk manager. Circuit breakers are per-symbol: if a symbol's price moves > 3% in 1 second, pause trading that symbol for 60 seconds (avoid fat-finger flash crash amplification)

## Source Code

```cpp
// Strategy registry — versioned deployment tracking
#include <cstdint>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

struct StrategyVersion {
  std::string version;         // "v2.3.1"
  std::string git_commit_sha;  // "abc123..."
  std::string artifact_path;   // "/opt/strategies/v2.3.1/strategy.so"
  int64_t  deployed_at_ns;     // unix ns
  double   cumulative_pnl;     // $USD
  double   sharpe_ratio;
  double   max_drawdown;
  bool     active;
};

class StrategyRegistry {
  std::unordered_map<std::string, std::vector<StrategyVersion>> versions_; // symbol → history
public:
  void register_deploy(const StrategyVersion& sv) {
    versions_[sv.version].push_back(sv);
  }
  
  const StrategyVersion* get_active(const std::string& sym) {
    for (const auto& v : versions_[sym]) {
      if (v.active) return &v;
    }
    return nullptr;
  }

  void rollback(const std::string& sym) {
    auto& history = versions_[sym];
    for (size_t i = history.size(); i-- > 0;) {
      history[i].active = false;
    }
    if (history.size() >= 2) {
      history[history.size() - 2].active = true;
    }
  }
};

// Kill switch — all-cancel trigger
class KillSwitch {
  std::atomic<bool> killed_{false};
  std::vector<int> venue_fds_;
public:
  void trigger() {
    killed_.store(true, std::memory_order_release);
    for (int fd : venue_fds_) {
      send_order_cancel_all(fd); // venue-specific cancel-all message
    }
  }

  bool is_killed() const {
    return killed_.load(std::memory_order_acquire);
  }

  void manual_reset() {
    // requires senior operator auth
    killed_.store(false, std::memory_order_release);
  }
};
```

## Usage

```bash
# Deploy new strategy version through governance pipeline
./algo_deploy --strategy momentum --version v2.3.1 --artifact ./build/strategy.so

# This triggers:
# 1. CI/CD pipeline (compile, replay test)
# 2. Shadow mode (5 days)
# 3. Approval request (email to approvers)
# 4. A/B test on 5% symbols (20 days)
# 5. Full deployment with registry update

# Rollback command (instant):
./algo_rollback --strategy momentum

# Audit trail query:
./audit --date 2026-06-15 --strategy momentum --version v2.3.1 --output orders.csv
```

## Staff+ Perspective

> **Staff+ Perspective**: The shadow deployment phase was the most valuable process we adopted. In one incident, a strategy rewrite (intended to optimize latency) had a subtle bug where it would generate orders at the wrong price level under high-frequency quoting. The shadow test caught it on day 2 — the shadow diverged from production by 12% (shadow underperformed). We investigated and found the bug before any real money was lost. For A/B testing, the statistical significance trap is real: a strategy that makes $1000/day with stddev $8000 needs ~250 days to detect a 10% improvement with 80% power. Most firms don't run A/B tests long enough and promote strategies that are actually random noise. We used bootstrap resampling and required 20+ trading days minimum. The compliance approval workflow was derived from SEC Rule 15c3-5 (market access rule) and ESMA RTS 6. We encoded it in YAML so that the pipeline could enforce it mechanically — but the human approval step (senior trader) was always the bottleneck. We added a dashboard showing pending approvals with SLA timers (approve within 24 hours or escalate). The model registry saved us during an audit: the SEC asked for a strategy's version history across 18 months. We exported the registry as a CSV in 2 minutes. The rollback feature was used 3 times in 2 years — each time it saved us from a day of red PnL. Auto-rollback on PnL threshold was controversial (traders hate being interrupted) but it prevented a $2M loss when a strategy went rogue after an exchange firmware upgrade changed matching engine behavior.