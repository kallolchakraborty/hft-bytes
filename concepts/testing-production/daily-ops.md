---
type: reference
title: "Continuous Optimization & Daily Operations"
description: "Morning health checks, overnight batch processing, pre-market data validation, post-market P&L reconciliation, strategy tuning cadence, war room prep, and weekly optimization cycle for HFT systems."
tags: ["operations"]
timestamp: "2026-06-27T03:30:00.000Z"
phase: 15
phaseName: "Testing & Production"
category: "Testing & Production"
subcategory: "testing-production"
language: "cpp"
artifact-id: "ZHFT_DAILY_OPS"
---
## Key Learning Points

- Morning health checks (T-60 min to open): verify exchange connectivity (logon heartbeat), market-data feed (seqno / gap count), kill-switch state (armed/ disarmed), strategy status (paper/live), colo cross-connect link light
- Pre-market data validation: compare current day's market data baseline to historical (volume profile, spread distribution, volatility); flag anomalies: unusually wide spreads, missing symbols, stale timestamp
- Overnight batch: backfill previous day's data, run TCA report, compute P&L attribution (PnL explained by alpha vs gamma vs theta vs residual), update risk limits for new day
- Post-market P&L reconciliation: trade blotter vs exchange confirmations; resolve breaks (missing fills, wrong price, wrong symbol); accept/reject after-trades within exchange deadlines
- Strategy tuning cadence: weekly review of each strategy's Sharpe, P&L, fill rate, adverse selection; parameter adjustments gated through CI/CD config PR
- War room prep: daily market structure review (upcoming events, earnings, economic data, exchange changes); pre-brief team on expected trading conditions and risk limits
- Optimization cycle: monitor → identify degradation → hypothesize cause → test in sim → deploy via canary → confirm improvement → document

## Usage

```cpp
// Morning health check runbook
struct MorningChecks {
    bool allPassed() {
        bool ok = true;
        ok &= checkExchangeLogon("CME");
        ok &= checkExchangeLogon("Eurex");
        ok &= checkExchangeLogon("ICE");
        ok &= checkFeedSeqno("CME_MDP", last_gap_ < 10);
        ok &= checkFeedSeqno("OPRA", last_gap_ < 100);
        ok &= checkKillSwitch("global", false);  // must be disarmed
        ok &= checkStrategyStatus("es-mm", StrategyState::LIVE);
        ok &= checkLinkLight("colo-cross-connect-0");
        return ok;
    }

    void sendReport() {
        // Slack: Daily health report
        // ✅ CME:  OK (seq=1234567, gaps=0)
        // ✅ Eurex: OK (seq=765432, gaps=1)
        // ❌ ICE:  RECONNECTING (seq gap > 1000)
        // ⚠️ Strategy es-mm: SIM MODE (P&L yesterday = +$12k)
    }
};

// Post-market P&L reconciliation
struct PnlReconciliation {
    double trade_blotter_pnl_;
    double exchange_confirm_pnl_;
    double break_ = trade_blotter_pnl_ - exchange_confirm_pnl_;

    bool hasBreaks() const { return std::abs(break_) > 1.0; }

    void resolve(const std::vector<TradeBreak>& breaks) {
        // Each break: match trade blotter entry to exchange confirm
        // If missing confirm: request exchange trade report
        // If wrong price: initiate trade correction with exchange
        // Resolve within T+1 deadline
    }
};
```

## Source Code

```cpp
// Daily operations timeline
// 06:00 UTC — Overnight batch complete, morning checks begin
// 06:30    — Pre-market data validation report sent
// 07:00    — Strategy status review, risk limits confirmed
// 07:30    — Markets open (US equity pre-market)
// 09:30    — US equity open (NYSE/Nasdaq)
// 16:00    — US equity close
// 17:00    — Post-market P&L reconciliation
// 18:00    — TCA report generated
// 19:00    — Overnight batch starts (data backfill)
// 20:00    — Team standup: issues, metrics, next-day plan

// Weekly optimization cycle
// Monday:   Review weekend performance, parameter proposals
// Tuesday:  Code/config changes via PR
// Wednesday:Shadow deploy + paper test
// Thursday: Staged rollout (tiny → half)
// Friday:   Full go-live if canary gates pass
```
