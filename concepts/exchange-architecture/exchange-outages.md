---
type: reference
title: "Exchange Outages"
description: "CME Globex outages: known patterns — EOS (Enhanced Order. Eurex T7 maintenance windows: scheduled Sunday maintenance"
tags: ["exchange-protocols"]
difficulty: intermediate
timestamp: "2026-06-27T03:06:09.430Z"
phase: 8
phaseName: "Exchange Architecture"
category: "Phase 8 - Exchange Architecture"
subcategory: "exchange-architecture"
language: "cpp"
artifact-id: "ZHFT_EXCHANGE_OUTAGES"
---
## Key Learning Points

- **CME Globex outages**: known patterns — EOS (Enhanced Order Splitting) system failures cause per-product matching engine halts (ES on one engine, NQ on another). Recent examples: January 2024 EOS failure (45 min), August 2023 partial outage (20 min). Symptoms: order entry rejected (iLink3 returns reject code 9999), market data continues flowing for unaffected products. For HFT: monitor per-product order acceptance rate — if it drops to zero while market data continues, it's an EOS-specific outage, not a full exchange failure. Route to backup venue immediately
- **Eurex T7 maintenance windows**: scheduled Sunday maintenance (06:00-18:00 CET) for system upgrades. During maintenance, order entry is unavailable but market data may continue in read-only mode. Eurex publishes a maintenance calendar 3 months in advance. For HFT: build a maintenance-aware scheduler that automatically pauses trading 30 minutes before maintenance and resumes 15 minutes after. Never assume maintenance will be short — some upgrades extend by 2-4 hours
- **ICE unscheduled outages**: less common but ICE's single matching engine design means an outage affects all products simultaneously. ICE's infrastructure is less redundant than CME's multi-engine design. Outage duration: typically 10-30 minutes. For HFT: ICE outages are the most dangerous because there's no product-level failover within ICE — you must route to a completely different exchange (CME, Eurex) or pause trading entirely
- **Outage detection**: monitor heartbeat from exchange (FIX 35=0), sequence number continuity, and market data freshness. Three signals: (a) heartbeat timeout (no heartbeat in 2x negotiated interval); (b) market data freeze (no update in 100ms for liquid products); (c) sequence gap (seqno jumps by > 1 without retransmission). Detection latency target: < 1 second. For HFT: build an outage detector that runs on a dedicated core (not shared with trading logic) to ensure detection even when the trading process is overloaded
- **Failover strategy**: route orders to other venues where the same product is listed (ES on CME and ICE, DAX on Eurex and Xetra). Pre-configure backup venue connectivity for every product. On outage detection: (a) cancel all orders on the affected venue; (b) switch order routing to backup venue; (c) adjust risk limits for the backup venue (it may have different position limits); (d) alert the trading desk. Recovery: when the primary venue recovers, gradually shift orders back (don't flood the venue with reconnection orders). For HFT: the failover decision must be automated — manual failover takes 30-60 seconds, during which you're blind to the affected venue

## Usage

```bash

OutageDetector det;
det.onHeartbeatTimeout("CME", 5000);
det.onMarketDataFreeze("ES", 100);
auto status = det.status("CME");
```

## Source Code

```cpp
#include <algorithm>
#include <array>
#include <bit>
#include <chrono>
#include <cstdint>
#include <cstring>
#include <functional>
#include <map>
#include <string_view>
#include <vector>

// ---------------------------------------------------------------------------
// Outage types
// ---------------------------------------------------------------------------
enum class OutageType : uint8_t {
  None,
  HeartbeatLoss,       // No heartbeat received
  MarketDataFreeze,    // No market data update
  SequenceGap,         // Large seq gap without recovery
  SessionDisconnect,   // TCP disconnect
  ExchangeDown,        // Exchange-wide event
  MaintenanceWindow,   // Scheduled
};

// ---------------------------------------------------------------------------
// Venue status
// ---------------------------------------------------------------------------
struct VenueStatus {
  char     name[16];
  OutageType outage = OutageType::None;
  uint64_t last_heartbeat_ms;   // Since epoch
  uint64_t last_md_update_ms;
  uint64_t seq_gap_count;
  bool     is_recovering;
  uint64_t outage_start_ms;
  uint64_t outage_end_ms;       // 0 = ongoing
};

// ---------------------------------------------------------------------------
// Outage detector
// ---------------------------------------------------------------------------
class OutageDetector {
public:
  void registerVenue(std::string_view name) {
    VenueStatus vs;
    std::strncpy(vs.name, name.data(), std::min(name.size(), size_t(15)));
    vs.last_heartbeat_ms = currentMillis();
    vs.last_md_update_ms = currentMillis();
    venues_[name] = vs;
  }

  void onHeartbeat(std::string_view venue) {
    auto it = venues_.find(venue);
    if (it == venues_.end()) return;
    it->second.last_heartbeat_ms = currentMillis();
    if (it->second.outage == OutageType::HeartbeatLoss) {
      it->second.outage = OutageType::None;
      it->second.is_recovering = false;
      it->second.outage_end_ms = currentMillis();
    }
  }

  void onMarketDataUpdate(std::string_view venue) {
    auto it = venues_.find(venue);
    if (it == venues_.end()) return;
    it->second.last_md_update_ms = currentMillis();
  }

  OutageType detect(std::string_view venue) {
    auto it = venues_.find(venue);
    if (it == venues_.end()) return OutageType::None;

    auto now = currentMillis();
    auto &vs = it->second;

    // Check heartbeat loss (threshold: 5s)
    // TRADEOFF: CME iLink 3 heartbeat interval negotiable (tag 108).
    // Set threshold to 2x negotiated interval to avoid false positives.
    if (now - vs.last_heartbeat_ms > 5000) {
      vs.outage = OutageType::HeartbeatLoss;
      vs.outage_start_ms = vs.last_heartbeat_ms;
      onOutageDetected(venue, vs.outage);
      return vs.outage;
    }

    // Check market data freeze (threshold: 100ms)
    // CRITICAL: during high-volatility, market data updates every
    // microsecond. 100ms without update = almost certainly a freeze.
    if (now - vs.last_md_update_ms > 100) {
      vs.outage = OutageType::MarketDataFreeze;
      vs.outage_start_ms = vs.last_md_update_ms;
      onOutageDetected(venue, vs.outage);
      return vs.outage;
    }

    if (vs.outage != OutageType::None && vs.is_recovering) {
      vs.outage = OutageType::None;
      vs.is_recovering = false;
      vs.outage_end_ms = now;
    }

    return OutageType::None;
  }

  // Status for all venues
  std::vector<VenueStatus> allStatus() const {
    std::vector<VenueStatus> out;
    for (auto &[_, vs] : venues_) out.push_back(vs);
    return out;
  }

  // Callback for failover logic
  void setOutageHandler(std::function<void(std::string_view, OutageType)> h) {
    handler_ = std::move(h);
  }

private:
  std::map<std::string, VenueStatus, std::less<>> venues_;
  std::function<void(std::string_view, OutageType)> handler_;

  void onOutageDetected(std::string_view venue, OutageType type) {
    if (handler_) handler_(venue, type);
  }

  static uint64_t currentMillis() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now().time_since_epoch()).count();
  }
};

// ---------------------------------------------------------------------------
// Venue failover state machine
// ---------------------------------------------------------------------------
class VenueFailover {
public:
  enum class FailoverState : uint8_t {
    Primary,
    Degraded,
    FailoverToBackup,
    Recovering,
    BackToPrimary,
  };

  void setVenues(std::string_view primary, std::string_view backup) {
    primary_ = primary;
    backup_ = backup;
  }

  void onOutage(std::string_view venue, OutageType type) {
    if (venue == primary_ && type != OutageType::None) {
      // Primary failed — fail over
      state_ = FailoverState::FailoverToBackup;
      // Route all orders to backup venue
      // Widen spreads, reduce order sizes
    }
  }

  void onRecovery(std::string_view venue) {
    if (venue == primary_ && state_ == FailoverState::FailoverToBackup) {
      state_ = FailoverState::Recovering;
      // Gradually shift orders back to primary
    }
  }

  FailoverState state() const { return state_; }

private:
  std::string primary_;
  std::string backup_;
  FailoverState state_ = FailoverState::Primary;
};

// Case Study: CME Globex Outage on January 12, 2024
//   - Duration: ~45 minutes
//   - Cause: EOS (Enhanced Order Splitting) system failure
//   - Symptoms: order entry rejected (iLink 3), market data continued
//   - Impact: ES, NQ, CL all halted
//   - Recovery: manual failover to backup EOS, gap fill on reconnect
//   - Lesson: CME's per-product matching engines (EOS) create single
//     points of failure. Keep backup venue ready (even if low liquidity).
```
