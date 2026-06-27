---
type: reference
title: "Technology Evaluation & Build-vs-Buy Frameworks"
description: "Systematic framework for making technology decisions in HFT: build-vs-buy analysis with TCO models, proof-of-concept methodology, benchmark design for latency-sensitive systems, vendor evaluation criteria, risk assessment of technology choices, and case studies of common decisions."
tags: ["technology", "evaluation", "build-vs-buy", "vendor", "architecture"]
difficulty: staff
timestamp: "2026-06-28T00:30:00.000Z"
phase: 16
phaseName: "Economics & Career"
category: "Economics & Career"
subcategory: "economics-career"
language: "cpp"
artifact-id: "ZHFT_TECH_EVALUATION"
---

## Key Learning Points

### Build-vs-Buy Decision Framework
- Every significant technology investment (feed handler, OMS, market data vendor, FPGA, colo provider) goes through a build-vs-buy decision. The framework has 5 dimensions: (a) **strategic value** — is this technology a core differentiator for the firm (build) or a commodity (buy)? If it gives you a latency or PnL edge, build. If it's table stakes (FIX engine, TCP stack), buy. (b) **total cost of ownership (TCO)** over 3 years: build = engineering salaries × team size × years + infrastructure + maintenance + opportunity cost. Buy = vendor license × years + integration + vendor lock-in risk. (c) **time to market** — how long to build a competitive solution vs deploy a bought one. (d) **risk** — build risk = execution failure, hiring timeline; buy risk = vendor bankruptcy, end-of-life, lock-in. (e) **maintenance burden** — every internal system adds to the maintenance load; a team of 3 full-time engineers can maintain about 5-7 major internal systems. Beyond that, buy
- **TCO model template**: `TCO = C_build + C_operate + C_decomission` vs `TCO_buy = C_license + C_integration + C_termination`. For build: C_build = (avg_engineer_cost × team_size × months_to_build / 12) + infrastructure + external consulting. C_operate = (engineer_cost × maintenance_fte × years) + (server_cost × years). C_decommission = data migration + knowledge transfer. For buy: C_license = (annual_fee × years) + (setup_fee). C_integration = (engineer_cost × integration_months / 12). C_termination = exit_fees + data_repatriation + migration_to_replacement. The decision threshold: if build_cost > 2x buy_cost over 3 years, buy. If build_cost < 0.5x buy_cost, build. In between: use strategic value and risk factors to decide
- **Build-vs-buy case studies**: (a) **market data feed handler** — 3 engineers × 6 months build ($400K) vs $150K/year vendor (+$450K over 3 years). Build won. But maintenance requires 0.5 FTE ongoing. (b) **FPGA tick-to-trade** — 5 FPGA engineers × 18 months ($2M) vs $500K/year vendor ($1.5M over 3 years). Initially buy, then build once IP is understood. (c) **FIX engine** — 2 engineers × 3 months ($150K) vs $50K/year vendor ($150K over 3 years). Tie — go with buy (vendor handles exchange updates). (d) **Order management system** — 4 engineers × 12 months ($1.2M) vs $300K/year vendor ($900K over 3 years). Build (strategic differentiator — OMS is core IP). (e) **Colo connectivity** — $50K/month for Equinix cross-connects vs $100K one-time fiber build. Build fiber if tenure > 2 years

