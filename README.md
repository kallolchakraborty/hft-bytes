# hft bytes

**Comprehensive HFT knowledge portal** — 181 documentation artifacts across 17 phases covering the full high-frequency trading engineering stack, from CPU architecture and kernel bypass to exchange protocols, trading strategies, and production failure modes.

Built for senior C++/systems developers working in or aspiring to join the HFT industry. Every artifact contains runnable code examples, key learning points, and real-world usage patterns.

## Features

- **181 searchable artifacts** across 4 tracks and 17 phases
- **Runnable code examples** in C++, Python, Bash, and YAML — no abstractions, just production patterns
- **Vertical timeline roadmap** with milestone tracking for the 17-week study plan
- **Full-text search** (`Ctrl+K`) across titles, descriptions, tags, and section headers
- **Dark/light theme** with persistent toggle
- **Mermaid.js diagrams** inline for architecture flows, state machines, and pipelines
- **Responsive 3-column layout** — sidebar navigation, content, and on-page outline
- **16 hand-drawn SVG diagrams** for latency decomposition, CPU cache hierarchy, exchange architecture, lock-free queues, FPGA pipelines, and more
- **Decision matrices** for technology and vendor selection
- **Failure mode catalog** with production incident response patterns

## Quick Start

```bash
git clone https://github.com/kallolchakraborty/hft-bytes.git
cd hft-bytes
node scripts/build.mjs        # generate content + search index
python3 -m http.server 3000    # serve on localhost:3000
```

Open [http://localhost:3000](http://localhost:3000) and explore.

## Curriculum — 17 Phases

### Track 1: Core Engineering

| Phase | Topic | Focus |
|-------|-------|-------|
| 1 | Foundations | CPU architecture, memory hierarchy, cache coherency, NUMA, RDTSC, SIMD, Linux/BIOS tuning |
| 2 | Mathematics & Statistics | Probability distributions, time series, Kalman filters, signal processing, ML basics, stochastic calculus |
| 3 | C++ Low-Latency Patterns | Lock-free queues, wait-free hazard pointers, memory pool allocators, atomics, cache-friendly data structures |
| 4 | System Programming & IPC | Shared memory, FlatBuffers, SBE, binary logging, build systems, cross compilation |

### Track 2: Network & Market Access

| Phase | Topic | Focus |
|-------|-------|-------|
| 5 | Kernel Bypass & Protocols | DPDK, TCP/Onload, FIX, ITCH/OUCH, TCP tuning, UDP multicast, SIMD parsers |
| 6 | Network Hardware | NIC tuning, switch topology, packet capture, cross-DC connectivity, cabling physics |
| 7 | Order Entry & Execution | FIX engine, OMS, SOR, risk checks, order types, auction handling, desk tools |
| 8 | Exchange Architecture | Matching engines, CME iLink3, Eurex T7, LSE Millennium, ICE Binary, fee structures, certification |

### Track 3: Trading & Analytics

| Phase | Topic | Focus |
|-------|-------|-------|
| 9 | Order Book & Microstructure | LOB reconstruction, feed handlers, book imbalance, gap recovery, tape reading, dark pools |
| 10 | Trading Strategies | Market making, latency arbitrage, pairs trading, momentum, optimal execution, TCA |
| 11 | Backtesting & Simulation | Event-driven engine, market replay, latency simulation, overfitting prevention |
| 12 | Data Engineering | kdb+/q, ClickHouse, real-time pipelines, historical data, compression, reference data |

### Track 4: Operations & Career

| Phase | Topic | Focus |
|-------|-------|-------|
| 13 | FPGA & Hardware | FPGA parsing, order generation, vendor guide, FPGA vs CPU tradeoffs |
| 14 | Monitoring & Security | Grafana/Prometheus, latency histograms, SLI/SLO, structured logging, secrets management |
| 15 | Testing & Production | Deterministic testing, replay, chaos engineering, CI/CD, canary release, DR/failover, colocation, cloud/hybrid infra |
| 16 | Economics & Career | Latency cost modeling, colo budgeting, vendor evaluation, compensation, staff+ engineering |
| 17 | Failure Modes & Recovery | Split-brain, clock anomalies, phantom orders, sequence resets, mass cancel, incident response |

## Project Structure

```
hft-bytes/
├── assets/diagrams/       # 16 SVG architecture diagrams
├── concepts/              # Source markdown for all artifacts (19 categories)
│   ├── backtesting/
│   ├── cpp-patterns/
│   ├── data-engineering/
│   ├── exchange-architecture/
│   ├── failure-modes/
│   ├── foundations/
│   ├── fpga/
│   ├── kernel-bypass/
│   └── ...
├── content/               # Generated JSON (route content, search index)
├── css/
│   ├── main.css           # Custom styles + brand theme (hot red)
│   └── tailwind.css       # Pre-built Tailwind utility classes
├── js/
│   ├── loader.js          # SPA router, search, theme, share
│   └── generated.js       # Auto-generated route map + search index
├── scripts/
│   └── build.mjs          # Build pipeline: parse → render → index
├── docs.html              # Main SPA entry point (3-column layout)
├── index.html             # Landing page
└── package.json
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Styling | Tailwind CSS (pre-built static), custom CSS variables |
| Build | Node.js (vanilla, no framework) |
| Diagrams | SVG (hand-drawn), Mermaid.js v10 (inline) |
| Search | Client-side full-text index (auto-generated) |
| Icons | Material Symbols |
| Font | Ubuntu |
| Theme | CSS custom properties (`--brand-primary: #FF1744`) |

## Development

```bash
# Build content + search index
node scripts/build.mjs

# Serve locally
python3 -m http.server 3000
```

The build script:
1. Scans `concepts/` for markdown files with YAML frontmatter
2. Parses frontmatter (title, phase, tags, description, language)
3. Renders markdown to HTML (code blocks, tables, mermaid fenced blocks)
4. Generates `content/*.json` route payloads
5. Builds client-side search index (`js/generated.js`)

### Adding an Artifact

```markdown
---
type: reference
title: "Your Topic"
description: "Brief description"
tags: ["category"]
timestamp: "2026-01-01T00:00:00.000Z"
phase: 1
phaseName: "Foundations"
category: "Your Category"
subcategory: "your-category"
language: "cpp"
artifact-id: "ZHFT_YOUR_ID"
---
## Key Learning Points

- Point one
- Point two

## Usage

```cpp
// code example
```

## Source Code

```cpp
// production pattern
```
```

Then rebuild with `node scripts/build.mjs`.

## Author

Created by [Kallol Chakraborty](https://www.linkedin.com/in/kallol-chakraborty-9728a699/).

## License

ISC — see [LICENSE](LICENSE).
