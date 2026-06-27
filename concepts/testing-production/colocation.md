---
type: reference
title: "Colocation"
description: "Exchange proximity: CME Aurora/NY4 (NJ), Eurex Frankfurt — each additional. Cage vs cabinet: cage gives physical security+space; cabinet is cheaper"
tags: ["phase-15"]
timestamp: "2026-06-27T03:06:09.451Z"
phase: 15
phaseName: "Testing & Production"
category: "Phase 15 - Testing & Production"
subcategory: "testing-production"
language: "cpp"
artifact-id: "ZHFT_COLOCATION"
---
## Key Learning Points

- Exchange proximity: CME Aurora/NY4 (NJ), Eurex Frankfurt — each additional
- Cage vs cabinet: cage gives physical security+space; cabinet is cheaper
- Cross-connect vs exchange fabric: cross-connect is a dedicated fibre pair
- Power: redundant feeds (A+B), UPS for 5–15min ride-through, generator for
- Cooling: rear-door heat exchangers or in-row cooling for high-density
- Carrier diversity: at least 2 carriers (e.g., Zayo + Cologix) for WAN

## Source Code

```cpp
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <iomanip>
#include <map>
#include <optional>
#include <sstream>
#include <string>
#include <vector>

// ---------------------------------------------------------------------------
// Colo specification generator.
// ---------------------------------------------------------------------------
struct ColoRequirement {
  std::string venue_name;                 // "CME Aurora", "Eurex Frankfurt"
  std::string data_center;                // "NY4", "LD4", "FRA1"
  uint32_t    rack_units;                 // Total U required
  double      power_kw;                   // Estimated power consumption
  double      cooling_kw;                 // Cooling load
  bool        cage_required;              // True = cage, false = cabinet
  uint32_t    cross_connects;             // Number of fibre cross-connects
  uint32_t    carrier_diversity_count;    // Minimum carriers
};

struct ColoSpecSheet {
  std::string data_center;
  std::string rack_type;          // "42U Cabinet" or custom cage
  std::string power_config;       // "A+B Redundant, 30kW"
  std::string cooling_type;       // "Rear-door HX", "In-row DX"
  std::string fiber_providers;    // "Zayo, Cologix, Equinix"
  double      monthly_estimate_usd;
};

class ColoSpecGenerator {
public:
  ColoSpecSheet generate(const ColoRequirement &req) {
    ColoSpecSheet spec;

    // Determine cage vs cabinet.
    if (req.cage_required || req.rack_units > 42) {
      spec.rack_type = "Custom Cage (" + std::to_string(req.rack_units) + "U)";
    } else {
      spec.rack_type = "42U Standard Cabinet";
    }

    // Power configuration: how many feeds and total capacity.
    spec.power_config = "A+B Redundant, " + std::to_string(int(req.power_kw)) + "kW";

    // Cooling selection based on density.
    if (req.power_kw > 20) {
      spec.cooling_type = "Rear-door Heat Exchanger";
    } else if (req.power_kw > 10) {
      spec.cooling_type = "In-row DX Cooling";
    } else {
      spec.cooling_type = "Raised-floor CRAC";
    }

    // Fibre providers — pick from available list for the venue.
    spec.fiber_providers = "Zayo, Cologix";

    // Monthly estimate — rough industry figures.
    double base  = 1500.0;                    // Cabinet base
    double power = req.power_kw * 200.0;      // $200/kW
    double cross = req.cross_connects * 500.0; // $500 per cross-connect
    double cage  = req.cage_required ? 3000.0 : 0.0;
    spec.monthly_estimate_usd = base + power + cross + cage;

    return spec;
  }
};

// ---------------------------------------------------------------------------
// Power and cooling budget calculator.
// ---------------------------------------------------------------------------
class PowerBudgetCalculator {
public:
  struct Budget {
    double it_load_kw;          // Servers + switches + storage
    double cooling_load_kw;     // CRAC / in-row / rear-door
    double ups_loss_kw;         // Inefficiency (typ 5-10%)
    double total_kw;
    double monthly_kwh;
    double monthly_cost_usd;
  };

  Budget calculate(uint32_t server_count, double watts_per_server,
                   double watts_per_switch, uint32_t switch_count,
                   double pue,          // Power Usage Effectiveness (e.g., 1.4)
                   double cost_per_kwh) const {
    double it_load_kw   = (server_count * watts_per_server +
                          switch_count * watts_per_switch) / 1000.0;
    double total_kw     = it_load_kw * pue;
    double monthly_kwh  = total_kw * 24 * 30;
    double monthly_cost = monthly_kwh * cost_per_kwh;

    return {.it_load_kw      = it_load_kw,
            .cooling_load_kw = it_load_kw * (pue - 1.0),
            .ups_loss_kw     = it_load_kw * 0.05,
            .total_kw        = total_kw,
            .monthly_kwh     = monthly_kwh,
            .monthly_cost_usd = monthly_cost};
  }
};

// ---------------------------------------------------------------------------
// Latency distance estimator — fibre distance to venue.
// ---------------------------------------------------------------------------
class LatencyDistanceEstimator {
  // Speed of light in fibre ≈ 2/3 c ≈ 200,000 km/s → 5µs per km round-trip.
  static constexpr double kNsPerKm = 5000.0; // Round-trip nanoseconds per km.

public:
  struct Estimate {
    double distance_km;
    double round_trip_ns;
    double one_way_ns;
  };

  Estimate estimate(const std::string &from_dc, const std::string &to_venue) {
    // Map of known distances (km). In practice, use fibre path distance, not
    // great-circle.
    std::map<std::pair<std::string, std::string>, double> known = {
        {{"NY4", "CME-NY"}, 0.1},      // Same campus
        {{"NY4", "NASDAQ-NJ"}, 5.0},
        {{"LD4", "LSE"}, 1.5},
        {{"FRA1", "EUREX"}, 0.5},
    };

    auto it = known.find({from_dc, to_venue});
    double dist_km = (it != known.end()) ? it->second : 50.0; // Default 50km.
    double rtt_ns  = dist_km * kNsPerKm;

    return {.distance_km  = dist_km,
            .round_trip_ns = rtt_ns,
            .one_way_ns   = rtt_ns / 2.0};
  }
};
```