### Proof-of-Concept Methodology
- A PoC is not a demo — it's a systematic evaluation against criteria. Process: (1) **define success criteria** upfront — latency targets, throughput targets, reliability requirements, integration complexity. Example: "must process 5M pkts/sec with p50 < 1µs, p99 < 2µs, p999 < 5µs." (2) **design the test** — what workload, what duration, what metrics. Use the same workload as production (recorded market data replay). (3) **run baseline** — measure the current system's performance on the same workload. (4) **run PoC** — integrate the candidate technology, run the same workload, collect the same metrics. (5) **analyze** — compare latency histograms (not just averages), throughput, failure modes, operational complexity. (6) **decision** — pass/fail based on criteria. No "almost passes" — either it meets all criteria or it doesn't
- **Benchmark design for latency-sensitive systems**: bad benchmarks measure throughput (matters) and average latency (doesn't matter). Good benchmarks measure: (a) **full latency distribution** — p50, p90, p99, p999, p9999. Use HDR Histogram for precise percentile measurement. (b) **latency under load** — measure latency at 10%, 50%, 90% of max throughput. Many systems have good idle latency but degrade under load. (c) **coordinated omission check** — verify that the measurement tool captures every request, not just processed ones. (d) **stability over time** — run for 24 hours minimum to catch thermal throttling, memory fragmentation, timer drift. (e) **failure modes** — what happens when the system is overloaded? Does it drop packets gracefully (backpressure) or crash? (f) **reproducibility** — can you get the same results twice? If not, the measurement is unreliable
- **Benchmarking anti-patterns**: (a) "warm-up for 1 second" — real trading runs for hours; warm up for 10 minutes minimum. (b) "only measuring p50" — p50 is meaningless for HFT; measure p99+. (c) "synthetic workload that doesn't match production" — if your production workload is 60% equity trades and 40% options trades, benchmark with that ratio. (d) "testing on a different server" — the exact server model, BIOS settings, NIC, OS version, and kernel parameters affect latency. Test on the same or comparable hardware. (e) "not measuring jitter" — a system with p50=1µs and p99.9=100µs is worse than one with p50=2µs and p99.9=5µs
- **Vendor evaluation criteria**: beyond the technology, evaluate: (a) **financial stability** — will the vendor exist in 3 years? Check funding, revenue, customer count, churn rate. (b) **support quality** — do they have 24/7 support? What's the SLA for critical issues (P1: 1-hour response, 4-hour fix)? (c) **roadmap** — what's their plan for the next 2 years? Avoid vendors that haven't updated their product in 2+ years. (d) **reference customers** — talk to at least 3 existing customers, ideally in your asset class. Ask: "what broke? how did they handle it?" (e) **exit path** — if you want to switch away, how hard is it? Is your data easily exportable? Are there termination fees? (f) **security posture** — do they have SOC 2? Encryption? Access controls? Can your compliance team audit them?
- **Technology risk assessment**: every technology choice carries risk. Assess: (a) **single point of failure** — does this technology create a SPOF? Mitigate with redundancy. (b) **vendor lock-in** — how easy is it to switch? Avoid proprietary formats, protocols, or APIs. (c) **skills availability** — can you hire engineers for this technology? (e.g., KDB+ engineers are rare and expensive). (d) **end-of-life risk** — is the technology actively maintained? (e.g., Solarflare's Onload is legacy, DPDK is actively developed). (e) **security risk** — is the technology a vector for attack? (e.g., open-source dependencies with CVE vulnerabilities). For each risk: assign probability (1-5) × impact (1-5). Mitigate risks above score 10. Do not accept risks above score 20

### Common Technology Decisions

- **DPDK vs Solarflare Onload vs EFVI vs TCP**: (a) DPDK — open-source, widely used, full control, requires application changes. Best for: building custom packet processing, highest performance. (b) Onload — commercial (Solarflare/Xilinx), transparent (no app changes), TCP acceleration. Best for: existing TCP applications needing lower latency. (c) EFVI (Extended F Virtual Interface) — Solarflare's low-level API, bare-metal access, sub-µs latency. Best for: greenfield HFT applications. (d) TCP (kernel) — no extra software, easy, but 5-10x higher latency. Avoid for HFT. Decision: if you're building a new feed handler, use DPDK. If you have an existing TCP application, use Onload. If you need the lowest possible latency and have FPGA budget, use EFVI or FPGA
- **Bazel vs CMake vs Meson vs Make**: (a) Bazel — hermetic builds, remote caching, multi-language, large monorepo. Best for: firms with 10+ developers, 100+ targets, C++/Python/Java. (b) CMake — de facto standard, widely supported, simpler than Bazel. Best for: small teams, moderate-sized codebase, C++ only. (c) Meson — faster than CMake, simpler syntax. Best for: new projects, Python + C++ hybrid, < 10 developers. (d) Make — legacy, no dependency management, error-prone. Avoid for new projects. Decision: if you have > 20 developers, use Bazel. If < 20, use CMake or Meson. Never use raw Make
- **In-house order book vs vendor book**: build if: (a) you need custom order book features (cross-venue aggregation, spread-level updates, latency-critical path); (b) you have 2+ engineers who can maintain it; (c) you trade across 10+ venues (vendor books are expensive per venue). Buy if: (a) you trade only 1-2 venues (CME + Eurex); (b) you need standard order book features (top-of-book, depth); (c) you don't have the engineering bandwidth. Most large HFT firms build their own order book — it's core IP
- **Direct connectivity vs market data vendor**: direct = receive exchange feeds directly (ITCH, SBE, FIX). Vendor = receive aggregated feed from vendor (Exegy, SR Labs, Redline). Direct advantages: (a) lowest latency (direct from exchange switch); (b) full feed depth (vendor may truncate); (c) no vendor lock-in. Vendor advantages: (a) one API for all venues; (b) protocol normalization (vagaries of each exchange are abstracted); (c) validation and cleaning (flag erroneous data). Decision: use both — direct feeds for primary trading (lowest latency), vendor feeds as backup and for venues with complex protocols. Most firms start with vendor, then add direct feeds for their top 3 venues

## Source Code

```cpp
// TCO Model Calculator
#include <cstdint>
#include <string>
#include <string_view>

struct TecoInput {
  double engineer_cost_per_year; // fully loaded
  int build_team_size;
  double build_months;
  double build_infrastructure; // one-time servers, licenses
  double build_maintenance_fte; // fraction of FTE for ongoing maintenance

  double vendor_license_per_year;
  double vendor_setup_fee;
  double vendor_integration_months;
  int years; // evaluation horizon (3-5)
};

struct TecoResult {
  double build_cost;
  double buy_cost;
  double breakeven_years; // when build becomes cheaper
  std::string recommendation; // "BUILD", "BUY", "HYBRID"
};

TecoResult compute_teco(const TecoInput& t) {
  double build = (t.build_team_size * t.engineer_cost_per_year * t.build_months / 12.0)
                + t.build_infrastructure;
  double build_maint = t.build_maintenance_fte * t.engineer_cost_per_year * t.years;
  double build_total = build + build_maint;

  double buy = t.vendor_setup_fee + (t.vendor_license_per_year * t.years);
  double buy_integration = t.engineer_cost_per_year * t.vendor_integration_months / 12.0;
  double buy_total = buy + buy_integration;

  TecoResult r{build_total, buy_total, 0, "BUY"};
  if (build_total < buy_total) {
    r.recommendation = "BUILD";
    r.breakeven_years = build / (t.vendor_license_per_year - t.build_maintenance_fte * t.engineer_cost_per_year);
  } else if (build_total < buy_total * 1.5) {
    r.recommendation = "HYBRID"; // build with vendor fallback
  }
  return r;
}

// PoC benchmark result
struct BenchmarkResult {
  std::string test_name;
  double p50_us;
  double p99_us;
  double p999_us;
  double throughput_mbps;
  bool passed;
};

bool evaluate_benchmark(const BenchmarkResult& actual, const BenchmarkResult& threshold) {
  if (actual.p99_us > threshold.p99_us) return false;
  if (actual.throughput_mbps < threshold.throughput_mbps) return false;
  return true;
}
```

## Usage

```bash
# TCO for build-vs-buy decision
./compute_teco --engineer-cost 350000 --build-team 3 \
  --build-months 6 --infrastructure 50000 --maintenance-ftes 0.5 \
  --vendor-license 150000 --setup-fee 20000 --integration-months 2 \
  --years 3 --output tco.json

# Vendor evaluation scorecard
./vendor_scorecard --criteria vendor_criteria.json \
  --vendor vendor_a.json --output scorecard_a.json

# Benchmark evaluation
./benchmark_evaluate --actual results.json --threshold thresholds.json
```

## Staff+ Perspective

> **Staff+ Perspective**: The most expensive build-vs-buy mistake I've seen was a firm that built their own FPGA tick-to-trade system because "FPGA gives us a 2µs advantage." The build cost $3M and took 2 years. By the time it was ready, the vendor had improved their FPGA product to within 1µs of the custom system, and the vendor's product handled 10 venues (the custom system only handled 2). The firm spent $3M for a 1µs advantage on 2 venues — the PnL improvement didn't justify the cost. The framework would have caught this: (a) strategic value — is FPGA tick-to-trade a core differentiator? Not if your competitors use a vendor and have similar latency. (b) TCO — $3M build vs $1.5M buy over 3 years. (c) risk — the build team was 5 FPGA engineers who all quit within 6 months of each other (burnout). The lesson: always include a "team risk" factor in the build decision. If you can't hire replacements for the key engineers, don't build. For PoC methodology: I once evaluated a market data vendor that claimed p99 latency of 2µs. Their benchmark tested with 100-byte synthetic packets on a dedicated server. Our production workload is 300-byte market data packets on a server running 10 other processes. Their real p99 was 15µs. The lesson: PoC on your hardware, with your workload, during hours that match your trading patterns. The biggest vendor evaluation I led was choosing between Exegy and SR Labs for market data. We created a 50-item scorecard covering: latency, throughput, API quality, exchange coverage update frequency, support responsiveness in US/EU/Asia timezones, financial stability (both were private companies), exit path, and reference calls. Exegy won for US equities, SR Labs for futures. We split the contract — best-of-breed for each asset class. The integrated cost was 20% more than a single vendor, but the performance difference was worth it. The DPDK vs Onload decision: we benchmarked both on identical hardware with our feed handler. DPDK was 500ns faster at p50 but Onload was 200ns faster at p99.9 (DPDK had occasional scheduling jitter). We chose Onload for the production system (trading) and DPDK for the co-located research server (non-latency-critical).