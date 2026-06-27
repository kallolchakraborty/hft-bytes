---
type: decision-matrix
title: "FPGA Vs CPU"
description: "FPGA: ~100ns tick-to-order vs CPU: ~1-10μs (10-100x advantage). CPU: flexible, easy to program; FPGA: 3-6 month dev cycle"
tags: ["fpga"]
timestamp: "2026-06-27T03:06:09.446Z"
phase: 13
phaseName: "FPGA & Hardware"
category: "Phase 13 - FPGA & Hardware"
subcategory: "fpga"
language: "cpp"
artifact-id: "ZHFT_FPGA_VS_CPU"
---
## Key Learning Points

- FPGA: ~100ns tick-to-order vs CPU: ~1-10μs (10-100x advantage)
- CPU: flexible, easy to program; FPGA: 3-6 month dev cycle
- Development cost: FPGA team (Verilog/HLS) is 2-3x salary premium
- Iteration speed: CPU = minutes; FPGA = hours (synthesis + P&R)
- FPGA wins: deterministic latency, wire-speed processing
- CPU wins: complex logic, ML models, strategy iteration, legacy systems

## Source Code

```cpp
*
 * USAGE:
 *   // Decision: route tick-to-trade logic
 *   if (latencyBudget < 500ns) -> FPGA
 *   if (strategyComplex)       -> CPU + FPGA co-process
 *
 * PERFORMANCE TARGET:
 *   N/A (decision framework)
 * ====================================================================
 */

#include <string>
#include <unordered_map>

class HardwareSelector {
    // Decision engine for CPU vs FPGA partitioning

    enum class Unit { FPGA, CPU, BOTH };

    struct DecisionCriteria {
        double latency_ns;        // required end-to-end
        double throughput_mpps;   // million packets per sec
        bool   complex_math;      // floating point heavy?
        bool   ml_model;          // neural network?
        bool   fast_iterate;      // strategy changes daily?
        double dev_budget;        // $K
    };

public:
    Unit recommend(const DecisionCriteria& dc) {
        // tradeoff: FPGA if latency < 1μs and throughput > 10M pps
        // tradeoff: CPU if complex math or ML or fast iteration needed
        if (dc.latency_ns < 1000 && dc.throughput_mpps > 10)
            return dc.ml_model ? Unit::BOTH : Unit::FPGA;
        // Hybrid: FPGA for parsing, CPU for strategy
        // Canonical HFT split: FPGA decodes + book, CPU runs strategy
        if (dc.latency_ns < 5000)
            return Unit::BOTH;
        return Unit::CPU;
    }

    std::string rationale(const DecisionCriteria& dc, Unit u) {
        std::string r;
        switch (u) {
            case Unit::FPGA:
                r = "FPGA: deterministic sub-μs path. ";
                r += "Budget for Verilog team? $200-400k/yr per engineer. ";
                r += "Synthesis ~4hrs per change. Must freeze spec.";
                break;
            case Unit::CPU:
                r = "CPU: flexible, fast iteration. ";
                r += "Use kernel bypass (DPDK/ef_vi) to reduce jitter. ";
                r += "Accept 1-10μs latency. Good for complex strategies.";
                break;
            case Unit::BOTH:
                r = "Hybrid: FPGA for line-rate parse + book building. ";
                r += "CPU for strategy logic (C++). PCIe DMA bridge. ";
                r += "Best of both worlds but complex debugging.";
                break;
        }
        return r;
    }
};
```
## Decision Matrix

| DIMENSION | FPGA (Alveo U250) | CPU (Xeon 3.6GHz) |
| --- | --- | --- |
| Latency (tick→decision) | 100-300 ns | 1-10 μs |
| Latency jitter (p99) | < 50 ns | 50-500 μs (OS noise) |
| Throughput (packets/sec) | 100M+ (line-rate 100G) | 10M (kernel bypass) |
| Pipeline depth | 5-50 stages | 10-100 instructions |
| Clock speed | 200-500 MHz | 3-5 GHz |
| Development time | 3-6 months | 1-4 weeks |
| Developer cost | $$$ (Verilog niche) | $$ (C++ common) |
| Debugging | Waveforms, simulation | gdb, printf, perf |
| Reconfiguration | Hours (synthesis) | Seconds (recompile) |
| Floating-point | Poor (DSP slices) | Excellent (AVX-512) |
| Random access memory | Limited (BRAM/URAM) | 1TB+ (DDR5/PMem) |
| Machine learning | QNN, small models | Full stack (PyTorch) |
| Risk of bugs | High (hardware idioms) | Moderate |
| Power efficiency | 0.1-0.5 pJ/op | 1-5 pJ/op |
| MATRIX |

