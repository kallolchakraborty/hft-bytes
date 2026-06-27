---
type: reference
title: "FPGA Vendors"
description: "Xilinx Alveo: U200 (522K LUT), U250 (1.7M LUT), U280 (HBM2). Intel PAC D5005: Stratix 10, 933K LUTs, 2x DDR4, PCIe Gen3x16"
tags: ["fpga"]
difficulty: advanced
timestamp: "2026-06-27T03:06:09.446Z"
phase: 13
phaseName: "FPGA & Hardware"
category: "Phase 13 - FPGA & Hardware"
subcategory: "fpga"
language: "cpp"
artifact-id: "ZHFT_FPGA_VENDORS"
---
## Key Learning Points

- Xilinx Alveo: U200 (522K LUT), U250 (1.7M LUT), U280 (HBM2)
- Intel PAC D5005: Stratix 10, 933K LUTs, 2x DDR4, PCIe Gen3x16
- Development boards: Alveo U50 (low-profile), VCU118 (prototyping)
- Toolchain: Vivado (Xilinx) vs Quartus (Intel) vs Vitis (Xilinx HLS)
- Cloud FPGA: AWS F1 (Xilinx Ultrascale+), Azure (Intel Stratix 10)
- HLS vs Verilog: HLS is 10x faster to write, 60-80% of hand-code perf

## Usage

```bash

FPGA card benchmark harness (pseudo)
```
FpgaBench bench("Alveo U250");
bench.loadBitstream("itch_parser.bit");
auto lat = bench.measureLatency(1000000);

## Source Code

```cpp
#include <string>
#include <vector>
#include <chrono>
#include <cstdint>

// --------------------------------------------------------------------
// FPGA Card Specification Database

struct FpgaSpec {
    std::string vendor;
    std::string model;
    int         luts;          // logic cells (K)
    int         dsp_slices;
    double      bram_mb;       // MB
    double      hbm_gb;        // HBM memory (GB)
    int         pcie_gen;
    int         pcie_lanes;
    double      max_freq_mhz;
    double      price_usd;
    std::string cloud_instance;
};

class FpgaCatalog {
    std::vector<FpgaSpec> cards_;

public:
    FpgaCatalog() {
        cards_ = {
            {"Xilinx", "Alveo U200",  522, 1920,  27.0, 0, 3, 16, 322, 8000, ""},
            {"Xilinx", "Alveo U250",  1728, 2808, 54.0, 0, 3, 16, 322, 12000, ""},
            {"Xilinx", "Alveo U280",  1728, 2808, 54.0, 8.0, 3, 16, 322, 14000, ""},
            {"Xilinx", "Alveo U50",   872, 800, 21.0, 0, 4, 8, 300, 5500, ""},
            {"Intel",  "PAC D5005",   933, 5760, 37.5, 0, 3, 16, 300, 10000, ""},
            {"Intel",  "PAC D2000",   1300, 4500, 45.0, 0, 4, 16, 300, 12000, ""},
            {"Xilinx", "AWS F1 (f1.2x)", 1350, 2160, 54.0, 0, 3, 16, 322, 0, "f1.2xlarge"},
            {"Xilinx", "AWS F1 (f1.16x)", 5400, 8640, 216.0, 0, 3, 16, 322, 0, "f1.16xlarge"},
        };
    }

    const FpgaSpec* find(const std::string& model) const {
        for (auto& c : cards_)
            if (c.model == model) return &c;
        return nullptr;
    }

    // Recommendation by budget
    std::vector<const FpgaSpec*> byBudget(double max_usd) const {
        std::vector<const FpgaSpec*> rec;
        for (auto& c : cards_)
            if (c.price_usd <= max_usd || c.price_usd == 0)
                rec.push_back(&c);
        return rec;
    }
};

// --------------------------------------------------------------------
// Benchmark Harness (pseudo)

class FpgaBench {
    std::string card_model_;
    // In production: Xilinx XDMA driver, PCIe DMA buffers

public:
    explicit FpgaBench(std::string card) : card_model_(std::move(card)) {}

    // Load synthesized bitstream
    bool loadBitstream(const std::string& bit_path) {
        // prc(bit_path.c_str());
        return true;
    }

    struct LatencyResult {
        double min_us;     // minimum observed
        double avg_us;
        double p50_us;
        double p99_us;
        double max_us;
        uint64_t samples;
    };

    LatencyResult measureLatency(uint64_t num_packets) {
        // Pre-fill DMA buffer with test tick data
        // Send via PCIe → FPGA process → DMA back
        // Measure round-trip with HPET or PCIe timestamp
        // tradeoff: host timestamps (ns granularity) vs FPGA cycle counter (3.1ns)

        // Key insight: FPGA latency is deterministic — jitter < 50 ns
        // vs CPU where context switches cause 50-500μs pauses
        return {0.08, 0.10, 0.10, 0.12, 0.15, num_packets};
    }

    // Toolchain comparison
    // Vivado: better for large Xilinx designs, has Vitis HLS, slower P&R
    // Quartus: better for Intel, faster compile times, fewer third-party IP
    // OneSpin/Synopsys: formal verification (critical for HFT correctness)
};

// AWS F1 deployment flow:
//   1. aws ec2 create-fpga-image --shell <AFI>
//   2. Develop in Vivado, generate .tar for AWS
//   3. afi = aws ec2 describe-fpga-images
//   4. Load: fpga-load-local-image -S <afi-global-id>
//   5. Access via /dev/xdma0_* + mmap

// tradeoff: cloud FPGA (AWS F1 $13/h) vs on-prem ($12K + colo 2K/mo)
// Break-even: ~500 hours cloud → buy on-prem
```
