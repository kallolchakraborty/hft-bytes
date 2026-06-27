---
type: reference
title: "DR Failover"
description: "Active-active: both sites trade simultaneously (complex reconcile); active-. State synchronization via transaction log shipping — replicate every state"
tags: ["recovery"]
difficulty: staff
timestamp: "2026-06-27T03:06:09.453Z"
phase: 15
phaseName: "Testing & Production"
category: "Phase 15 - Testing & Production"
subcategory: "testing-production"
language: "cpp"
artifact-id: "ZHFT_DR_FAILOVER"
---
## Key Learning Points

- Active-active: both sites trade simultaneously (complex reconcile); active-
- State synchronization via transaction log shipping — replicate every state
- RTO (Recovery Time Objective): for HFT, sub-second failover is table stakes;
- Failover testing must be automated and run weekly — manual failover drills
- DNS vs anycast for failover: DNS TTL can be 30-300s (too slow); anycast

## Source Code

```cpp
#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <functional>
#include <map>
#include <memory>
#include <optional>
#include <queue>
#include <span>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

// ---------------------------------------------------------------------------
// Transaction log record — captures every state mutation for replication.
// ---------------------------------------------------------------------------
struct TxnLogRecord {
  uint64_t seq;          // Monotonic sequence (LSN)
  uint64_t timestamp_ns;
  uint16_t entry_type;   // 0=order_new, 1=order_fill, 2=position_change, 3=config
  uint8_t  payload[48];  // Serialised protobuf or flatbuffers.
};

// ---------------------------------------------------------------------------
// Transaction log shipper — ships records from primary to standby.
// ---------------------------------------------------------------------------
class TxnLogShipper {
  std::queue<TxnLogRecord> pending_;
  uint64_t last_sent_seq_ = 0;
  uint64_t last_acked_seq_ = 0;

public:
  // Called by the trading engine on each state mutation.
  void append(const TxnLogRecord &rec) {
    pending_.push(rec);
  }

  // Background thread: ship pending records over TCP or RDMA.
  void ship_loop() {
    while (true) {
      while (!pending_.empty()) {
        auto &rec = pending_.front();
        // send(rec) over RDMA / TCP to standby.
        last_sent_seq_ = rec.seq;
        pending_.pop();
      }
      std::this_thread::sleep_for(std::chrono::microseconds(50));
    }
  }

  // Called when standby acknowledges receipt up to a given sequence.
  void ack(uint64_t seq) {
    last_acked_seq_ = seq;
  }

  uint64_t replication_lag() const {
    return last_sent_seq_ - last_acked_seq_;
  }
};

// ---------------------------------------------------------------------------
// State sync monitor — watches replication lag and cluster health.
// ---------------------------------------------------------------------------
class StateSyncMonitor {
  TxnLogShipper &shipper_;
  uint64_t max_lag_before_alert_ = 100; // Max unacknowledged records.

public:
  explicit StateSyncMonitor(TxnLogShipper &s) : shipper_(s) {}

  struct Health {
    bool   healthy;
    uint64_t current_lag;
    uint64_t max_allowed_lag;
    std::string status;
  };

  Health check() const {
    uint64_t lag = shipper_.replication_lag();
    bool ok     = lag <= max_lag_before_alert_;
    return {.healthy         = ok,
            .current_lag     = lag,
            .max_allowed_lag = max_lag_before_alert_,
            .status          = ok ? "OK" : "LAG EXCEEDED"};
  }
};

// ---------------------------------------------------------------------------
// Failover orchestrator — detects failures and coordinates the switch.
// ---------------------------------------------------------------------------
class FailoverOrchestrator {
  enum class Role { Primary, Standby, Failed };
  std::atomic<Role> role_{Primary};

  // Heartbeat from the peer; cleared on failure.
  std::chrono::steady_clock::time_point last_heartbeat_;
  uint64_t heartbeat_timeout_ms_ = 1500; // 3 heartbeats at 500ms.

public:
  bool is_primary() const { return role_ == Primary; }

  // Called periodically (every 500ms) by the heartbeat thread.
  void heartbeat_received() {
    last_heartbeat_ = std::chrono::steady_clock::now();
  }

  // Check peer health — if too many heartbeats missed, trigger failover.
  bool check_peer_health() {
    auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
                       std::chrono::steady_clock::now() - last_heartbeat_).count();
    if (elapsed > heartbeat_timeout_ms_) {
      if (role_ == Primary) {
        // Primary detected standby failure — run in degraded mode.
        role_ = Primary;
      } else {
        // Standby detected primary failure — promote to primary.
        role_ = Primary;
        // In production: acquire distributed lock, replay txn log to catch up.
        return false; // Failover triggered.
      }
    }
    return true;
  }

  // Graceful role swap (for maintenance).
  void relinquish_primary() {
    role_ = Standby;
  }
};

// ---------------------------------------------------------------------------
// Anycast failover helper — BGP withdrawal via ExaBGP or Bird.
// ---------------------------------------------------------------------------
class AnycastFailover {
  // Execute BGP command to withdraw/announce the anycast prefix.
  // Example: "birdc announce 192.0.2.0/24 via 10.0.0.1"
  static void announce_prefix(const std::string &prefix,
                              const std::string &next_hop) {
    std::string cmd = "birdc announce " + prefix + " via " + next_hop;
    std::system(cmd.c_str());
  }

  static void withdraw_prefix(const std::string &prefix) {
    std::string cmd = "birdc withdraw " + prefix;
    std::system(cmd.c_str());
  }
};
```
