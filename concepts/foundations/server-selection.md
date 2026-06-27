---
type: reference
title: "Server Selection"
description: "AMD EPYC: higher core count (96-128), 12-channel DDR5, 128 PCIe 5. Intel Xeon: higher turbo frequency (4.5+ GHz), 8-channel DDR5,"
tags: ["phase-1"]
timestamp: "2026-06-27T03:06:09.399Z"
phase: 1
phaseName: "Foundations"
category: "Foundations"
subcategory: "foundations"
language: "cpp"
artifact-id: "ZHFT_SERVER_SELECTION"
---
## Key Learning Points

- AMD EPYC: higher core count (96-128), 12-channel DDR5, 128 PCIe 5
- Intel Xeon: higher turbo frequency (4.5+ GHz), 8-channel DDR5,
- Memory: DDR5-4800 offers higher bandwidth but higher CAS latency
- PCIe 5.0 vs 4.0: double the bandwidth per lane.  A Gen5 x16 link
- Cache hierarchy: EPYC's 384 MB L3 is shared across chiplets (CCD)
- TCO: EPYC generally lower per-core cost; Xeon has higher resale
- For extreme low-latency (<1 µs), single-socket Xeon with locked

## Usage

// g++ -std=c++20 ZHFT_SERVER_SELECTION.txt -o server_selector
// ./server_selector  (compare pre-configured profiles)
// ./server_selector --custom  (interactive custom spec)

## Source Code

