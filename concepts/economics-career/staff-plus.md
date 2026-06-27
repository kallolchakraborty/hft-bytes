---
type: reference
title: "Staff Plus"
description: "Scope/Leverage/Judgment rubric: Staff+ engineers at HFT firms operate. System design interview patterns in HFT: tick-to-trade pipeline, feed"
tags: ["phase-16"]
timestamp: "2026-06-27T03:06:09.457Z"
phase: 16
phaseName: "HFT Economics & Career"
category: "Phase 16 - HFT Economics & Career"
subcategory: "economics-career"
language: "cpp"
artifact-id: "ZHFT_STAFF_PLUS"
---
## Key Learning Points

- Scope/Leverage/Judgment rubric: Staff+ engineers at HFT firms operate
- System design interview patterns in HFT: tick-to-trade pipeline, feed
- Reading list: "Trading and Exchanges" (Harris), "Algorithmic Trading"
- Mentoring: knowledge transfer is critical in HFT where domain expertise
- Technical leadership without authority: influence architecture decisions

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
// Career progression framework rubric.
// ---------------------------------------------------------------------------
struct LevelRubric {
  std::string title;       // "Staff Engineer", "Principal Engineer"
  std::string scope;       // "Team", "Multiple teams", "Org-wide", "Industry"
  std::string leverage;    // "Code", "Design", "Mentoring", "Strategy"
  std::string judgment;    // "Guided", "Independent", "Vision-setting"
  std::string example_responsibilities;
};

class CareerFramework {
  std::vector<LevelRubric> levels_ = {
    {
      "Senior Engineer (L4)",
      "Single team (2-5 engineers)",
      "Significant code contributions; code reviews; on-call",
      "Guided — operates within established patterns",
      "Implement complex features; mentor juniors; improve test coverage",
    },
    {
      "Staff Engineer (L5)",
      "Multiple teams (5-15 engineers)",
      "Architecture decisions; cross-team coordination; incident command",
      "Independent — makes design decisions with minimal guidance",
      "Design and own critical subsystems (feed handler, OMS, risk gate); "
      "drive postmortem culture; set coding standards",
    },
    {
      "Senior Staff / Principal (L6)",
      "Org-wide (15-50 engineers)",
      "Technical strategy; hiring bar; external presence",
      "Vision-setting — defines technical roadmap for the organisation",
      "Define multi-year architecture; lead major rewrites; represent firm "
      "at conferences; engage with exchange tech teams",
    },
    {
      "Fellow / Distinguished (L7)",
      "Industry-wide",
      "Published research; patents; industry standards bodies",
      "Industry-shaping — sets direction for HFT technology broadly",
      "Author papers on low-latency techniques; contribute to IEEE/ISO/FPGA "
      "standards; speak at top-tier conferences",
    },
  };

public:
  std::string describe(const std::string &title) const {
    for (const auto &l : levels_) {
      if (l.title.find(title) != std::string::npos) {
        std::ostringstream out;
        out << "=== " << l.title << " ===\n";
        out << "  Scope: " << l.scope << "\n";
        out << "  Leverage: " << l.leverage << "\n";
        out << "  Judgment: " << l.judgment << "\n";
        out << "  Responsibilities: " << l.example_responsibilities << "\n";
        return out.str();
      }
    }
    return "Level not found";
  }
};

// ---------------------------------------------------------------------------
// HFT system design interview question bank.
// ---------------------------------------------------------------------------
struct SystemDesignQuestion {
  std::string domain;     // "feed", "order", "risk", "infra", "networking"
  std::string question;
  std::vector<std::string> key_considerations;
  std::vector<std::string> follow_ups;
};

class InterviewQuestionBank {
  std::vector<SystemDesignQuestion> questions_ = {
    {
      "feed",
      "Design a market data feed handler for ITCH 5.0",
      {"Zero-copy parsing", "Sequence gap detection",
       "Feed A/B failover < 1µs", "Memory-mapped ring buffer",
       "NUMA-aware packet steering"},
      {"How do you handle exchange sequence resets mid-session?",
       "What happens on a retransmission request with 100k messages?"},
    },
    {
      "order",
      "Design an order management system that handles 500k orders/second",
      {"Lock-free order book per symbol", "Order ID generation (no contention)",
       "FIX session state machine", "Mass cancel performance",
       "Idempotency keys for retransmission protection"},
      {"How do you detect phantom fills?",
       "How do you handle a partial fill with no further execution?"},
    },
    {
      "risk",
      "Design a pre-trade risk gate for an HFT system",
      {"Latency budget: < 500ns total", "Parallelised checks (not serial)",
       "Max order value, max order rate, max position",
       "Kill switch with atomic signalling",
       "Per-symbol and per-strategy limits"},
      {"How do you handle risk limits that change intraday?",
       "What latency does the risk gate add to the hot path?"},
    },
    {
      "infra",
      "Design the time synchronisation infrastructure for a multi-site HFT setup",
      {"PTP grandmaster with GPS", "Boundary clocks in switches",
       "CLOCK_TAI vs CLOCK_MONOTONIC vs CLOCK_REALTIME",
       "Holdover performance during GPS outage",
       "Clock drift monitoring and alerting"},
      {"How do you detect non-monotonic timestamps?",
       "What happens when the PTP grandmaster fails?"},
    },
    {
      "networking",
      "Design a multicast market data distribution system in colo",
      {"IGMP/ASM/SSM groups", "Congestion loss detection",
       "Latency-jitter control via PFC and ECN",
       "MC-LAG for redundancy", "Packet capture at line rate"},
      {"How do you detect and recover from a kernel bypass RX ring overflow?",
       "What's the latency difference between DPDK and kernel TCP?"},
    },
  };

public:
  SystemDesignQuestion random_question() const {
    return questions_[rand() % questions_.size()];
  }

  void print_all() const {
    for (const auto &q : questions_) {
      std::cout << "[" << q.domain << "] " << q.question << "\n";
    }
  }
};

// ---------------------------------------------------------------------------
// Reading list.
// ---------------------------------------------------------------------------
struct ReadingItem {
  std::string category;     // "book", "paper", "blog", "talk"
  std::string title;
  std::string author;
  std::string relevance;
};

namespace ReadingList {

inline std::vector<ReadingItem> hftReadingList() {
  return {
    {"book", "Trading and Exchanges: Market Microstructure for Practitioners",
     "Larry Harris", "Foundational: order types, market structure, regulation"},
    {"book", "Algorithmic Trading: Winning Strategies and Their Rationale",
     "Ernest Chan", "Practical strategies, backtesting methodology"},
    {"book", "Flash Boys: A Wall Street Revolt",
     "Michael Lewis", "Cultural context: why latency matters"},
    {"paper", "High-Frequency Trading and the Cost of Latency",
     "Biais, Foucault, Moinas", "Economic analysis of latency arbitrage"},
    {"paper", "The Microstructure of the Flash Crash",
     "Kirilenko et al.", "Analysis of the 2010 Flash Crash from CFTC data"},
    {"blog", "Dan Luu's Low Latency Trading Series",
     "Dan Luu", "Practical C++ optimisations for trading systems"},
    {"blog", "Jane Street Tech Blog",
     "Jane Street", "OCaml in HFT, FPGA design, distributed systems"},
    {"talk", "CppCon: Real-time C++ for HFT",
     "Various", "Optimization techniques for sub-microsecond latency"},
  };
}

} // namespace ReadingList
```
