---
type: reference
title: "Cabling Physics"
description: "Fiber types: OS2 (single-mode, 9/125 µm) for long-haul (>500 m),. DAC (Direct Attach Copper) vs AOC (Active Optical Cable) vs"
tags: ["phase-6"]
difficulty: intermediate
timestamp: "2026-06-27T03:06:09.418Z"
phase: 6
phaseName: "Network Hardware"
category: "Phase 6 - Network Hardware"
subcategory: "network-hardware"
language: "cpp"
artifact-id: "ZHFT_CABLING_PHYSICS"
---
## Key Learning Points

- Fiber types: OS2 (single-mode, 9/125 µm) for long-haul (>500 m),
- DAC (Direct Attach Copper) vs AOC (Active Optical Cable) vs
- LC vs MPO connectors: LC (duplex) is standard for single-channel
- Latency per meter: electrical signals in copper travel at
- Signal attenuation: OM3/OM4 at 850 nm: ~2.5-3.5 dB/km. OS2 at
- Modal dispersion in multi-mode fiber limits reach at high data

## Usage

// g++ -O3 -std=c++20 ZHFT_CABLING_PHYSICS.txt -o cable_calc
// ./cable_calc

## Source Code

```cpp
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <iostream>
#include <map>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

// ====================================================================
// Cable types and their properties.
// ====================================================================
enum class CableType {
    DAC,                // Direct Attach Copper (passive)
    AOC,                // Active Optical Cable
    SR_MMF,             // Short-reach multi-mode (OM3/OM4 transceiver)
    LR_SMF,             // Long-reach single-mode (OS2 transceiver)
    FR_SMF,             // 400G-FR4 single-mode
};

struct CableSpec {
    const char* name;
    double      latency_ns_per_m;        // propagation delay
    double      max_length_m;             // reach at 100 Gbps (typical)
    double      cost_per_m;               // USD/m (approx, 2026)
    double      connector_loss_db;        // per connection
    double      attenuation_db_per_km;    // signal loss
    double      fixed_electronics_ns;     // active electronics latency (AOC/optics)
};

static const std::map<CableType, CableSpec> kCableSpecs = {
    {CableType::DAC,     {"DAC (passive copper)",    5.0,   7,    5.00,  0.0, 0.0, 0.0}},
    {CableType::AOC,     {"AOC (active optical)",     5.0, 100,   15.00,  0.0, 0.0, 100.0}},
    {CableType::SR_MMF,  {"SR (OM4 multi-mode)",      5.0, 150,    0.50,  0.3, 2.5, 50.0}},
    {CableType::LR_SMF,  {"LR (OS2 single-mode)",     5.0, 10000,  0.30,  0.2, 0.4, 50.0}},
    {CableType::FR_SMF,  {"FR4 (400G single-mode)",   5.0, 2000,   2.00,  0.2, 0.4, 75.0}},
};

// ====================================================================
// Cable latency & cost calculator.
// ====================================================================
struct CableResult {
    CableType       type;
    double          length_m;
    double          propagation_ns;
    double          electronics_ns;
    double          total_latency_ns;
    double          total_cost;
    double          link_loss_db;
    bool            within_reach;
    double          margin_m;
};

auto CalculateCable(CableType type, double length_m, int connector_pairs = 2)
    -> CableResult
{
    auto it = kCableSpecs.find(type);
    if (it == kCableSpecs.end()) return {};

    const auto& spec = it->second;
    double prop_ns    = spec.latency_ns_per_m * length_m;
    double elec_ns    = spec.fixed_electronics_ns;
    double total_ns   = prop_ns + elec_ns;
    double cost       = (spec.cost_per_m * length_m) +
                        (connector_pairs * 5.0);     // $5/connector
    double loss       = (length_m / 1000.0) * spec.attenuation_db_per_km +
                        (connector_pairs * spec.connector_loss_db);
    bool reachable    = length_m <= spec.max_length_m;
    double margin     = spec.max_length_m - length_m;

    return {type, length_m, prop_ns, elec_ns, total_ns, cost, loss,
            reachable, margin};
}

// ====================================================================
// Interconnect cost estimator: compare multiple options for a link.
// ====================================================================
struct LinkRequirement {
    double distance_m;
    double bandwidth_gbps;
    int    num_channels;
};

void EstimateInterconnect(const LinkRequirement& req) {
    std::cout << "\n--- Link Analysis ---\n";
    std::cout << "Distance: " << req.distance_m << " m\n";
    std::cout << "Bandwidth: " << req.bandwidth_gbps << " Gbps\n";
    std::cout << "Channels: " << req.num_channels << "\n\n";

    std::cout << "Option        Length  Latency   Cost     Loss   Reachable?\n";
    std::cout << "----------------------------------------------------------\n";

    for (auto [type, spec] : kCableSpecs) {
        if (type == CableType::FR_SMF && req.bandwidth_gbps < 400) continue;
        // Skip LR if distance < 500m (SR is cheaper).
        if (type == CableType::LR_SMF && req.distance_m < 500) continue;

        auto r = CalculateCable(type, req.distance_m);
        if (r.within_reach || (type == CableType::LR_SMF)) {
            std::printf("%-12s %4.0f m  %5.0f ns  $%6.0f  %4.1f dB  %s\n",
                        spec.name, r.length_m, r.total_latency_ns,
                        r.total_cost * req.num_channels,
                        r.link_loss_db,
                        r.within_reach ? "Yes" : "No (too far)");
        }
    }
}

// ====================================================================
// Latency per distance comparison.
// ====================================================================
void PrintLatencyByDistance() {
    std::cout << "\n--- Latency vs Distance (per 10 m) ---\n";
    std::cout << "Cable       10 m     50 m     100 m    1 km    10 km\n";
    std::cout << "-----------------------------------------------------\n";

    for (auto [type, spec] : kCableSpecs) {
        if (type == CableType::FR_SMF) continue;
        std::printf("%-12s", spec.name);
        for (double dist : {10.0, 50.0, 100.0, 1000.0, 10000.0}) {
            auto r = CalculateCable(type, dist);
            if (r.total_latency_ns < 10000) {
                std::printf("%5.0f ns  ", r.total_latency_ns);
            } else {
                std::printf("%5.1f µs ", r.total_latency_ns / 1000.0);
            }
        }
        std::cout << "\n";
    }
}

// ====================================================================
// Main.
// ====================================================================
auto main() -> int {
    std::cout << "=== Cabling & Physics Calculator ===\n";

    // Typical HFT scenarios.
    EstimateInterconnect({3, 100, 2});       // intra-rack
    EstimateInterconnect({50, 100, 4});      // intra-row
    EstimateInterconnect({300, 100, 8});     // cross-DC hall

    PrintLatencyByDistance();

    std::cout << "\n=== Rules of Thumb ===\n";
    std::cout << "1. ≤5 m:   DAC (cheapest, lowest latency)\n";
    std::cout << "2. 5-30 m: AOC (lightweight, longer reach)\n";
    std::cout << "3. 30-150 m: OM4 SR optics\n";
    std::cout << "4. >150 m:  OS2 LR optics\n";
    std::cout << "5. Every connector adds 0.15-0.5 dB loss\n";
    std::cout << "6. Fiber latency: ~5 ns/m (not substantially faster\n";
    std::cout << "   than copper, but can go much further)\n";
    std::cout << "7. For sub-µs latency, minimize optical conversions\n";

    return 0;
}
```
