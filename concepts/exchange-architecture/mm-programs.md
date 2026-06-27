---
type: reference
title: "Mm Programs"
description: "DMM (Designated Market Maker): NYSE/NASDAQ program with. SLP (Supplemental Liquidity Provider): lower obligations than"
tags: ["trading"]
difficulty: intermediate
timestamp: "2026-06-27T03:06:09.432Z"
phase: 8
phaseName: "Exchange Architecture"
category: "Phase 8 - Exchange Architecture"
subcategory: "exchange-architecture"
language: "cpp"
artifact-id: "ZHFT_MM_PROGRAMS"
---
## Key Learning Points

- DMM (Designated Market Maker): NYSE/NASDAQ program with
- SLP (Supplemental Liquidity Provider): lower obligations than
- Market maker obligations: minimum quote size (e.g., 100 sh),
- Exchange-provided risk checks: CME DCASS (CME Clearing's
- Sponsored access vs DMA: Sponsored access = broker provides

## Usage

// MmObligationMonitor mm(/* venue */ "CME");

## Source Code

```cpp
*   // mm.setObligations({100, 0.05, 0.10});
 *   // mm.recordQuote(Symbol::ES, 4500.00, 4500.50);
 *   // bool ok = mm.checkCompliance();
 *
 * PERFORMANCE TARGET:
 *   Compliance check < 500 ns; obligation tracking < 100 ns/update
 * ====================================================================
 */

#include <algorithm>
#include <array>
#include <bit>
#include <chrono>
#include <cstdint>
#include <cstring>
#include <string_view>
#include <unordered_map>
#include <vector>

// ---------------------------------------------------------------------------
// Market maker obligations
// ---------------------------------------------------------------------------
struct MmObligations {
  uint64_t min_quote_size;    // Minimum shares per quote
  double   max_spread_pct;    // Maximum spread as % of mid
  double   min_participation; // Minimum % of trading time quoting
  uint64_t min_uptime_pct;    // Minimum session uptime %
  uint64_t max_cancel_pct;    // Max cancel-to-order ratio %
};

// ---------------------------------------------------------------------------
// Quote record
// ---------------------------------------------------------------------------
struct QuoteRecord {
  uint64_t symbol_hash;
  double   bid;
  double   ask;
  uint64_t bid_size;
  uint64_t ask_size;
  uint64_t timestamp_ns;
  bool     is_compliant;  // Checked at record time
};

// ---------------------------------------------------------------------------
// Market maker obligation monitor
// ---------------------------------------------------------------------------
class MmObligationMonitor {
public:
  void setObligations(const MmObligations &obl) {
    obligations_ = obl;
  }

  void recordQuote(const QuoteRecord &qr) {
    quotes_.push_back(qr);

    // TRADEOFF: checking compliance on every quote adds latency.
    // Market makers often batch-check every 1ms or sample 1:N.
    bool compliant = true;

    // Check spread
    double mid = (qr.bid + qr.ask) / 2.0;
    double spread = (qr.ask - qr.bid) / mid;
    if (spread > obligations_.max_spread_pct) compliant = false;

    // Check size
    if (qr.bid_size < obligations_.min_quote_size ||
        qr.ask_size < obligations_.min_quote_size) compliant = false;

    quotes_.back().is_compliant = compliant;
  }

  // Periodic compliance check (called every N seconds)
  struct ComplianceReport {
    bool passes;
    double participation_rate;
    double avg_spread_pct;
    double cancel_ratio;
    uint64_t compliant_quotes;
    uint64_t total_quotes;
  };

  ComplianceReport checkCompliance() const {
    ComplianceReport r{};
    if (quotes_.empty()) return r;

    uint64_t compliant = 0;
    double total_spread = 0;
    for (auto &q : quotes_) {
      if (q.is_compliant) compliant++;
      double mid = (q.bid + q.ask) / 2.0;
      total_spread += (q.ask - q.bid) / mid;
    }

    r.compliant_quotes = compliant;
    r.total_quotes = quotes_.size();
    r.participation_rate = static_cast<double>(compliant) / quotes_.size();
    r.avg_spread_pct = total_spread / quotes_.size();

    // TRADEOFF: participation rate threshold is ~10% for most programs.
    // Below this risks losing market maker status.
    r.passes = r.participation_rate >= obligations_.min_participation &&
               r.avg_spread_pct <= obligations_.max_spread_pct;

    return r;
  }

  // Cancel-to-order ratio
  double cancelRatio() const {
    // Track separately: orders vs cancels
    return 0.0; // placeholder
  }

private:
  MmObligations obligations_;
  std::vector<QuoteRecord> quotes_;
  uint64_t orders_sent_ = 0;
  uint64_t cancels_sent_ = 0;
};

// ---------------------------------------------------------------------------
// Exchange risk system integration
// ---------------------------------------------------------------------------
enum class ExchangeRiskSystem : uint8_t {
  CME_DCASS,
  Eurex_Prisma,
  ICE_Risk,
  LSE_Risk,
  None,
};

class ExchangeRiskIntegration {
public:
  void configure(ExchangeRiskSystem sys) {
    system_ = sys;
    switch (sys) {
    case ExchangeRiskSystem::CME_DCASS:
      // DCASS: CME Clearing risk system — monitors open interest,
      // margin utilization, credit limits. Rejects orders exceeding limits.
      // CME sends RiskWarning message via iLink 3.
      break;
    case ExchangeRiskSystem::Eurex_Prisma:
      // Prisma: portfolio-based margining, margin pool monitoring.
      // Rejects if new position would exceed margin pool.
      break;
    default: break;
    }
  }

  bool checkRisk(const RiskOrder &ord) {
    // Simulated: in production, exchange provides real-time risk
    // status via session messages
    return true;
  }

private:
  ExchangeRiskSystem system_ = ExchangeRiskSystem::None;
};
```
