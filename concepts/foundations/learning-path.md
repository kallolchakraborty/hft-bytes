---
type: study-plan
title: "HFT Career Learning Path — Beginner to Staff+"
description: "A guided curriculum organized by career stage: from zero HFT knowledge through Staff+ engineering. Each stage lists prerequisite concepts, recommended study order, interview focus areas, and expected timeline."
tags: ["curriculum", "learning-path", "career"]
timestamp: "2026-06-27T10:00:00.000Z"
phase: 0
phaseName: "Learning Path"
category: "Learning Path"
subcategory: "learning-path"
language: "markdown"
difficulty: beginner
artifact-id: "ZHFT_LEARNING_PATH"
---
## Key Learning Points

- This path assumes zero HFT knowledge and builds up to Staff+ engineering level
- Each stage has clear prerequisites — don't skip ahead without mastering the prior level
- Interview focus areas are based on real HFT firm interview loops (Citadel, JS, Jump, Tower, HRT)
- Timeline estimates assume dedicated part-time study (10-15 hrs/week)
- Every concept file is tagged with a difficulty level: `beginner` | `intermediate` | `advanced` | `staff`

## Stage 1: Entry Level (Months 1-3)

**Goal**: Pass HFT intern / new-grad technical interviews

**Prerequisites**: None

### Study Order

1. **`foundations/cpu-architecture`** — CPU pipeline, out-of-order execution, branch prediction, cache lines
2. **`foundations/cache-lines`** — False sharing, cache line alignment, prefetching
3. **`foundations/hw-latency-ref`** — Latency numbers every engineer should know
4. **`foundations/hw-selection`** — Server hardware basics
5. **`foundations/server-selection`** — Choosing the right server for HFT
6. **`foundations/linux-tuning`** — Essential Linux kernel tuning for low latency
7. **`foundations/colo-setup`** — What colocation means, basic setup
8. **`mathematics/probability-distributions`** — Probability foundations for trading
9. **`mathematics/time-series`** — Time series analysis basics
10. **`mathematics/machine-learning-basics`** — ML fundamentals for signal generation
11. **`economics-career/comparison-org`** — How HFT firms are structured

### Interview Focus

- **Coding**: LeetCode medium/hard, system design basics, concurrency primitives
- **OS**: Virtual memory, context switches, scheduling, interrupts
- **Networking**: TCP/UDP fundamentals, socket programming
- **C++**: RAII, templates, STL, move semantics, virtual tables
- **Probability**: Expected value, variance, conditional probability

### Timeline

- Month 1: CPU architecture, cache, OS tuning
- Month 2: Probability, time series, basic ML
- Month 3: Interview prep, practice problems, mock interviews

## Stage 2: Mid-Level (Months 4-8)

**Goal**: Own a component — build and maintain a production subsystem

**Prerequisites**: Stage 1 complete

### Study Order

1. **`cpp-patterns/lock-free-queue`** — MPSC/MCMC queues, ring buffers
2. **`cpp-patterns/atomics-memory-order`** — C++ atomics, memory ordering, acquire/release semantics
3. **`cpp-patterns/cache-friendly`** — Data-oriented design, hot/cold splitting
4. **`cpp-patterns/placement-new`** — Custom allocation, arena allocators
5. **`system-programming/shared-memory`** — IPC via shared memory, mman
6. **`system-programming/binary-logging`** — High-throughput logging
7. **`network-hardware/nic-tuning`** — NIC configuration for low latency
8. **`network-hardware/switch-topology`** — Network topology fundamentals
9. **`kernel-bypass/tcp-tuning`** — TCP stack optimization
10. **`kernel-bypass/udp-multicast`** — Multicast for market data
11. **`exchange-architecture/matching-engine`** — How matching engines work
12. **`exchange-architecture/cme-ilink3`** — CME protocol basics
13. **`exchange-architecture/eurex-t7`** — Eurex protocol basics
14. **`order-entry/order-types`** — Order types and their semantics
15. **`order-entry/risk-checks`** — Pre-trade risk validation
16. **`order-book/top-of-book`** — Top-of-book vs full book
17. **`order-book/book-imbalance`** — Order book imbalance signals
18. **`order-book/feed-handler`** — Market data feed handler design
19. **`backtesting/backtest-engine`** — Event-driven backtesting
20. **`backtesting/mkt-replay`** — Market data replay
21. **`monitoring/grafana`** — Prometheus/Grafana dashboards
22. **`monitoring/structured-logging`** — Structured logging for HFT

### Interview Focus

- **System Design**: Design a feed handler, design an OMS, design a market data distribution system
- **C++**: Lock-free programming, memory ordering, virtual dispatch overhead, RTTI cost
- **Low-Level**: Cache misses, TLB misses, NUMA, context switch cost, interrupt coalescing
- **Trading**: How an order gets from button push to exchange, market data flow, order types
- **Behavioral**: Describe a performance optimization you made, a production issue you debugged

