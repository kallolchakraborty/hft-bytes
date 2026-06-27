---
type: reference
title: "Legal Compliance"
description: "Market manipulation red flags: spoofing — entering orders with intent to. Wash trading: simultaneous buy/sell orders for the same asset at the same"
tags: ["phase-16"]
difficulty: intermediate
timestamp: "2026-06-27T03:06:09.456Z"
phase: 16
phaseName: "HFT Economics & Career"
category: "Phase 16 - HFT Economics & Career"
subcategory: "economics-career"
language: "cpp"
artifact-id: "ZHFT_LEGAL_COMPLIANCE"
---
## Key Learning Points

- Market manipulation red flags: spoofing — entering orders with intent to
- Wash trading: simultaneous buy/sell orders for the same asset at the same
- Insider trading: trading on material non-public information (MNPI); even
- Record keeping: MiFID II requires 5-year retention of order records, phone
- Personal trading policies: employees must pre-clear personal trades; blackout
- Information barriers: physical separation between research and trading desks

## Source Code

```cpp
#include <algorithm>
#include <chrono>
#include <cstdint>
#include <ctime>
#include <iomanip>
#include <map>
#include <optional>
#include <set>
#include <sstream>
#include <string>
#include <vector>

// ---------------------------------------------------------------------------
// Market surveillance rule checker — flags suspicious order patterns.
// ---------------------------------------------------------------------------
struct OrderEvent {
  uint64_t    order_id;
  std::string symbol;
  int64_t     price;
  uint32_t    qty;
  bool        buy;
  uint64_t    timestamp_ns;
  std::string action;   // "new", "cancel", "modify", "fill"
  uint64_t    trader_id;
};

class MarketSurveillanceChecker {
  // Track per-trader, per-symbol order-to-trade ratio.
  struct TraderSymbolStats {
    uint64_t orders_cancelled;
    uint64_t trades_executed;
    uint64_t orders_total;
    uint64_t last_order_time_ns;
  };

  std::map<std::pair<uint64_t, std::string>, TraderSymbolStats> stats_;

  // Layering detection: orders entered at 5+ price levels (all cancelled).
  struct LayeringState {
    std::set<int64_t> price_levels;
    uint64_t          first_time_ns;
  };
  std::map<std::pair<uint64_t, std::string>, LayeringState> layering_;

public:
  enum FlagSeverity { Info, Warning, Critical };

  struct Flag {
    FlagSeverity severity;
    std::string  trader;
    std::string  symbol;
    std::string  rule;      // "spoofing_otr", "layering", "wash_trade"
    std::string  description;
    uint64_t     timestamp_ns;
  };

  std::vector<Flag> process_order(const OrderEvent &ev) {
    std::vector<Flag> flags;
    auto key = std::pair{ev.trader_id, ev.symbol};

    // Track OTR.
    auto &st = stats_[key];
    if (ev.action == "cancel") {
      st.orders_cancelled++;
    } else if (ev.action == "fill") {
      st.trades_executed++;
    }
    st.orders_total++;
    st.last_order_time_ns = ev.timestamp_ns;

    // Rule 1: Order-to-trade ratio > 20:1 (spoofing indicator).
    if (st.trades_executed > 0 && st.orders_total > 0) {
      double otr = double(st.orders_total) / st.trades_executed;
      if (otr > 20.0 && st.orders_cancelled > 50) {
        flags.push_back({Warning, std::to_string(ev.trader_id), ev.symbol,
                         "spoofing_otr",
                         "OTR=" + std::to_string(otr) + " cancels=" +
                             std::to_string(st.orders_cancelled),
                         ev.timestamp_ns});
      }
    }

    // Rule 2: Layering — orders at 5+ price levels within 1 second.
    if (ev.action == "new") {
      auto &ls = layering_[key];
      if (ls.price_levels.empty()) ls.first_time_ns = ev.timestamp_ns;
      ls.price_levels.insert(ev.price);

      // Check if 5+ levels within 1s window.
      if (ls.price_levels.size() >= 5 &&
          (ev.timestamp_ns - ls.first_time_ns) < 1'000'000'000ULL) {
        flags.push_back({Critical, std::to_string(ev.trader_id), ev.symbol,
                         "layering",
                         "Orders at " + std::to_string(ls.price_levels.size()) +
                             " price levels within 1 second",
                         ev.timestamp_ns});
        ls.price_levels.clear(); // Reset after flag.
      }
    }

    return flags;
  }
};

// ---------------------------------------------------------------------------
// Personal trading compliance tool.
// ---------------------------------------------------------------------------
class PersonalTradeCompliance {
  std::set<std::string> restricted_list_;    // Symbols the firm trades.
  std::set<std::string> blackout_symbols_;   // Symbols currently in blackout.
  uint64_t              employee_id_;

public:
  struct PreClearResult {
    bool   approved;
    std::string reason;
    uint64_t approved_until_ns; // Expiry of pre-clearance.
  };

  PreClearResult pre_clear(const std::string &symbol, bool buy) {
    if (restricted_list_.find(symbol) != restricted_list_.end()) {
      return {false, "Symbol on firm restricted list (MNPI wall)", 0};
    }
    if (blackout_symbols_.find(symbol) != blackout_symbols_.end()) {
      return {false, "Symbol in blackout window (firm trading active)", 0};
    }
    // Pre-clearance lasts for 1 trading day.
    auto until = std::chrono::system_clock::to_time_t(
        std::chrono::system_clock::now());
    until += 24 * 3600;
    return {true, "Pre-cleared", uint64_t(until) * 1'000'000'000ULL};
  }

  void set_restricted(const std::vector<std::string> &symbols) {
    restricted_list_.insert(symbols.begin(), symbols.end());
  }

  void set_blackout(const std::vector<std::string> &symbols) {
    blackout_symbols_ = std::set<std::string>(symbols.begin(), symbols.end());
  }
};

// ---------------------------------------------------------------------------
// Record keeping compliance — retention period enforcement.
// ---------------------------------------------------------------------------
/*
 * Regulatory Record Retention Requirements
 *
 * Regulation | Duration | Media Requirements        | Applies To
 * -----------|----------|---------------------------|----------------------
 * MiFID II   | 5 years  | Non-rewritable, indexed   | Order records, comms
 * SEC 17a-4  | 3 years  | WORM (Write Once Read Many)| Broker-dealer records
 * SEC 17a-3  | 6 years  | Accessible within 24h     | Trade blotters
 * Dodd-Frank | 5 years  | Electronic format          | Swap data
 * GDPR       | Until    | Encrypted, anonymisable    | Personal data
 *            | deletion |                           |
 */
```
