---
type: reference
title: "Hw Selection"
description: "CPU selection: Clock speed per core matters more than core count. NIC selection: Solarflare X2X00 (open-onload, ef_vi), Mellanox"
tags: ["phase-1"]
timestamp: "2026-06-27T03:06:09.398Z"
phase: 1
phaseName: "Foundations"
category: "Foundations"
subcategory: "foundations"
language: "cpp"
artifact-id: "ZHFT_HW_SELECTION"
---
## Key Learning Points

- CPU selection: Clock speed per core matters more than core count
- NIC selection: Solarflare X2X00 (open-onload, ef_vi), Mellanox
- Memory channels: 8 channels (Xeon) vs 12 (EPYC) → peak BW.
- PCIe lane budget: 128 lanes (EPYC) vs 64-80 (Xeon).  Each NIC
- Memory latency: DDR5 has higher CAS (CL40+) than DDR4 (CL16),

## Usage

// g++ -std=c++20 ZHFT_HW_SELECTION.txt -o hw_selector
// ./hw_selector --show-inventory  (demonstrates inventory struct)
// ./hw_selector --estimate-latency (runs latency calculator)

## Source Code

```cpp
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <format>
#include <iostream>
#include <map>
#include <string>
#include <string_view>
#include <vector>

// -------------------------------------------------------------------
// Hardware Inventory Management
//
// Structs modelling real hardware components.  These are useful for
// a config-file-driven inventory system where each server's parts
// are described in JSON/YAML and loaded into these structs.
// -------------------------------------------------------------------

enum class NicVendor {
    Solarflare,
    Mellanox,
    Intel,
    Broadcom
};

struct NicSpec {
    std::string   model;           // e.g., "X2X00", "ConnectX-6 Dx"
    NicVendor     vendor;
    int           pcie_lanes;      // 8 or 16
    int           pcie_gen;        // 3, 4, or 5
    double        port_speed_gbps; // 10, 25, 40, 100, 200
    bool          supports_onload; // Solarflare-specific
    bool          supports_dpdk;
    bool          has_hw_timestamping;

    // Estimate PCIe latency contribution (one-way in microseconds).
    // PCIe gen 4 x16: ~1 µs typical; gen 5 x16: ~0.7 µs.
    double latency_us() const noexcept {
        double base = 1.0;  // µs for Gen3 x16
        if (pcie_gen == 4) base = 0.8;
        if (pcie_gen == 5) base = 0.6;
        // Narrower lanes = slower serialisation.
        if (pcie_lanes == 8) base *= 1.3;
        if (pcie_lanes == 4) base *= 1.6;
        // Kernel bypass halves the software path but the PCIe fabric
        // latency is the same.  This is just the PCIe negotiation cost.
        return base;
    }
};

struct CpuSpec {
    std::string vendor;       // "Intel" or "AMD"
    std::string model;        // "Xeon Platinum 8480+", "EPYC 9654"
    double      base_ghz;     // Base clock
    double      turbo_ghz;    // Single-core turbo
    int         cores;
    int         threads_per_core; // 1 or 2 (HT)
    int         memory_channels;
    int         pcie_lanes_total;
    int         l3_cache_mb;

    // Latency estimate for a random main-memory access from this CPU.
    // This is a rough approximation based on memory channels & freq.
    double dram_latency_ns() const noexcept {
        // Intel Xeon: ~80-90 ns; AMD EPYC: ~90-100 ns (higher due to chiplet).
        double base = (vendor == "Intel") ? 80.0 : 95.0;
        // More channels = better interleaving = slightly lower latency.
        base -= std::min(20.0, static_cast<double>(memory_channels) * 1.5);
        return std::max(50.0, base);
    }
};

struct ServerSpec {
    std::string    hostname;
    CpuSpec        cpu;
    int            ram_gb;
    int            ram_channels_used;
    std::vector<NicSpec> nics;
    bool           has_nvme;
    int            nvme_count;
};

// -------------------------------------------------------------------
// Latency Estimation Calculator
//
// Given a server spec and a trade flow path, compute the expected
// round-trip latency breakdown.  This is deliberately simple — in
// production you'd model queue depths, LLC occupancy, etc.
// -------------------------------------------------------------------

struct PathLatencyBreakdown {
    double dram_ns;         // DRAM access (one NUMA hop)
    double pcie_nic_ns;     // PCIe traversal from NIC to CPU
    double kernel_ns;       // kernel stack (if not bypass)
    double onload_ns;       // if using kernel bypass / onload
    double switch_ns;       // Top-of-Rack switch latency (one way)
    double fiber_ns;        // Fiber to exchange (5 ns/m)
    double exchange_ns;     // Exchange matching engine processing

    double total_ns() const noexcept {
        return dram_ns + pcie_nic_ns + kernel_ns + onload_ns
             + switch_ns + fiber_ns + exchange_ns;
    }
};

[[nodiscard]]
auto estimate_path_latency(const ServerSpec& server, double distance_meters,
                           bool kernel_bypass) noexcept -> PathLatencyBreakdown {
    PathLatencyBreakdown b{};
    b.dram_ns     = server.cpu.dram_latency_ns();
    // PCIe: use the first NIC's spec.
    b.pcie_nic_ns = server.nics.empty()
                        ? 1000.0
                        : server.nics[0].latency_us() * 1000.0;
    b.kernel_ns   = kernel_bypass ? 0.0 : 5000.0;  // 5 µs kernel path
    b.onload_ns   = kernel_bypass ? 1000.0 : 0.0;  // 1 µs bypass overhead
    b.switch_ns   = 400.0;          // typical ToR switch, 300-500 ns
    b.fiber_ns    = distance_meters * 5.0;  // 5 ns/m in fiber
    b.exchange_ns = 2500.0;         // ~2.5 µs exchange matching engine
    return b;
}

// -------------------------------------------------------------------
// Interactive inventory display
// -------------------------------------------------------------------
void print_inventory(const std::vector<ServerSpec>& servers) {
    for (const auto& s : servers) {
        std::cout << std::format(
            "Server: {}\n"
            "  CPU    : {} {}\n"
            "  Cores  : {} ({} threads/core)\n"
            "  Turbo  : {:.1f} GHz\n"
            "  RAM    : {} GB ({} channels)\n"
            "  PCIe   : {} lanes\n"
            "  L3     : {} MB\n"
            "  NICs   :\n",
            s.hostname,
            s.cpu.vendor, s.cpu.model,
            s.cpu.cores, s.cpu.threads_per_core,
            s.cpu.turbo_ghz,
            s.ram_gb, s.ram_channels_used,
            s.cpu.pcie_lanes_total,
            s.cpu.l3_cache_mb
        );
        for (const auto& n : s.nics) {
            std::cout << std::format(
                "    - {} ({} Gbps, PCIe Gen{} x{})\n",
                n.model, n.port_speed_gbps, n.pcie_gen, n.pcie_lanes
            );
        }
    }
}

// -------------------------------------------------------------------
// MAIN
// -------------------------------------------------------------------
auto main(int argc, char** argv) -> int {
    // Example inventory.
    std::vector<ServerSpec> rack{
        {
            .hostname = "hft-srv-01",
            .cpu = {.vendor = "Intel", .model = "Xeon Platinum 8480+",
                    .base_ghz = 2.0, .turbo_ghz = 4.2,
                    .cores = 56, .threads_per_core = 2,
                    .memory_channels = 8, .pcie_lanes_total = 80,
                    .l3_cache_mb = 105},
            .ram_gb = 512, .ram_channels_used = 8,
            .nics = {
                {.model = "X2X00", .vendor = NicVendor::Solarflare,
                 .pcie_lanes = 16, .pcie_gen = 4, .port_speed_gbps = 100,
                 .supports_onload = true, .supports_dpdk = true,
                 .has_hw_timestamping = true}
            },
            .has_nvme = true, .nvme_count = 2
        },
        {
            .hostname = "hft-srv-02",
            .cpu = {.vendor = "AMD", .model = "EPYC 9654",
                    .base_ghz = 2.4, .turbo_ghz = 4.15,
                    .cores = 96, .threads_per_core = 1,
                    .memory_channels = 12, .pcie_lanes_total = 128,
                    .l3_cache_mb = 384},
            .ram_gb = 768, .ram_channels_used = 12,
            .nics = {
                {.model = "ConnectX-7", .vendor = NicVendor::Mellanox,
                 .pcie_lanes = 16, .pcie_gen = 5, .port_speed_gbps = 400,
                 .supports_onload = false, .supports_dpdk = true,
                 .has_hw_timestamping = true}
            },
            .has_nvme = true, .nvme_count = 4
        }
    };

    bool show_inv     = true;
    bool est_latency  = true;

    for (int i = 1; i < argc; ++i) {
        std::string arg(argv[i]);
        if (arg == "--show-inventory")    show_inv = true;
        if (arg == "--estimate-latency")  est_latency = true;
    }

    if (show_inv) {
        std::cout << "=== Hardware Inventory ===\n";
        print_inventory(rack);
    }

    if (est_latency) {
        std::cout << "\n=== Latency Estimates (CME Colo, ~10m fiber) ===\n";
        for (const auto& s : rack) {
            auto b = estimate_path_latency(s, 10.0, true);
            std::cout << std::format(
                "{}: DRAM={:.0f}ns  PCIe={:.0f}ns  Bypass={:.0f}ns  "
                "Switch={:.0f}ns  Fiber={:.0f}ns  Exchange={:.0f}ns  "
                "TOTAL={:.0f}ns\n",
                s.hostname,
                b.dram_ns, b.pcie_nic_ns, b.onload_ns,
                b.switch_ns, b.fiber_ns, b.exchange_ns,
                b.total_ns()
            );
        }
        std::cout << "\nNote: Add ~5 µs kernel path if NOT using bypass.\n";
    }

    return 0;
}
```
