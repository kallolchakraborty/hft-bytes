---
type: playbook
title: "Split Brain"
description: "Network partition between two redundant trading instances causes both. Detection: heartbeat timeout + witness node (observer) that can see both"
tags: ["dark-pools"]
timestamp: "2026-06-27T03:06:09.461Z"
phase: 17
phaseName: "Production Failure Modes"
category: "Phase 17 - Production Failure Modes"
subcategory: "failure-modes"
language: "cpp"
artifact-id: "ZHFT_SPLIT_BRAIN"
---
## Key Learning Points

- Network partition between two redundant trading instances causes both
- Detection: heartbeat timeout + witness node (observer) that can see both
- Fencing (STONITH): Shoot The Other Node In The Head — the surviving node
- State reconciliation on rejoin: after partition heals, the two nodes must

## Source Code

```cpp
#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <cstdlib>
#include <map>
#include <optional>
#include <set>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

// ---------------------------------------------------------------------------
// Split-brain detector — heartbeat-based with witness voting.
// ---------------------------------------------------------------------------
class SplitBrainDetector {
  // Each node has a unique ID.
  uint32_t node_id_;
  // Witness node ID (0 = no witness).
  uint32_t witness_id_;
  // Monotonic epoch counter.
  std::atomic<uint64_t> current_epoch_{1};

  // Heartbeat timing.
  std::chrono::steady_clock::time_point last_heartbeat_;
  uint64_t heartbeat_timeout_ms_ = 1000;

  // Peer status.
  enum class PeerStatus { Unknown, Alive, Dead };
  std::atomic<PeerStatus> peer_status_{PeerStatus::Unknown};

public:
  SplitBrainDetector(uint32_t node_id, uint32_t witness_id = 0)
      : node_id_(node_id), witness_id_(witness_id) {}

  // Called by the heartbeat receiver thread.
  void heartbeat_received(uint32_t from_node_id) {
    last_heartbeat_ = std::chrono::steady_clock::now();
    peer_status_.store(PeerStatus::Alive, std::memory_order_release);
  }

  // Called periodically by the health check loop.
  enum class BrainState {
    SingleLeader,   // No split — normal operation.
    SplitBrain,     // Both nodes claim primary.
    Fencing,        // We are initiating fencing of the other node.
    Reconciling,    // Partition healed; reconciling state.
  };

  BrainState check() {
    auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
                       std::chrono::steady_clock::now() - last_heartbeat_)
                       .count();

    if (elapsed > heartbeat_timeout_ms_) {
      PeerStatus expected = PeerStatus::Alive;
      if (peer_status_.compare_exchange_strong(expected, PeerStatus::Dead)) {
        // Transition: peer just became dead.
        // Check if we should become primary.
        if (should_become_primary()) {
          return BrainState::Fencing;
        }
      }
    }

    return BrainState::SingleLeader;
  }

  // Determine if this node should become the leader.
  bool should_become_primary() const {
    if (witness_id_ == 0) {
      // No witness: lower node ID wins.
      return node_id_ < 100; // Simplified: "if peer is dead, I win".
    }
    // In production: contact witness node, ask for quorum.
    return true;
  }

  uint64_t current_epoch() const { return current_epoch_.load(); }
  void     advance_epoch() { current_epoch_.fetch_add(1); }
};

// ---------------------------------------------------------------------------
// Fencing mechanism (STONITH).
// ---------------------------------------------------------------------------
class FencingMechanism {
  uint32_t this_node_id_;
  uint32_t peer_node_id_;

public:
  enum class FenceResult {
    Success,        // Peer is confirmed dead.
    Failed,         // Could not reach peer's power mgmt.
    Timeout,        // Took too long.
  };

  FenceResult fence_peer() {
    // Method 1: BGP session teardown — remove peer's route announcements.
    std::system(("birdc withdraw " + std::to_string(peer_node_id_) + " routes").c_str());

    // Method 2: PDU power off.
    std::system(("pductrl --host 10.0." + std::to_string(peer_node_id_) +
                 ".1 --outlet 1 --off").c_str());

    // Method 3: IPMI chassis power off.
    std::system(("ipmitool -H mgmt" + std::to_string(peer_node_id_) +
                 " -U admin chassis power off").c_str());

    // Verify peer is dead via network ping / health check.
    // If still alive after 500ms, escalate.
    std::this_thread::sleep_for(std::chrono::milliseconds(500));

    return FenceResult::Success;
  }
};

// ---------------------------------------------------------------------------
// State reconciliation on rejoin — after partition heals.
// ---------------------------------------------------------------------------
class StateReconciliation {
  // Each node maintains a vector clock — a map from node_id → sequence.
  std::map<uint32_t, uint64_t> vector_clock_;

public:
  struct OrderDelta {
    uint64_t    order_id;
    std::string field;
    std::string value_a;
    std::string value_b;
  };

  // Compare two vector clocks to determine which node has the latest state
  // for each order.
  std::vector<OrderDelta> reconcile(
      const std::map<uint64_t, std::string> &state_a,
      const std::map<uint64_t, std::string> &state_b) {
    std::vector<OrderDelta> deltas;

    // Find orders in A not in B, or different.
    for (const auto &[oid, status_a] : state_a) {
      auto it = state_b.find(oid);
      if (it == state_b.end()) {
        deltas.push_back({oid, "status", status_a, "(missing)"});
      } else if (status_a != it->second) {
        deltas.push_back({oid, "status", status_a, it->second});
      }
    }

    // Orders in B not in A.
    for (const auto &[oid, status_b] : state_b) {
      if (state_a.find(oid) == state_a.end()) {
        deltas.push_back({oid, "status", "(missing)", status_b});
      }
    }

    return deltas;
  }

  // Merge decision: authority order by node ID, then by timestamp.
  // Actually, for trading systems, the safest approach is to CANCEL everything
  // on rejoin and re-sync from the exchange.
  void resolve_and_cancel(const std::vector<OrderDelta> &deltas) {
    // In production: send cancel for every order in the delta set.
    for (const auto &d : deltas) {
      // cancel_order(d.order_id);
    }
  }
};
```
