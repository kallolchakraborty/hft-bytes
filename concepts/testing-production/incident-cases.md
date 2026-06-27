---
type: reference
title: "Incident Cases"
description: "Knight Capital 2012: broken deployment — 8 servers got old code, no. 2010 Flash Crash: stub quotes at $0.0001 triggered liquidity collapse;"
tags: ["deployment"]
timestamp: "2026-06-27T03:06:09.453Z"
phase: 15
phaseName: "Testing & Production"
category: "Phase 15 - Testing & Production"
subcategory: "testing-production"
language: "cpp"
artifact-id: "ZHFT_INCIDENT_CASES"
---
## Key Learning Points

- Knight Capital 2012: broken deployment — 8 servers got old code, no
- 2010 Flash Crash: stub quotes at $0.0001 triggered liquidity collapse;
- Fat-finger prevention: exchange-level (price/circuit breakers, message
- Exchange outage recovery: when exchange goes down mid-day, you freeze
- Postmortem culture: blameless, action-oriented, with metrics and timelines

## Source Code

```cpp
#include <algorithm>
#include <array>
#include <cstdint>
#include <ctime>
#include <iomanip>
#include <map>
#include <optional>
#include <sstream>
#include <string>
#include <vector>

// ---------------------------------------------------------------------------
// Incident timeline renderer — creates a visual timeline of events.
// ---------------------------------------------------------------------------
struct IncidentEvent {
  uint64_t     time_offset_ms;  // From start of incident.
  std::string  description;
  std::string  severity;        // "info", "warning", "critical", "resolved"
};

struct Incident {
  std::string  name;            // "Knight Capital 2012"
  std::string  date;            // "2012-08-01"
  uint64_t     duration_ms;     // Total incident duration.
  std::string  root_cause;
  std::string  impact;          // "$460M loss"
  std::string  prevention;
  std::vector<IncidentEvent> timeline;
};

class IncidentTimelineRenderer {
public:
  // Renders timeline as ASCII art.
  std::string render(const Incident &inc) {
    std::ostringstream out;
    out << "=== " << inc.name << " (" << inc.date << ") ===" << "\n";
    out << "Root cause: " << inc.root_cause << "\n";
    out << "Impact: " << inc.impact << "\n";
    out << "Prevention: " << inc.prevention << "\n\n";
    out << "Timeline:\n";

    auto now = 0;
    for (const auto &ev : inc.timeline) {
      auto sec = ev.time_offset_ms / 1000;
      auto min = sec / 60;
      auto s   = sec % 60;
      out << "  T+" << std::setw(2) << min << "m"
          << std::setw(2) << s << "s [" << ev.severity << "] "
          << ev.description << "\n";
    }
    return out.str();
  }
};

// ---------------------------------------------------------------------------
// Incident definitions.
// ---------------------------------------------------------------------------
namespace Incidents {

inline Incident knightCapital2012() {
  return {
      .name       = "Knight Capital 2012",
      .date       = "2012-08-01",
      .duration_ms = 45 * 60 * 1000,
      .root_cause = "Deployment script skipped 8/20 servers; old Power Peg code "
                    "sent 4M orders in 45 min",
      .impact     = "$460M loss; company acquired within days",
      .prevention = "Canary deploys, staged rollouts, automated deploy validation, "
                    "kill switch on order rate",
      .timeline   = {
          {0, "Deployment begins — new SMARS code", "info"},
          {1000, "8 servers not updated — old Power Peg code active", "critical"},
          {180000, "4M orders executed; $460M loss accrued", "critical"},
          {2700000, "Knight operations team kills the process", "resolved"},
      },
  };
}

inline Incident flashCrash2010() {
  return {
      .name       = "2010 Flash Crash",
      .date       = "2010-05-06",
      .duration_ms = 36 * 60 * 1000,
      .root_cause = "Stub quotes at $0.0001 triggered liquidity collapse; HFT firms "
                    "pulled liquidity simultaneously",
      .impact     = "Dow Jones dropped 9% (~$1T) in 5 min; recovered in 36 min",
      .prevention = "Limit Up-Limit Down (LULD) circuit breakers; stub quote ban; "
                    "market-wide circuit breakers",
      .timeline   = {
          {0, "Unusual selling pressure in E-Mini S&P 500", "warning"},
          {300000, "Liquidity collapses — stub quotes trigger", "critical"},
          {360000, "Dow drops 998 points (9%)", "critical"},
          {600000, "Buying pressure returns", "warning"},
          {2160000, "Market fully recovered", "resolved"},
      },
  };
}

}; // namespace Incidents

// ---------------------------------------------------------------------------
// Postmortem template generator.
// ---------------------------------------------------------------------------
class PostmortemGenerator {
public:
  struct Postmortem {
    std::string title;
    std::string date;
    std::string summary;
    std::string timeline;
    std::string root_cause;
    std::string impact;
    std::string action_items;
    std::string appendix;
  };

  Postmortem generate(const Incident &inc,
                      const std::vector<std::string> &action_items) {
    Postmortem pm;
    pm.title       = "Postmortem: " + inc.name;
    pm.date        = inc.date;
    pm.summary     = "What happened: " + inc.impact + " from " + inc.root_cause;
    pm.timeline    = IncidentTimelineRenderer().render(inc);
    pm.root_cause  = inc.root_cause;
    pm.impact      = inc.impact;
    pm.appendix    = "Duration: " + std::to_string(inc.duration_ms / 60000) + " min";

    std::string ai;
    for (size_t i = 0; i < action_items.size(); ++i) {
      ai += std::to_string(i + 1) + ". [ ] " + action_items[i] + "\n";
    }
    pm.action_items = ai;

    return pm;
  }
};
```