```cpp
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <format>
#include <iostream>
#include <string>
#include <string_view>
#include <vector>

// -------------------------------------------------------------------
// Performance Projection Calculator
//
// Given a hardware spec, estimate expected throughput and latency.
// The model is deliberately simplified — real projections require
// benchmarking representative microbenchmarks on the target hardware.
// -------------------------------------------------------------------

struct CpuProfile {
    std::string_view vendor;
    std::string_view model;
    double           clock_ghz;      // locked/scaled frequency
    int              cores;          // physical
    int              threads_per_core;
    int              memory_channels;
    int              pcie_lanes;
    int              pcie_gen;
    int              l3_cache_mb;
    double           l3_latency_ns;    // typical L3 hit latency
    double           cross_die_latency_ns; // chiplet/ring hop latency
    bool             single_die;       // true = Xeon ring, false = EPYC chiplet
};

struct NicProfile {
    std::string_view model;
    int              speed_gbps;
    int              pcie_lanes;
    int              pcie_gen;
    double           latency_us;       // app→wire via bypass
};

struct WorkloadProfile {
    std::string_view name;
    double           instructions_per_packet; // how much work per market data msg
    double           memory_per_packet_kb;
    bool             latency_sensitive;       // true = order entry
};

// Projected throughput in packets/sec (one-way).
struct ProjectedThroughput {
    double max_packet_rate_mpps;   // millions of packets per second
    double latency_50th_ns;
    double latency_99th_ns;
    double latency_99_9th_ns;
    double pcie_bandwidth_used_gbps;
    double memory_bandwidth_used_gbps;
};

class PerformanceProjector {
    CpuProfile cpu_;
    NicProfile nic_;
    WorkloadProfile workload_;

public:
    PerformanceProjector(CpuProfile cpu, NicProfile nic, WorkloadProfile wl)
        : cpu_(cpu), nic_(nic), workload_(wl) {}

    [[nodiscard]] auto project() const -> ProjectedThroughput {
        ProjectedThroughput p{};

        // ---- CPU-bound throughput ----
        // Each packet uses instructions_per_packet instructions.
        // Modern x86 retires ~4 IPC on latency-bound code, ~2 on
        // mixed, ~0.5-1 on memory-bound.  Assume 2 IPC average.
        double ipc = 2.0;
        double instructions_per_second = cpu_.clock_ghz * 1e9 * ipc;
        double packets_per_second_cpu = instructions_per_second
                                     / workload_.instructions_per_packet;
        p.max_packet_rate_mpps = packets_per_second_cpu / 1e6;

        // ---- PCIe bottleneck ----
        double pcie_bw = static_cast<double>(nic_.pcie_lanes)
                       * (nic_.pcie_gen == 5 ? 32.0 : 16.0)  // GB/s per lane
                       * 1e9;  // bytes/sec
        // Each packet has ~1500 B MTU + headers (~200 B).  Assume 1200 B
        // average for market data (FIX/ITCH).
        double packet_size_bytes = 1200.0;
        double packets_per_sec_pcie = pcie_bw / packet_size_bytes;
        p.pcie_bandwidth_used_gbps = std::min(packet_size_bytes * 8.0
                * p.max_packet_rate_mpps * 1e6 / 1e9,
                static_cast<double>(nic_.speed_gbps));

        // ---- Memory bandwidth bottleneck ----
        double mem_bw = static_cast<double>(cpu_.memory_channels) * 38.4e9; // DDR5-4800 GB/s
        double packets_per_sec_mem = mem_bw / (workload_.memory_per_packet_kb * 1024.0);

        // The overall throughput is the minimum of all bottlenecks.
        p.max_packet_rate_mpps = std::min({
            p.max_packet_rate_mpps,
            packets_per_sec_pcie / 1e6,
            packets_per_sec_mem / 1e6
        });

        // ---- Latency projection ----
        double base_lat = nic_.latency_us * 1000.0;      // PCIe + bypass
        base_lat += cpu_.l3_latency_ns;                    // L3 hit for code
        // DRAM access if memory per packet > L3 size / cache-line tracking.
        if (workload_.memory_per_packet_kb > 0.5) {
            base_lat += 100.0;  // local DRAM hit
        }
        // Cross-die penalty for EPYC.
        if (!cpu_.single_die) {
            base_lat += cpu_.cross_die_latency_ns;  // 75-100 ns
        }

        p.latency_50th_ns  = base_lat;
        p.latency_99th_ns  = base_lat + base_lat * 0.2;  // +20% tail
        p.latency_99_9th_ns = base_lat + base_lat * 0.5;

        p.memory_bandwidth_used_gbps = p.max_packet_rate_mpps * 1e6
                                     * workload_.memory_per_packet_kb * 1024.0 * 8.0
                                     / 1e9;

        return p;
    }

    void print() const {
        auto p = project();
        std::cout << std::format(
            "\n=== Performance Projection ===\n"
            "CPU:  {} {} ({:.1f} GHz, {} cores)\n"
            "NIC:  {} {} Gbps\n"
            "WL:   {} ({:.0f} inst/pkt, {:.1f} KB mem/pkt)\n\n"
            "Max packet rate:  {:.2f} Mpps\n"
            "Latency (50th):   {:.0f} ns\n"
            "Latency (99th):   {:.0f} ns\n"
            "Latency (99.9th): {:.0f} ns\n"
            "PCIe BW used:     {:.1f} Gbps\n"
            "Memory BW used:   {:.1f} Gbps\n",
            cpu_.vendor, cpu_.model, cpu_.clock_ghz, cpu_.cores,
            nic_.model, nic_.speed_gbps,
            workload_.name,
            workload_.instructions_per_packet,
            workload_.memory_per_packet_kb,
            p.max_packet_rate_mpps,
            p.latency_50th_ns,
            p.latency_99th_ns,
            p.latency_99_9th_ns,
            p.pcie_bandwidth_used_gbps,
            p.memory_bandwidth_used_gbps
        );
    }
};

// -------------------------------------------------------------------
// Pre-defined profiles for quick comparison
// -------------------------------------------------------------------

static constexpr CpuProfile kXeonPlatinum = {
    .vendor = "Intel", .model = "Xeon Platinum 8480+",
    .clock_ghz = 4.2, .cores = 56, .threads_per_core = 2,
    .memory_channels = 8, .pcie_lanes = 80, .pcie_gen = 5,
    .l3_cache_mb = 105, .l3_latency_ns = 12.0,
    .cross_die_latency_ns = 0.0, .single_die = true
};

static constexpr CpuProfile kEpyc9654 = {
    .vendor = "AMD", .model = "EPYC 9654",
    .clock_ghz = 3.7, .cores = 96, .threads_per_core = 1,
    .memory_channels = 12, .pcie_lanes = 128, .pcie_gen = 5,
    .l3_cache_mb = 384, .l3_latency_ns = 18.0,
    .cross_die_latency_ns = 85.0, .single_die = false
};

static constexpr NicProfile kNicSolarflareX2X00 = {
    .model = "Solarflare X2X00", .speed_gbps = 100,
    .pcie_lanes = 16, .pcie_gen = 4, .latency_us = 1.0
};

static constexpr NicProfile kNicConnectX7 = {
    .model = "Mellanox ConnectX-7", .speed_gbps = 400,
    .pcie_lanes = 16, .pcie_gen = 5, .latency_us = 0.7
};

static constexpr WorkloadProfile kOrderEntry = {
    .name = "Order Entry",
    .instructions_per_packet = 5000,
    .memory_per_packet_kb = 0.2,
    .latency_sensitive = true
};

static constexpr WorkloadProfile kMarketData = {
    .name = "Market Data Fan-out",
    .instructions_per_packet = 200,
    .memory_per_packet_kb = 4.0,
    .latency_sensitive = false
};

// -------------------------------------------------------------------
// MAIN
// -------------------------------------------------------------------
auto main(int argc, char** argv) -> int {
    bool custom = false;
    for (int i = 1; i < argc; ++i) {
        if (std::string(argv[i]) == "--custom") custom = true;
    }

    std::cout << "=== Server Selection: Performance Projection ===\n";

    // Pre-built comparisons.
    std::cout << "\n--- Order Entry (latency-critical) ---";

    PerformanceProjector(kXeonPlatinum, kNicSolarflareX2X00, kOrderEntry).print();
    PerformanceProjector(kEpyc9654,     kNicConnectX7,         kOrderEntry).print();

    std::cout << "\n--- Market Data Fan-out (throughput-critical) ---";
    PerformanceProjector(kXeonPlatinum, kNicSolarflareX2X00, kMarketData).print();
    PerformanceProjector(kEpyc9654,     kNicConnectX7,         kMarketData).print();

    if (custom) {
        std::cout << "\nInteractive custom mode not implemented.\n";
        std::cout << "Edit the source to add your own CpuProfile/NicProfile.\n";
    }

    std::cout << "\nDecision matrix:\n"
              << "  For latency (<1 µs jitter): Locked-frequency single-socket\n"
              << "    Xeon with SMT off, no Turbo, kernel bypass.\n"
              << "  For throughput (10-100 Gbps): EPYC with many cores,\n"
              << "    12-channel DDR5, 128 PCIe lanes for NICs+FPGAs.\n";
    return 0;
}
```
