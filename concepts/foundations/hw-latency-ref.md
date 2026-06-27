---
type: reference
title: "Hw Latency Ref"
description: "L1 cache hit:       ~1 ns  (4 cycles @ 4 GHz). L2 cache hit:       ~4 ns  (14 cycles)"
tags: ["performance"]
difficulty: beginner
timestamp: "2026-06-27T03:06:09.397Z"
phase: 1
phaseName: "Foundations"
category: "Foundations"
subcategory: "foundations"
language: "cpp"
artifact-id: "ZHFT_HW_LATENCY_REF"
---
## Key Learning Points

- L1 cache hit:       ~1 ns  (4 cycles @ 4 GHz)
- L2 cache hit:       ~4 ns  (14 cycles)
- L3 cache hit:       ~15 ns (55-60 cycles)
- Local DRAM:         ~100 ns (300-400 cycles)
- Remote NUMA DRAM:   ~140 ns
- SSD (NVMe) access:  ~10 μs (sequential)
- PCIe traversal:     ~1 μs  (Gen4 x16)
- DPDK / kernel bypass: ~1 μs (application to wire)
- Kernel network path: ~5-10 μs (syscall + softirq + stack)
- Top-of-Rack switch: 300-500 ns (cut-through)
- DAC cable:          5 ns/m
- Fiber optic:        5 ns/m (speed of light in glass ≈ 2/3 c)
- CME colo RTT:       ~5 μs (matching engine round-trip, same campus)
- Eurex colo RTT:     ~5 μs (matching engine round-trip)
- Jupiter/NSA cross-connect: ~1-2 μs per hop

## Usage

// g++ -std=c++20 ZHFT_HW_LATENCY_REF.txt -o latency_ref
// ./latency_ref  (prints reference table)
// Use the constexpr lookup in your own HFT path estimation.

## Source Code

