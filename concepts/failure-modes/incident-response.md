---
type: reference
title: "Incident Response & War Room"
description: "Severity classification (SEV1-4), war room roles (scribe, comms lead, engineering SME, incident commander), timeline reconstruction, blameless post-mortem template, action-item tracking, and escalation matrix for HFT production incidents."
tags: ["operations"]
difficulty: staff
timestamp: "2026-06-27T03:30:00.000Z"
phase: 17
phaseName: "Production Failure Modes & Recovery"
category: "Failure Modes"
subcategory: "failure-modes"
language: "cpp"
artifact-id: "ZHFT_INCIDENT_RESPONSE"
---
## Key Learning Points

- Severity definitions: SEV1 = trading halt/order rejection (resolution < 30 min), SEV2 = P&L impact < $X (resolution < 2 hr), SEV3 = minor degradation (resolution < 8 hr), SEV4 = cosmetic/logging
- War room roles: Incident Commander (IC) owns timeline and decisions, Scribe records all actions with timestamps, Comms Lead handles internal/external updates, Engineering SMEs diagnose per subsystem
- Timeline reconstruction: correlate system logs, order audit trail, market data timestamps, P&L tick-level; produce a single canonical timeline with uncertainty bounds
- Blameless post-mortem: focus on systemic causes not individual errors; "5 Whys" per contributing factor; distinguish direct cause vs contributing condition vs latent weakness
- Action items: each post-mortem produces 3-5 concrete action items with owner, deadline, and verification criteria; tracked to closure in weekly review
- Escalation matrix: engineer → team lead → head of trading → CTO → CEO with defined triggers per level
- Communication templates: pre-written Slack/email templates for each severity level; incident channel naming convention (`#inc-YYYYMMDD-short-desc`)

## Usage

```cpp
// Incident severity assessment
struct IncidentSeverity {
    enum Level {
        SEV1,   // Trading halt, exchange rejection, P&L > $100K
        SEV2,   // Significant P&L impact, degraded execution
        SEV3,   // Minor metric degradation, monitoring gaps
        SEV4    // Cosmetic, logging, documentation
    };

    static Level assess(double pnl_impact_usd, bool trading_blocked,
                        bool data_gap, double latency_increase_us) {
        if (trading_blocked) return SEV1;
        if (pnl_impact_usd > 100'000) return SEV1;
        if (pnl_impact_usd > 10'000) return SEV2;
        if (latency_increase_us > 100) return SEV2;
        if (data_gap) return SEV3;
        return SEV4;
    }
};
```

## Source Code

```cpp
// Post-mortem template sections
// 1. Summary (1 paragraph)
// 2. Timeline (UTC timestamps, system events)
// 3. Detection (how was it found? monitoring gap?)
// 4. Root Cause Analysis (5 Whys)
// 5. Impact (P&L, messages lost, latency, uptime)
// 6. Action Items (owner, deadline, verification)
// 7. Lessons Learned (process improvements)

// Incident channel template
// #inc-20260627-market-data-gap
// @here SEV2: CME MDP feed gap detected at 09:32:15.123
// Impact: 23 symbols stale, 4s recovery time
// IC: @kallol
// Comms: @jane
// SME (feed handler): @bob
// Status updates every 10min in thread
```
