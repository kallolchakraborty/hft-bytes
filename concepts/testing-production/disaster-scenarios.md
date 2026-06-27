---
type: reference
title: "Disaster Scenarios"
description: "Colo power outage: UPS provides 5-15 min window; generator must auto-start. Exchange mid-day outage: freeze all positions, stop trading, wait for"
tags: ["phase-15"]
timestamp: "2026-06-27T03:06:09.452Z"
phase: 15
phaseName: "Testing & Production"
category: "Phase 15 - Testing & Production"
subcategory: "testing-production"
language: "cpp"
artifact-id: "ZHFT_DISASTER_SCENARIOS"
---
## Key Learning Points

- Colo power outage: UPS provides 5-15 min window; generator must auto-start
- Exchange mid-day outage: freeze all positions, stop trading, wait for
- DDoS attack: network scrubbing centre (e.g., Cloudflare Magic Transit, Arbor)
- Counterparty default: CCP steps in (central counterparty); risk of portability
- Cross-connect cut: diverse fibre paths; automatic failover to secondary

## Source Code

```cpp
#include <algorithm>
#include <chrono>
#include <cstdint>
#include <ctime>
#include <functional>
#include <iomanip>
#include <iostream>
#include <map>
#include <optional>
#include <sstream>
#include <string>
#include <vector>

// ---------------------------------------------------------------------------
// Disaster scenario definition.
// ---------------------------------------------------------------------------
enum class DisasterType {
  ColoPowerOutage,
  ExchangeMidDayOutage,
  DDoS,
  CounterpartyDefault,
  CrossConnectCut,
  CoolingFailure,
  NetworkPartition,
};

struct DisasterScenario {
  DisasterType type;
  std::string  name;
  std::string  description;
  uint64_t     expected_recovery_time_s; // Target RTO in seconds.
  std::vector<std::string> playbook;     // Ordered steps.
};

// ---------------------------------------------------------------------------
// Disaster scenario simulator — walks through the playbook and verifies
// each step's preconditions and postconditions.
// ---------------------------------------------------------------------------
class DisasterSimulator {
  bool simulation_active_ = false;

public:
  struct SimulationStep {
    std::string action;
    bool   precondition_met;
    bool   postcondition_met;
    std::string notes;
  };

  std::vector<SimulationStep> simulate(const DisasterScenario &scenario) {
    simulation_active_ = true;
    std::vector<SimulationStep> steps;

    for (const auto &step : scenario.playbook) {
      bool pre_ok  = check_precondition(step);
      bool post_ok = false;

      if (pre_ok) {
        // Execute the step (in simulation, just verify the command exists).
        post_ok = verify_step(step);
      }

      steps.push_back({step, pre_ok, post_ok, pre_ok && post_ok ? "" : "FAIL"});

      if (!pre_ok || !post_ok) break;
    }

    simulation_active_ = false;
    return steps;
  }

private:
  bool check_precondition(const std::string &step) {
    // In production: check system state before applying the step.
    return true;
  }

  bool verify_step(const std::string &step) {
    // In production: execute the step in a sandbox and verify outcome.
    return true;
  }
};

// ---------------------------------------------------------------------------
// Predefined disaster scenarios.
// ---------------------------------------------------------------------------
namespace Scenarios {

inline DisasterScenario coloPowerOutage() {
  return {
      .type                    = DisasterType::ColoPowerOutage,
      .name                    = "Primary power failure in colo cage",
      .description             = "UPS A feed drops; UPS B is online; generator "
                                 "has 60s to auto-start",
      .expected_recovery_time_s = 30,
      .playbook = {
          "1. Verify UPS B is active and carrying load",
          "2. Start generator via remote PDU (if auto-start failed)",
          "3. If generator fails, initiate graceful shutdown of non-critical servers",
          "4. Keep trading engines on UPS until recovery or last 3min of runtime",
          "5. If runtime critical: migrate trading to standby site",
          "6. Log incident and notify colo facility manager",
      },
  };
}

inline DisasterScenario exchangeOutage() {
  return {
      .type                    = DisasterType::ExchangeMidDayOutage,
      .name                    = "Exchange mid-day trading halt",
      .description             = "Exchange issues trading halt; all orders frozen; "
                                 "no fills expected until resumption",
      .expected_recovery_time_s = 600,
      .playbook = {
          "1. Halt all new order entry to affected venue",
          "2. Mark positions as FROZEN — do not attempt to cancel or modify",
          "3. If venue failover available, redirect flow to alternate venue",
          "4. Subscribe to exchange status RSS/SNS feed for updates",
          "5. On exchange recovery: reconcile sequence numbers",
          "6. Resume trading only after manual verification of book state",
          "7. Generate incident report for clearing house",
      },
  };
}

inline DisasterScenario ddosAttack() {
  return {
      .type                    = DisasterType::DDoS,
      .name                    = "DDoS on trading network",
      .description             = "Volumetric attack saturates uplink; legitimate "
                                 "exchange traffic drops",
      .expected_recovery_time_s = 60,
      .playbook = {
          "1. Activate DDoS scrubbing (Cloudflare/Arbor) via API call",
          "2. Whitelist exchange IP ranges in iptables/nftables",
          "3. If scrubbing centre unavailable: BGP blackhole non-exchange traffic",
          "4. Monitor latency to exchange — if still elevated, fail over to backup ISP",
          "5. Notify exchange NOC of connectivity issue",
          "6. After attack subsides, remove scrubbing and verify normal latency",
      },
  };
}

} // namespace Scenarios
```
