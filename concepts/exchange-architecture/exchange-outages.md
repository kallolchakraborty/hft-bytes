---
type: reference
title: "Exchange Outages"
description: "CME Globex outages: known patterns — EOS (Enhanced Order. Eurex T7 maintenance windows: scheduled Sunday maintenance"
tags: ["exchange-protocols"]
timestamp: "2026-06-27T03:06:09.430Z"
phase: 8
phaseName: "Exchange Architecture"
category: "Phase 8 - Exchange Architecture"
subcategory: "exchange-architecture"
language: "cpp"
artifact-id: "ZHFT_EXCHANGE_OUTAGES"
---
## Key Learning Points

- CME Globex outages: known patterns — EOS (Enhanced Order
- Eurex T7 maintenance windows: scheduled Sunday maintenance
- ICE unscheduled outages: less common but ICE's single
- Outage detection: monitor heartbeat from exchange, sequence
- Failover: route orders to other venues/same product listed

## Usage

// OutageDetector det;
// det.onHeartbeatTimeout("CME", 5000);
// det.onMarketDataFreeze("ES", 100);
// auto status = det.status("CME");

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