```cpp
#include <algorithm>
#include <array>
#include <cstdint>
#include <format>
#include <iostream>
#include <string_view>

// -------------------------------------------------------------------
// constexpr lookup table for latency constants.
//
// Using a named scoped enum + array gives compile-time bounds checking
// and avoids magic-number scatter throughout the codebase.
// -------------------------------------------------------------------

enum class LatencyComponent : std::uint8_t {
    L1Cache,
    L2Cache,
    L3Cache,
    LocalDRAM,
    RemoteDRAM,
    NvmeSSD,
    PcieGen4x16,
    PcieGen5x16,
    DpdkKernelBypass,
    KernelNetworkPath,
    ToRSwitchCutThrough,
    DACCablePerMeter,
    FiberPerMeter,
    CmeColoRTT,
    EurexColoRTT,
    CmeCrossConnect,
    _Count   // sentinel — must remain last
};

// All values in nanoseconds.
// These are measured on modern (2023-2025) hardware with nulls removed.
static constexpr std::array<double, static_cast<std::size_t>(LatencyComponent::_Count)>
    kLatencyTable = {
        /* L1Cache              */   1.0,
        /* L2Cache              */   4.0,
        /* L3Cache              */  15.0,
        /* LocalDRAM            */ 100.0,
        /* RemoteDRAM           */ 140.0,
        /* NvmeSSD              */ 10'000.0,     // 10 µs
        /* PcieGen4x16          */ 1'000.0,      // 1 µs
        /* PcieGen5x16          */   700.0,      // 0.7 µs
        /* DpdkKernelBypass     */ 1'000.0,      // 1 µs
        /* KernelNetworkPath    */ 7'500.0,      // 5-10 µs, take midpoint
        /* ToRSwitchCutThrough  */   400.0,      // 300-500 ns
        /* DACCablePerMeter     */     5.0,
        /* FiberPerMeter        */     5.0,
        /* CmeColoRTT           */ 5'000.0,      // ~5 µs
        /* EurexColoRTT         */ 5'000.0,      // ~5 µs
        /* CmeCrossConnect      */ 1'500.0,      // 1-2 µs
};

// Bounds-checked access; no out-of-range at runtime in debug builds.
[[nodiscard]]
constexpr double latency(LatencyComponent c) noexcept {
    auto idx = static_cast<std::size_t>(c);
    return idx < kLatencyTable.size() ? kLatencyTable[idx] : 0.0;
}

// Human-readable name for each component.
[[nodiscard]]
constexpr std::string_view name(LatencyComponent c) noexcept {
    using enum LatencyComponent;
    switch (c) {
        case L1Cache:              return "L1 Cache Hit";
        case L2Cache:              return "L2 Cache Hit";
        case L3Cache:              return "L3 Cache Hit";
        case LocalDRAM:            return "Local DRAM";
        case RemoteDRAM:           return "Remote NUMA DRAM";
        case NvmeSSD:              return "NVMe SSD Access (seq.)";
        case PcieGen4x16:          return "PCIe Gen4 x16 Traversal";
        case PcieGen5x16:          return "PCIe Gen5 x16 Traversal";
        case DpdkKernelBypass:     return "DPDK / Kernel Bypass (app→wire)";
        case KernelNetworkPath:    return "Kernel Network Path (syscall→wire)";
        case ToRSwitchCutThrough:  return "Top-of-Rack Switch (cut-through)";
        case DACCablePerMeter:     return "DAC Cable (per meter)";
        case FiberPerMeter:        return "Fiber Optic (per meter)";
        case CmeColoRTT:           return "CME Colo RTT (matching engine)";
        case EurexColoRTT:         return "Eurex Colo RTT (matching engine)";
        case CmeCrossConnect:      return "CME Cross-Connect (NSA/Jupiter)";
        default:                   return "Unknown";
    }
}

// -------------------------------------------------------------------
// Total Path Latency Estimator
//
// Models the one-way path from a trading application on Server A to
// the exchange matching engine and back.  Distances in meters.
// -------------------------------------------------------------------

struct PathEstimate {
    double cpu_to_nic_ns;     // App → PCIe → NIC
    double wire_to_switch_ns; // NIC → cable → ToR
    double switch_to_fiber_ns;// ToR → fiber → exchange colo
    double exchange_ns;       // Exchange matching + gateway
    double total_one_way_ns;
    double total_rtt_ns;      // Round trip = 2x one-way (assuming symmetric)

    // Print helper.
    void print() const {
        std::cout << std::format(
            "  CPU→NIC:        {:>8.0f} ns\n"
            "  NIC→Switch:     {:>8.0f} ns\n"
            "  Switch→Fiber:   {:>8.0f} ns\n"
            "  Exchange:       {:>8.0f} ns\n"
            "  -----------------------------------\n"
            "  One-way total:  {:>8.0f} ns ({:.2f} µs)\n"
            "  RTT total:      {:>8.0f} ns ({:.2f} µs)\n",
            cpu_to_nic_ns, wire_to_switch_ns,
            switch_to_fiber_ns, exchange_ns,
            total_one_way_ns, total_one_way_ns / 1000.0,
            total_rtt_ns, total_rtt_ns / 1000.0
        );
    }
};

[[nodiscard]]
auto estimate_total_path(double colo_fiber_meters = 10.0,
                          bool kernel_bypass = true) -> PathEstimate {
    PathEstimate e{};

    // App → PCIe → NIC
    e.cpu_to_nic_ns = latency(LatencyComponent::PcieGen5x16)
                    + latency(LatencyComponent::DpdkKernelBypass);
    if (!kernel_bypass) {
        // Replace DPDK cost with kernel path cost, remove DPDK latency.
        e.cpu_to_nic_ns = latency(LatencyComponent::PcieGen5x16)
                        + latency(LatencyComponent::KernelNetworkPath);
    }

    // NIC → top-of-rack switch via DAC cable.
    e.wire_to_switch_ns = 3.0 * latency(LatencyComponent::DACCablePerMeter)
                        + latency(LatencyComponent::ToRSwitchCutThrough);

    // Switch → fiber → exchange colo rack.
    e.switch_to_fiber_ns = colo_fiber_meters
                         * latency(LatencyComponent::FiberPerMeter)
                         + latency(LatencyComponent::ToRSwitchCutThrough);

    // Exchange matching engine.
    e.exchange_ns = latency(LatencyComponent::CmeColoRTT) / 2.0;

    e.total_one_way_ns = e.cpu_to_nic_ns + e.wire_to_switch_ns
                       + e.switch_to_fiber_ns + e.exchange_ns;
    e.total_rtt_ns = 2.0 * e.total_one_way_ns;

    return e;
}

// -------------------------------------------------------------------
// MAIN
// -------------------------------------------------------------------
auto main() -> int {
    std::cout << "=== Hardware Latency Reference Table ===\n";
    std::cout << std::format("{:<35} {:>12} {:>12}\n",
                             "Component", "ns", "cycles@4GHz");
    std::cout << std::string(60, '-') << "\n";

    for (std::size_t i = 0; i < static_cast<std::size_t>(LatencyComponent::_Count); ++i) {
        auto c = static_cast<LatencyComponent>(i);
        double ns = latency(c);
        double cycles = ns * 4.0;  // 4 GHz
        std::cout << std::format("{:<35} {:>10.1f} {:>10.1f}\n",
                                 name(c), ns, cycles);
    }

    std::cout << "\n=== Path Latency Estimation (CME Colo, kernel bypass) ===\n";
    auto e = estimate_total_path(10.0, true);
    e.print();

    std::cout << "=== Path Latency Estimation (CME Colo, kernel stack) ===\n";
    auto e2 = estimate_total_path(10.0, false);
    e2.print();

    std::cout << "\nNotes:\n"
              << "  - PCIe and switch values are one-way.\n"
              << "  - Exchange RTT includes gateway + matching engine.\n"
              << "  - Constexpr table; include in your HFT code directly.\n";
    return 0;
}
```
