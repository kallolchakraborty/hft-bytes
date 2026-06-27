---
type: reference
title: "Compliance Test"
description: "Reg NMS best execution: trade-through rule, order protection, market data. MiFID II transaction reporting: 65+ fields per transaction, T+1 reporting,"
tags: ["testing"]
difficulty: advanced
timestamp: "2026-06-27T03:06:09.451Z"
phase: 15
phaseName: "Testing & Production"
category: "Phase 15 - Testing & Production"
subcategory: "testing-production"
language: "cpp"
artifact-id: "ZHFT_COMPLIANCE_TEST"
---
## Key Learning Points

- Reg NMS best execution: trade-through rule, order protection, market data
- MiFID II transaction reporting: 65+ fields per transaction, T+1 reporting,
- Clock synchronization compliance: RTS 25 mandates UTC traceability within
- Order record keeping: MiFID II requires 5-year retention in non-rewritable
- Market manipulation surveillance: spoofing (layering), wash trading, pump

## Source Code

```cpp
#include <algorithm>
#include <array>
#include <chrono>
#include <compare>
#include <cstdint>
#include <ctime>
#include <filesystem>
#include <fstream>
#include <functional>
#include <map>
#include <optional>
#include <sstream>
#include <string>
#include <vector>

// ---------------------------------------------------------------------------
// Best execution report — Reg NMS compliance.
// ---------------------------------------------------------------------------
struct ExecutedOrder {
  uint64_t    order_id;
  std::string symbol;
  int64_t     exec_price;     // Scaled fixed-point (e.g., * 10000)
  uint32_t    exec_qty;
  uint64_t    exec_time_ns;
  std::string venue;          // "NASDAQ", "NYSE", "ARCA", etc.
  bool        is_nms_stock;
};

struct QuoteAtTime {
  std::string venue;
  int64_t     bid_price;
  uint64_t    bid_size;
  int64_t     ask_price;
  uint64_t    ask_size;
  uint64_t    timestamp_ns;
};

class BestExecutionVerifier {
  // NMS: protected (top-of-book) quotes per symbol, aggregated across venues.
  // Trade-through rule: an order to sell must not execute at a price below the
  // best bid if a protected bid exists.
  std::map<std::string, std::map<uint64_t, std::vector<QuoteAtTime>>> market_snapshots_;

public:
  struct Violation {
    uint64_t order_id;
    std::string symbol;
    int64_t exec_price;
    int64_t protected_price;
    std::string protected_venue;
    std::string description;
  };

  std::vector<Violation> check_best_execution(const ExecutedOrder &order,
                                               const std::vector<QuoteAtTime> &snapshots) {
    std::vector<Violation> violations;

    if (!order.is_nms_stock) return violations; // Reg NMS applies to NMS stocks only.

    // Find the best price across all venues at the execution time.
    int64_t best_bid   = 0;
    int64_t best_ask   = INT64_MAX;
    std::string best_venue;

    for (const auto &q : snapshots) {
      if (q.timestamp_ns > order.exec_time_ns) break; // Future quotes — skip.
      if (q.bid_price > best_bid) {
        best_bid   = q.bid_price;
        best_venue = q.venue;
      }
      if (q.ask_price < best_ask) {
        best_ask   = q.ask_price;
        best_venue = q.venue;
      }
    }

    // For a buy: trade-through if exec_price > best_ask (paid more than best offer).
    // For a sell: trade-through if exec_price < best_bid (received less than best bid).
    // This is simplified — real Reg NMS includes exceptions (intermarket sweep,
    // block trades, etc.).
    if (order.exec_price > best_ask) {
      violations.push_back({order.order_id, order.symbol, order.exec_price,
                            best_ask, best_venue,
                            "Trade-through on buy: paid more than best offer"});
    }
    if (order.exec_price < best_bid) {
      violations.push_back({order.order_id, order.symbol, order.exec_price,
                            best_bid, best_venue,
                            "Trade-through on sell: received less than best bid"});
    }

    return violations;
  }
};

// ---------------------------------------------------------------------------
// Clock synchronization compliance — RTS 25 checker.
// ---------------------------------------------------------------------------
class ClockSyncChecker {
  // Records the offset from UTC at periodic intervals.
  struct Measurement {
    uint64_t timestamp_ns;
    int64_t  offset_ns; // positive = local clock ahead of UTC.
  };

  std::vector<Measurement> history_;
  int64_t max_allowed_offset_ns_ = 1'000'000; // MiFID II RTS 25: ≤ 1ms.

public:
  // Called after each PTP/NTP sync.
  void record_sync(uint64_t now_ns, int64_t offset_ns) {
    history_.push_back({now_ns, offset_ns});
    if (std::abs(offset_ns) > max_allowed_offset_ns_) {
      // Trigger alert: clock drift exceeds regulatory threshold.
    }
  }

  struct ComplianceResult {
    bool   compliant;
    int64_t max_offset_ns;
    int64_t current_offset_ns;
    std::string recommendation;
  };

  ComplianceResult check() const {
    int64_t max_offset = 0;
    for (const auto &m : history_) {
      max_offset = std::max(max_offset, std::abs(m.offset_ns));
    }
    int64_t current = history_.empty() ? 0 : history_.back().offset_ns;

    return {.compliant       = max_offset <= max_allowed_offset_ns_,
            .max_offset_ns   = max_offset,
            .current_offset_ns = current,
            .recommendation  = max_offset > max_allowed_offset_ns_
                                   ? "Upgrade PTP grandmaster; check network path"
                                   : ""};
  }
};

// ---------------------------------------------------------------------------
// Market manipulation surveillance — spoofing detection stub.
// ---------------------------------------------------------------------------
class SpoofingDetector {
  // Counts order-to-trade ratio per symbol. Spoofers enter large orders they
  // never intend to fill (to mislead the market), then cancel them.
  struct SymbolStats {
    uint64_t large_orders_total;      // Orders > 10x typical size
    uint64_t large_orders_cancelled;  // Cancelled within 500ms
    uint64_t trades_total;
  };

  std::map<std::string, SymbolStats> stats_;

public:
  // Called per order event.
  void record_order(const std::string &symbol, uint64_t qty, bool is_large,
                    bool cancelled_early) {
    if (is_large) {
      stats_[symbol].large_orders_total++;
      if (cancelled_early) stats_[symbol].large_orders_cancelled++;
    }
  }

  void record_trade(const std::string &symbol) {
    stats_[symbol].trades_total++;
  }

  // Reg flag: order-to-trade ratio > 20:1 for large orders.
  std::vector<std::string> check_suspicious() const {
    std::vector<std::string> flags;
    for (const auto &[sym, st] : stats_) {
      if (st.trades_total == 0) continue;
      double ot_ratio = double(st.large_orders_total) / st.trades_total;
      if (ot_ratio > 20.0 && st.large_orders_cancelled > 100) {
        flags.push_back("Possible spoofing on " + sym +
                        ": OTR=" + std::to_string(ot_ratio));
      }
    }
    return flags;
  }
};
```
