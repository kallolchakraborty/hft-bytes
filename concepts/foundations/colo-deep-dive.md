---
type: reference
title: "Co-Location Deep Dive"
description: "Exchange-specific colocation halls, fiber path optimization, cross-connect pricing, cage selection vs matching engine location, microwave vs fiber, exchange colo RFP process, and multi-exchange colo strategy."
tags: ["infrastructure"]
difficulty: staff
timestamp: "2026-06-27T03:20:00.000Z"
phase: 1
phaseName: "Foundations"
category: "Foundations"
subcategory: "foundations"
language: "cpp"
artifact-id: "ZHFT_COLO_DEEP_DIVE"
---
## Key Learning Points

- Exchange colo facilities: CME uses Equinix NY4/NY5 and Cermak (IL), Nasdaq uses NY11/Equinix NY4, Eurex uses Equinix FR2 (Frankfurt), ICE uses Equinix NY4 and LD4 (London)
- Cage positioning: distance to exchange matching engine cabinet determines fiber length; each meter of fiber adds ~5 ns one-way latency; choose cages on the same row/aisle as the exchange rack
- Cross-connect pricing: $500-2000/month per 10G/100G cross-connect; a typical firm has 4-8 cross-connects per exchange (primary A, primary B, backup A, backup B, admin)
- Fiber path: never use the exchange-provided patch panel if you can run direct fiber; each patch panel adds 1-3 us latency; use single-mode LC-LC direct fiber runs
- Microwave vs fiber: microwave (1-2 us/mile) beats fiber (8 us/mile) for long distances (> 20 miles); fiber at speed of light in glass ~5 us/km vs microwave ~3.3 us/km (air)
- Multi-exchange strategy: if trading CME + ICE + Nasdaq, choose a colo that minimizes aggregate latency (e.g., Equinix NY4 provides access to NYSE, Nasdaq, CME's NY feed, ICE's NY feed)
- Colo RFP: request specific rack row/aisle, power density (kW/rack), cross-connect type (10G/100G/400G), fiber path length guarantee, and PTP grandmaster proximity

## Usage

```cpp
// Latency budget for colo selection
struct ColoOption {
    std::string facility_;
    std::string provider_;
    double fiber_length_meters_;  // to exchange matching engine
    int patch_panel_count_;
    bool ptp_available_;

    double estimated_one_way_us() const {
        double fiber_ns = fiber_length_meters_ * 5.0;  // ~5 ns/m in fiber
        double patch_ns = patch_panel_count_ * 1000;   // ~1 us per patch panel
        return (fiber_ns + patch_ns) / 1000.0;
    }
};

// Exchange colo quick reference
// Exchange | Facility             | Row/Area          | PTP
// ---------+----------------------+-------------------+------
// CME      | Equinix NY4          | CME Cermak PoP   |  Yes
// CME      | Equinix Cermak (IL) | Matching Engine   |  Yes
// Nasdaq   | Equinix NY4 / NY11   | Nasdaq cage area  |  Yes
// NYSE     | Equinix NY4          | NYSE MAK area     |  Yes
// Eurex    | Equinix FR2          | Eurex T7 room     |  Yes
// ICE      | Equinix NY4 / LD4   | ICE gateway       |  Yes
```

## Source Code

```cpp
// Fiber path optimisation checklist
// 1. Confirm cross-connect length in writing from colo provider
// 2. Measure RTT to exchange gateway (ping with hardware timestamp)
// 3. Baseline: RTT should be within 10% of 2 * fiber_length * 5 ns/m
// 4. If RTT > expected + 5 us, check for patch panels or signal regen
// 5. Request direct光纤 route bypassing colo middle-of-row (MOR) switch

// Cross-connect order form fields
// struct CrossConnectOrder {
//     std::string exchange_;
//     std::string colo_facility_;
//     std::string cage_id_;
//     std::string rack_id_;
//     std::string port_type_;   // 10GBASE-LR, 100GBASE-LR4
//     std::string destination_; // exchange cage/rack/port
//     double expected_rtt_us_;
//     bool ptp_sync_required_;
// };
```