### Timeline

- Month 4: Lock-free C++ patterns, atomics, cache-friendly design
- Month 5: System programming, IPC, kernel bypass fundamentals
- Month 6: Exchange protocols, order entry, risk checks
- Month 7: Order book, feed handlers, backtesting
- Month 8: Monitoring, interview prep

## Stage 3: Senior Level (Months 9-14)

**Goal**: Own a system — design, build, and operate a complete HFT subsystem

**Prerequisites**: Stage 2 complete

### Study Order

1. **`kernel-bypass/kernel-bypass`** — DPDK, Onload, Solarflare, eBPF/XDP
2. **`kernel-bypass/multicast-deep`** — Multicast deep dive: PGM, IGMP, ASM/SSM
3. **`kernel-bypass/simd-parser`** — SIMD-accelerated market data parsing
4. **`network-hardware/cross-dc`** — Cross-DC connectivity, microwave vs fiber
5. **`network-hardware/switch-configuration`** — Switch tuning for HFT
6. **`network-hardware/dc-networking`** — Data center networking architecture
7. **`network-hardware/p4-switches`** — P4 programmable switches
8. **`order-entry/fix-engine`** — FIX engine architecture and design
9. **`order-entry/oms`** — Order management system design
10. **`order-entry/sor`** — Smart order router design
11. **`order-entry/exchange-connect`** — Exchange connectivity patterns
12. **`order-entry/latency-measure`** — Hardware timestamping, latency measurement
13. **`order-book/lob`** — Full LOB reconstruction from incremental updates
14. **`order-book/gap-recovery`** — Market data gap detection and recovery
15. **`order-book/fee-dynamics`** — Fee-driven order book dynamics
16. **`exchange-architecture/session-recovery`** — Exchange session recovery behaviors
17. **`exchange-architecture/fee-structures`** — Maker-taker, fee models
18. **`trading-strategies/market-making`** — Two-sided market making
19. **`trading-strategies/arbitrage`** — Statistical arbitrage strategies
20. **`trading-strategies/pairs-trading`** — Pairs trading and cointegration
21. **`trading-strategies/momentum`** — Momentum and mean reversion
22. **`trading-strategies/optimal-execution`** — VWAP/TWAP, implementation shortfall
23. **`backtesting/latency-sim`** — Latency simulation in backtesting
24. **`backtesting/overfitting`** — Overfitting prevention techniques
25. **`backtesting/performance-attribution`** — PnL decomposition
26. **`data-engineering/kdb`** — kdb+/q for time-series data
27. **`data-engineering/realtime-pipeline`** — Real-time data pipelines
28. **`monitoring/latency-histogram`** — Latency percentiles and histograms
29. **`monitoring/order-tracking`** — Order lifecycle tracking
30. **`monitoring/sli-slo`** — SLI/SLO/SLA framework
31. **`testing-production/deterministic-test`** — Deterministic testing for HFT
32. **`testing-production/replay-test`** — HFT replay testing
33. **`testing-production/canary-release`** — Canary and blue-green deployment
34. **`testing-production/container-hft`** — Containerization vs bare metal
35. **`fpga/fpga-intro`** — FPGA basics for HFT
36. **`fpga/fpga-parser`** — Market data parsing on FPGA

### Interview Focus

- **System Design**: Design a latency measurement system, design a market-making system, design a risk management system, design a multi-venue order router
- **C++**: Move semantics perf, template metaprogramming in hot paths, constexpr, concepts
- **Networking**: Multicast groups, IGMP snooping, PTP, NIC offloads, jumbo frames
- **Trading**: Market microstructure, spread capture, inventory risk, adverse selection
- **Architecture**: Event-driven vs thread-per-core, NUMA-aware design, lock-free vs wait-free
- **Behavioral**: Architecture decision you made, scaling a system, mentoring junior engineers

### Timeline

- Month 9: Kernel bypass deep dive, network hardware
- Month 10: OMS/SOR, exchange connectivity, order book reconstruction
- Month 11: Exchange architectures, session recovery, trading strategies
- Month 12: Backtesting, data engineering, monitoring
- Month 13: Testing, deployment, FPGA basics
- Month 14: Interview prep, system design practice

## Stage 4: Staff+ Level (Months 15-20)

**Goal**: Lead org-wide initiatives — define technical strategy, design multi-system architecture, mentor across teams

**Prerequisites**: Stage 3 complete

### Study Order

By this stage you should know which direction you want to specialize. The Staff+ level is about depth in one area plus breadth across all.

#### All Staff+ candidates

