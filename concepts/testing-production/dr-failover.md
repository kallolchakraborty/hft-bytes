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
- **DR runbook structure**: every failover scenario must have a written runbook — a step-by-step checklist that can be executed by any on-call engineer at 3 AM. Structure: (a) trigger conditions (e.g., "Ping loss > 10% to primary colo for 30 seconds"); (b) initial assessment (check monitoring dashboard, confirm incident, declare severity); (c) failover decision (who decides, what's the authorization chain); (d) execution steps (numbered, specific commands); (e) verification (how to confirm failover is complete — "check venue connectivity, verify positions match"); (f) rollback steps (how to fail back). Runbooks must be tested in read-only mode during day time, executed during quarterly drills. Store runbooks in git alongside code (versioned, reviewed). Example HFT failover runbook: "Venue A primary data feed failed" → (1) confirm via backup feed status; (2) run `./failover_feed.sh venue_a primary->backup`; (3) verify feed handler seqno continuity; (4) alert desk via PagerDuty; (5) document in incident log
- **Quarterly DR testing methodology**: a full failover drill every quarter, scheduled during low-volatility periods. Scope: (a) network failover (disconnect primary circuit, confirm backup takes over within 1 second); (b) server failover (kill a trading process, confirm backup starts and connects to venues); (c) feed failover (disable primary market data feed, confirm backup feed handler is processing); (d) full colo failover (simulate primary colo outage, confirm secondary colo takes over trading). After each drill: produce a report with observed failover time, issues encountered, and improvement plan. Key metric: "time to failover" (TTO) — from incident detection to all systems operational. Target: < 1 second for network, < 5 seconds for server, < 60 seconds for colo. Track TTO per quarter; regressions indicate testing process decay
- **Cross-colo trading continuity**: when a colo goes dark (power outage, network cut, fire), trading must shift to a secondary colo. Requirements: (a) secondary colo must have connectivity to all venues (direct fiber or cross-connect); (b) position state must be live-replicated (transaction log shipping with < 50ms RPO); (c) the strategy must be running on the secondary colo within RTO target. Architecture: active-active (both colos process live market data, only primary sends orders) or active-passive (secondary has no live data until failover). Active-active is preferred — failover is a routing change (announce anycast prefix from secondary). Active-passive faces cold-start risk: the secondary must replay up to 50ms of market data to catch up, which can take seconds. Minimum: secondary colo must have pre-warmed order book state (at least 1 second of market data buffer)
- **BGP convergence time measurement**: anycast failover relies on BGP withdrawing the primary's prefix and announcing from the secondary. Convergence time = time for all network routers to update their routing tables. Target: < 1 second. Measurement: (a) run a continuous ping across the network path to the anycast IP; (b) trigger failover (withdraw prefix from primary); (c) measure the gap in successful ping responses. Typical: 500ms-2s for BGP convergence. Factors: number of routers in the path, BGP timers (keepalive 30s, hold time 90s default — tune to 1s/3s for HFT), route reflector topology. Optimization: use BGP PIC (Prefix Independent Convergence) for sub-200ms convergence. Use ExaBGP or Bird for fine-grained BGP control
- **Application-level failover (not just network)**: failover is not complete until the application is confirmed healthy, not just the network. After the network failover, verify: (a) all FIX sessions are connected and logged in; (b) sequence numbers are consistent (no gaps requiring resend); (c) positions on the backup match the primary's pre-failover state; (d) kill-switch state is maintained (if primary was killed, backup must also be killed); (e) risk limits are loaded correctly. Add an "application health check" step after every failover that probes all session states and position consistency. Automate this check — don't rely on manual verification during a real incident
- **Failover testing anti-patterns**: (a) "the surprise test" — failing over without warning is realistic but dangerous; start with announced tests. (b) "only testing at 3 PM on Tuesday" — test during volatile periods too. (c) "never testing the rollback" — rolling back is harder than failing forward; test rollback in every drill. (d) "testing only one component" — a full end-to-end test catches integration failures that component tests miss. (e) "the golden server" — one server gets all the attention and config tweaks; the rest of the fleet is not representative. Rotate which servers are tested

## Staff+ Perspective

> **Staff+ Perspective**: The quarterly DR drill is the most hated but most valuable ritual at the firm. In Q2 2024, during our scheduled failover drill, we discovered that a recent change to the feed handler configuration broke the backup's ability to parse an exchange's SBE schema update. The backup had been silently failing for 3 days — the monitoring was alerting on the primary (which was fine) but nobody checked the backup. If a real failover had occurred, we would have been blind to that venue's data for the 5 minutes it took to fix the config. The drill saved us. For BGP convergence: we tuned our ExaBGP to 1s keepalive / 3s hold timers and achieved 800ms convergence. But during a real incident, a switch firmware bug caused BGP to take 30 seconds to converge (the switch's control plane was overloaded). We now run "BGP convergence probes" from multiple vantage points after every failover to measure actual convergence. For cross-colo failover: our active-active architecture has a subtle edge case — if primary colo loses power gradually (brownout), servers may produce incorrect timestamps or corrupt state before failing. The backup sees a partial state replication, and after failover, the backup's state may be inconsistent. Mitigation: the backup checks the primary's replication lag and if lag > 100ms, it does NOT fail over (it waits and re-evaluates). This prevents failover to a stale backup.

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
