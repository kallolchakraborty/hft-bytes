---
type: reference
title: "Operations"
description: "Start-of-day (SOD): exchange login → market data verification → position. End-of-day (EOD): position dump → P&L report → trade log archive → risk"
tags: ["phase-15"]
difficulty: intermediate
timestamp: "2026-06-27T03:06:09.454Z"
phase: 15
phaseName: "Testing & Production"
category: "Phase 15 - Testing & Production"
subcategory: "testing-production"
language: "cpp"
artifact-id: "ZHFT_OPERATIONS"
---
## Key Learning Points

- Start-of-day (SOD): exchange login → market data verification → position
- End-of-day (EOD): position dump → P&L report → trade log archive → risk
- Shift handover: checklist of pending orders, open issues, P&L status,
- On-call escalation: tier-1 (ops) → tier-2 (dev) → tier-3 (vendor/exchange)
- Backup/restore: configuration backup (git), log backup (S3/Glacier),
- Postmortem culture: blameless, automated timeline, action tracking

## Source Code

```cpp
#include <algorithm>
#include <chrono>
#include <cstdint>
#include <ctime>
#include <filesystem>
#include <fstream>
#include <functional>
#include <iomanip>
#include <map>
#include <optional>
#include <set>
#include <sstream>
#include <string>
#include <vector>

// ---------------------------------------------------------------------------
// Runbook automation engine — executes procedural steps and verifies outcomes.
// ---------------------------------------------------------------------------
struct RunbookStep {
  std::string id;
  std::string description;
  std::string command;             // Shell command to execute.
  std::string expected_output;     // Substring to verify.
  uint32_t    timeout_seconds;
  bool        critical;            // If fails, stop the runbook.
};

struct Runbook {
  std::string name;
  std::string phase;  // "sod", "eod", "handover", "incident"
  std::vector<RunbookStep> steps;
};

class RunbookEngine {
public:
  struct StepResult {
    bool   success;
    std::string output;
    std::string error;
    uint64_t duration_ms;
  };

  std::vector<StepResult> execute(const Runbook &rb) {
    std::vector<StepResult> results;
    for (const auto &step : rb.steps) {
      auto start = std::chrono::steady_clock::now();

      // Execute the command.
      std::array<char, 1024> buffer;
      std::string output;
      FILE *pipe = popen(step.command.c_str(), "r");
      if (!pipe) {
        results.push_back({false, "", "pipe failed", 0});
        if (step.critical) break;
        continue;
      }
      while (fgets(buffer.data(), buffer.size(), pipe) != nullptr) {
        output += buffer.data();
      }
      int rc = pclose(pipe);

      auto end  = std::chrono::steady_clock::now();
      auto dur  = std::chrono::duration_cast<std::chrono::milliseconds>(end - start).count();

      bool pass = (rc == 0) &&
                  output.find(step.expected_output) != std::string::npos;

      results.push_back({pass, output, rc != 0 ? "Exit code: " + std::to_string(rc) : "", dur});

      if (!pass && step.critical) break;
    }
    return results;
  }
};

// ---------------------------------------------------------------------------
// SOD/EOD checklist validator — verifies that all steps completed.
// ---------------------------------------------------------------------------
class ChecklistValidator {
  std::set<std::string> completed_;

public:
  void mark_complete(const std::string &step_id) {
    completed_.insert(step_id);
  }

  struct ValidationReport {
    bool all_complete;
    std::vector<std::string> missing;
  };

  ValidationReport validate(const Runbook &rb) const {
    ValidationReport report{true, {}};
    for (const auto &step : rb.steps) {
      if (completed_.find(step.id) == completed_.end()) {
        report.all_complete = false;
        report.missing.push_back(step.id);
      }
    }
    return report;
  }
};

// ---------------------------------------------------------------------------
// SOD Runbook definition.
// ---------------------------------------------------------------------------
namespace Runbooks {

inline Runbook sodRunbook() {
  return {
      .name  = "Start-of-Day Procedures",
      .phase = "sod",
      .steps = {
        {"SOD-01", "Login to exchange gateways",
         "ssh trading@gateway 'systemctl status fix-session'", "active (running)", 10, true},
        {"SOD-02", "Verify market data feed connectivity",
         "ssh trading@feed 'systemctl status feed-handler'", "active (running)", 10, true},
        {"SOD-03", "Align PTP clock (RTS 25 compliance)",
         "chronyc sources -v", "^*", 5, true},
        {"SOD-04", "Position reconciliation vs clearing house",
         "python3 reconcile_positions.py", "PASS", 30, true},
        {"SOD-05", "Risk limits check",
         "python3 check_risk_limits.py", "within limits", 10, false},
        {"SOD-06", "Enable trading",
         "touch /tmp/trading_enabled && redis-cli SET trading:enabled 1", "OK", 5, true},
      },
  };
}

inline Runbook eodRunbook() {
  return {
      .name  = "End-of-Day Procedures",
      .phase = "eod",
      .steps = {
        {"EOD-01", "Disable new order entry",
         "redis-cli SET trading:enabled 0", "OK", 5, true},
        {"EOD-02", "Drain pending orders",
         "python3 cancel_all_orders.py", "All orders cancelled", 60, true},
        {"EOD-03", "Dump positions",
         "python3 dump_positions.py --output /data/eod/positions_$(date +%Y%m%d).csv",
         "written", 30, true},
        {"EOD-04", "Generate P&L report",
         "python3 pnl_report.py --date $(date +%Y-%m-%d)", "PNL:", 30, false},
        {"EOD-05", "Archive trade logs",
         "tar czf /data/archive/logs_$(date +%Y%m%d).tar.gz /var/log/trading/",
         "tar:", 120, false},
      },
  };
}

} // namespace Runbooks
```
