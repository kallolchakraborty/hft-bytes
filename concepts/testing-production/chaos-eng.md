---
type: reference
title: "Chaos Eng"
description: "Network latency injection (tc netem) simulates WAN jitter and congestion. Process kill testing verifies the watchdog/restart loop works"
tags: ["testing"]
timestamp: "2026-06-27T03:06:09.451Z"
phase: 15
phaseName: "Testing & Production"
category: "Phase 15 - Testing & Production"
subcategory: "testing-production"
language: "cpp"
artifact-id: "ZHFT_CHAOS_ENG"
---
## Key Learning Points

- Network latency injection (tc netem) simulates WAN jitter and congestion
- Process kill testing verifies the watchdog/restart loop works
- Exchange disconnection simulation tests reconnection and state recovery
- Market data feed loss verifies feed failover and gap detection
- CPU throttling and memory pressure test circuit breakers and OOM handling

## Source Code

```cpp
#include <array>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <cstdlib>
#include <ctime>
#include <filesystem>
#include <fstream>
#include <functional>
#include <iostream>
#include <map>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

// ---------------------------------------------------------------------------
// Chaos experiment definition.
// ---------------------------------------------------------------------------
// Each experiment targets a specific fault injection on a named resource.
// ---------------------------------------------------------------------------
enum class FaultType {
  NetworkLatency,        // Add latency to a network interface
  NetworkPacketLoss,     // Drop a fraction of packets
  ProcessKill,           // Send SIGKILL to a process
  ExchangeDisconnect,    // Drop TCP connection to exchange
  FeedLoss,              // Stop market data feed for N seconds
  CpuThrottle,           // Pin CPU to low frequency or steal cycles
  MemoryPressure,        // Allocate memory to trigger OOM
  DiskLatency,           // Add latency to disk I/O
  ClockSkew,             // Introduce clock skew (NTP tamper)
};

struct ChaosExperiment {
  std::string name;
  FaultType   fault;
  std::string target;     // e.g., "eth0", "trading-engine", "exchange-1"
  uint32_t    duration_ms; // How long the fault is applied.
  std::map<std::string, std::string> params; // Fault-specific parameters.

  // Hypothesis: what should happen? "System continues trading within p99 < 1ms"
  std::string hypothesis;
};

// ---------------------------------------------------------------------------
// Chaos execution harness — applies and rolls back faults safely.
// ---------------------------------------------------------------------------
class ChaosHarness {
  // Guard: prevent accidental execution on production.
  bool safe_mode_ = true;
  std::vector<ChaosExperiment> experiments_;

public:
  ChaosHarness() {
    // Check for "CHAOS_MODE=1" env var to disable safe mode.
    safe_mode_ = (std::getenv("CHAOS_MODE") == nullptr);
  }

  void register_experiment(const ChaosExperiment &exp) {
    experiments_.push_back(exp);
  }

  struct ExperimentResult {
    bool   success;
    std::string output;
    std::string rollback_status;
  };

  // Run a single experiment with rollback on failure or timeout.
  ExperimentResult run(const ChaosExperiment &exp) {
    if (safe_mode_) {
      return {false, "SAFE_MODE: set CHAOS_MODE=1 to enable", ""};
    }

    // 1. Apply fault.
    std::string apply_cmd = build_apply_command(exp);
    int apply_rc          = std::system(apply_cmd.c_str());

    if (apply_rc != 0) {
      return {false, "Failed to apply fault: " + apply_cmd, ""};
    }

    // 2. Wait for the experiment duration.
    std::this_thread::sleep_for(std::chrono::milliseconds(exp.duration_ms));

    // 3. Rollback fault.
    std::string rollback_cmd = build_rollback_command(exp);
    int rollback_rc          = std::system(rollback_cmd.c_str());

    // 4. Verify system health after rollback.
    bool healthy = verify_system_health();

    return {healthy, "Applied: " + apply_cmd,
            rollback_rc == 0 ? "Rollback OK" : "Rollback FAILED"};
  }

  // Run all registered experiments in sequence.
  std::vector<ExperimentResult> run_all() {
    std::vector<ExperimentResult> results;
    for (const auto &exp : experiments_) {
      std::cout << "=== Running: " << exp.name << " ===" << std::endl;
      results.push_back(run(exp));
    }
    return results;
  }

private:
  std::string build_apply_command(const ChaosExperiment &exp) {
    switch (exp.fault) {
    case FaultType::NetworkLatency: {
      auto it = exp.params.find("latency_ms");
      if (it == exp.params.end()) throw std::invalid_argument("Missing latency_ms");
      return "tc qdisc add dev " + exp.target +
             " root netem delay " + it->second + "ms";
    }
    case FaultType::ProcessKill:
      return "kill -9 $(pgrep " + exp.target + ")";
    case FaultType::NetworkPacketLoss: {
      auto it = exp.params.find("loss_percent");
      if (it == exp.params.end()) throw std::invalid_argument("Missing loss_percent");
      return "tc qdisc add dev " + exp.target +
             " root netem loss " + it->second + "%";
    }
    case FaultType::CpuThrottle:
      return "cpulimit -l 50 -e " + exp.target + " &"; // 50% limit.
    default:
      return "echo 'No apply command for fault type'";
    }
  }

  std::string build_rollback_command(const ChaosExperiment &exp) {
    switch (exp.fault) {
    case FaultType::NetworkLatency:
    case FaultType::NetworkPacketLoss:
      return "tc qdisc del dev " + exp.target + " root";
    case FaultType::CpuThrottle:
      return "pkill cpulimit";
    default:
      return "echo 'No rollback needed'";
    }
  }

  bool verify_system_health() {
    // In production: check heartbeat, latency, order flow.
    return true;
  }
};

// ---------------------------------------------------------------------------
// Predefined chaos experiments for HFT.
// ---------------------------------------------------------------------------
namespace Experiments {

constexpr ChaosExperiment kFeedDisconnect = {
    .name        = "feed-a-disconnect",
    .fault       = FaultType::FeedLoss,
    .target      = "feed-handler-a",
    .duration_ms = 5000,
    .params      = {{"feed", "A"}},
    .hypothesis  = "Feed B takes over within 1s; no book corruption",
};

constexpr ChaosExperiment kNetworkJitter = {
    .name        = "exchange-latency-spike",
    .fault       = FaultType::NetworkLatency,
    .target      = "eth0",
    .duration_ms = 30000,
    .params      = {{"latency_ms", "50"}}, // 50ms extra latency
    .hypothesis  = "Orders still go through; p99 stays under 2ms",
};

constexpr ChaosExperiment kOrderEngineKill = {
    .name        = "order-engine-kill",
    .fault       = FaultType::ProcessKill,
    .target      = "trading-engine",
    .duration_ms = 10000,
    .params      = {},
    .hypothesis  = "Watchdog restarts engine within 500ms; no order loss",
};

} // namespace Experiments
```