1. **`failure-modes/split-brain`** — Split-brain scenarios in trading systems
2. **`failure-modes/clock-anomalies`** — Clock drift, leap seconds, PTP failures
3. **`failure-modes/phantom-orders`** — Phantom order detection
4. **`failure-modes/order-dup`** — Order deduplication and idempotency
5. **`failure-modes/mass-cancel`** — Mass cancel failure modes
6. **`failure-modes/stale-state`** — Stale state after reconnection
7. **`failure-modes/partial-fill`** — Partial fill ambiguity
8. **`failure-modes/seq-resets`** — Exchange sequence number resets
9. **`failure-modes/incident-response`** — Incident response and war rooms

#### Architecture specialists

10. **`foundations/system-architecture`** — System architecture patterns for HFT
11. **`foundations/latency-budgeting`** — Latency budgeting methodology
12. **`foundations/capacity-planning`** — Capacity planning for trading systems
13. **`cpp-patterns/perf-optimization-advanced`** — PGO, LTO, BOLT, cache analysis
14. **`cpp-patterns/compiler-optimizations-deep`** — Advanced compiler optimizations
15. **`testing-production/prod-debugging`** — Production debugging tooling
16. **`testing-production/perf-benchmarking`** — Performance benchmarking methodology

#### Trading & Strategy specialists

17. **`trading-strategies/options-hft`** — Options HFT, volatility trading
18. **`trading-strategies/multi-leg-execution`** — Multi-leg order execution
19. **`trading-strategies/latency-arb`** — Cross-exchange latency arbitrage
20. **`trading-strategies/execution-algos`** — Execution algorithms
21. **`trading-strategies/tca`** — Transaction cost analysis
22. **`trading-strategies/pnl-attribution`** — PnL attribution and reconciliation

#### Infrastructure specialists

23. **`kernel-bypass/ebpf-xdp`** — eBPF/XDP for HFT
24. **`kernel-bypass/solarflare-efvi`** — Solarflare EFVI, kernel bypass via OpenOnload
25. **`kernel-bypass/feed-protocols-deep`** — Deep feed protocol analysis
26. **`network-hardware/ptp-clock-sync`** — PTP clock synchronization
27. **`fpga/fpga-vs-cpu`** — FPGA vs CPU tradeoff matrix
28. **`testing-production/cloud-hft`** — Cloud and hybrid infrastructure
29. **`testing-production/colo-setup`** (advanced sections) — Colo deep dive

#### Data & Compliance specialists

30. **`data-engineering/market-data-compression`** — Market data compression
31. **`data-engineering/historical-vendors`** — Historical data vendor evaluation
32. **`monitoring/security-architecture`** — Security architecture for trading
33. **`monitoring/hardware-telemetry`** — Hardware telemetry and RAS
34. **`testing-production/compliance-surveillance`** — Compliance and surveillance
35. **`economics-career/regulatory-reporting`** — Regulatory reporting engineering

#### Operations & Strategy

36. **`testing-production/colocation`** — Advanced colocation strategy
37. **`testing-production/dr-failover`** — Disaster recovery and failover
38. **`testing-production/post-trade`** — Post-trade and settlement
39. **`testing-production/practical-sysadmin`** — Practical sysadmin for HFT
40. **`exchange-architecture/exchange-onboarding`** — Exchange onboarding and certification
41. **`foundations/colo-deep-dive`** — Colocation deep dive
42. **`economics-career/staff-plus`** — Staff+ engineering and career growth
43. **`economics-career/vendor-eval`** — Vendor evaluation framework

### Interview Focus

- **System Design**: Design a full trading system end-to-end, design a risk infrastructure for a multi-strategy firm, design a data lake for tick data, design a latency monitoring system across 10+ venues
- **Architecture**: Tradeoffs between architectures, cost-benefit of FPGA vs software, colocation strategy, vendor selection
- **Leadership**: How you drive change across orgs, mentoring philosophy, technical vision, incident command
- **Behavioral**: Biggest technical failure and what you learned, influencing without authority, setting technical direction

### Timeline

- Month 15: Failure modes and incident response (all)
- Month 16: Architecture specialization
- Month 17: Trading or infrastructure specialization
- Month 18: Data, compliance, or operations specialization
- Month 19: System design practice, Staff+ interview prep
- Month 20: Mock interviews, final preparation

## Summary

| Stage | Level | Timeline | Files | Interview Difficulty |
|-------|-------|----------|-------|-------------------|
| 1 | Entry | Months 1-3 | 12 beginner | Coding + OS + probability |
| 2 | Mid | Months 4-8 | 22 intermediate | System design components |
| 3 | Senior | Months 9-14 | 36 advanced | Full system design + depth |
| 4 | Staff+ | Months 15-20 | 43 staff | Multi-system + leadership |

Total: ~113 core concept files across 4 stages, from zero to Staff+ ready.
