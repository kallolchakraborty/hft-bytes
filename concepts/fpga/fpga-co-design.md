---
type: reference
title: "FPGA-CPU Co-Design for HFT"
description: "FPGA-CPU co-design methodology for HFT systems: CPU↔FPGA communication over PCIe DMA and CXL, partitioning decisions (what goes on FPGA vs CPU), shared memory handoff, latency budgets, and co-design patterns for market data parsing, order generation, and risk checking."
tags: ["fpga", "co-design", "pcie", "accelerator", "hardware"]
difficulty: staff
timestamp: "2026-06-27T19:00:00.000Z"
phase: 6
phaseName: "System Architecture"
category: "FPGA & Hardware Acceleration"
subcategory: "fpga"
language: "cpp"
artifact-id: "ZHFT_FPGA_CO_DESIGN"
---

## Key Learning Points

- **CPU↔FPGA communication channels**: three primary interconnects: (a) PCIe DMA — FPGA writes directly to host memory via DMA; driver creates a DMA buffer pool, FPGA writes packets into pre-registered buffers, CPU polls a completion queue. Latency: ~1.5µs for small transfers. (b) CXL (Compute Express Link) — cache-coherent shared memory between CPU and FPGA; no DMA setup overhead, but limited device availability (2025+). Latency: ~500ns for cache-line transfers. (c) Direct register access (MMIO) — CPU reads/writes FPGA registers via PCIe BAR space; limited throughput but <200ns latency. HFT systems use DMA for bulk data (market data) and MMIO for control (start/stop, config)
- **What goes on FPGA and what stays on CPU**: FPGA is good for: wire-speed packet processing (10/25/100 Gbps), deterministic latency (no OS jitter), feed parsing/decoding (ITCH, SBE, FAST), symbol table lookup, order generation at fixed intervals. CPU is better for: complex strategy logic (ML models, cross-asset calculations), large state management (full order book for 10K+ symbols), risk checks with global position view, dynamic reconfiguration. The heuristic: if the logic fits in a pipeline of ~20 stages with fixed throughput and <50K state, put it on FPGA. If it needs random access to >1MB state or has complex branching, keep it on CPU
- **DMA buffer management**: the FPGA writes parsed market data to a pre-allocated DMA buffer; the CPU reads it from the buffer on the next poll cycle. Key design: double-buffering or ring buffer. A producer-consumer ring buffer in host memory: FPGA writes to slot N, increments write pointer; CPU reads from the consumer pointer, processes, increments. Use doorbell registers (MMIO write by FPGA to signal new data) or polling (CPU spins on a seqno counter in host memory). Polling adds <100ns but uses a CPU core at 100%. Doorbell adds ~500ns (PCIe transaction) but allows the CPU to sleep. Tradeoff: HFT systems poll (dedicated core). Buffer size: enough for 100ms of market data at peak rate — for 100 Gbps with 100-byte messages, that's ~12.5M messages = 1.2GB. Use huge pages (2MB) for DMA buffers to avoid TLB misses
- **CXL for FPGA coherency**: CXL.mem allows the FPGA to cache-coherently access host memory. No more DMA buffer management — FPGA can directly read/write any virtual address. The CPU and FPGA share data structures (order books, symbol tables) without serialization or explicit DMA transfers. Current (2026) CXL FPGA implementations: Xilinx (AMD) Alveo X3522 with CXL 2.0 support; Intel Agilex 7 with CXL. Latency: ~500ns for cache-line read via CXL vs ~1.5µs for PCIe DMA. However CXL bandwidth is shared with the CPU's memory bandwidth — can cause contention. Best practice: use CXL for control/state sharing (small, latency-sensitive) and PCIe DMA for bulk data streaming
- **Partitioning pattern: feed parsing on FPGA, strategy on CPU**: FPGA receives raw Ethernet packets from the NIC (or FPGA has integrated NIC MAC). FPGA parses the feed (e.g., Nasdaq ITCH), extracts order book deltas, and writes parsed updates to DMA buffer. CPU reads updates and maintains the full order book in memory. FPGA also computes derived signals (e.g., VWAP, spread, imbalance) and includes them in the DMA update. CPU strategy reads both raw book updates and FPGA-computed signals. This reduces CPU load: parsing a 100 Gbps ITCH feed requires ~3 CPU cores; FPGA does it in hardware at wire speed
- **Partitioning pattern: FPGA order gateway**: FPGA generates and sends orders to the exchange. CPU sends order requests to FPGA via MMIO write (128-bit packet: symbol_id, side, price, qty, order_id). FPGA formats the wire-level FIX/SBE message, transmits it, and monitors for fills/acks via the exchange response stream. FPGA writes fill notifications back to a DMA buffer. This pattern removes OS networking stack latency from the order path — FPGA to exchange is <500ns wire-to-wire
- **Co-design methodology**: (a) define latency budget for the full path (market data → decision → order sent); (b) profile the existing CPU-only path to identify the top-3 latency contributors; (c) evaluate FPGA speedup for each — if FPGA can reduce latency by >50% for that stage, consider implementing; (d) design the CPU↔FPGA handoff API (shared data structures, ring buffer protocol, control register map); (e) simulate the combined system with a cosimulation framework (CPU software model + FPGA RTL simulation); (f) hardware-in-the-loop testing: connect FPGA to a test server that injects market data at 10/25/100 Gbps; measure end-to-end latency on actual hardware; (g) production deployment: start with FPGA acceleration for one venue, shadow-compare with CPU-only, then roll out

## Source Code

```cpp
// CPU side — DMA buffer reader for FPGA-parsed market data
#include <cstdint>
#include <cstring>
#include <atomic>
#include <x86intrin.h>

// Shared structure between FPGA and CPU (must match FPGA layout)
struct alignas(64) MarketDataUpdate {
  uint64_t timestamp_ns;
  uint32_t symbol_id;
  uint32_t side;       // 0=buy, 1=sell, 2=trade
  uint32_t price;      // fixed-point: 10^6
  uint32_t quantity;
  uint32_t flags;      // 0x1=imbalance, 0x2=VWAP_update, ...
  uint64_t seqno;
};

// Ring buffer in shared (DMA) memory
struct DmaRingBuffer {
  std::atomic<uint64_t> write_seqno;  // FPGA increments after each write
  std::atomic<uint64_t> read_seqno;   // CPU increments after each read
  MarketDataUpdate slots[4096];       // power of 2 for wrap
  uint64_t epoch_ns;                  // base timestamp
};

class FpgaReader {
  DmaRingBuffer* ring_;  // mmap'd from /dev/fpga_dma
public:
  int poll(MarketDataUpdate* out, int max_count) noexcept {
    uint64_t write = ring_->write_seqno.load(std::memory_order_acquire);
    uint64_t read  = ring_->read_seqno.load(std::memory_order_relaxed);
    int count = 0;
    while (read < write && count < max_count) {
      size_t idx = read % 4096;
      __builtin_prefetch(&ring_->slots[(idx + 1) % 4096], 0, 3); // software prefetch
      std::memcpy(&out[count], &ring_->slots[idx], sizeof(MarketDataUpdate));
      read++;
      count++;
    }
    ring_->read_seqno.store(read, std::memory_order_release);
    return count;
  }

  // Send order request to FPGA via MMIO register write
  void send_order(uint32_t symbol_id, uint32_t side, uint32_t price, 
                  uint32_t qty, uint64_t order_id) noexcept {
    // MMIO write to FPGA BAR0+offset
    uint64_t* reg = reinterpret_cast<uint64_t*>(0xFULL << 20); // example addr
    uint64_t cmd = (uint64_t(symbol_id) << 32) | (uint64_t(side) << 31) | price;
    _mm_sfence(); // ensure previous stores are visible
    *reg = cmd;
    *reinterpret_cast<uint64_t*>(reinterpret_cast<char*>(reg) + 8) = qty;
    *reinterpret_cast<uint64_t*>(reinterpret_cast<char*>(reg) + 16) = order_id;
  }
};
```

## Usage

```c
// FPGA-side (Verilog) — ring buffer write interface
module dma_writer #(
    parameter DATA_WIDTH = 512,
    parameter DEPTH = 4096
) (
    input clk, rst,
    input [DATA_WIDTH-1:0] data_in,
    input valid_in,
    output reg [63:0] write_seqno,
    // AXI DMA interface
    output [63:0] dma_addr,
    output [DATA_WIDTH-1:0] dma_data,
    output dma_valid,
    input dma_ready
);
    reg [11:0] wr_ptr;
    always @(posedge clk) begin
        if (valid_in && dma_ready) begin
            wr_ptr <= wr_ptr + 1;
            write_seqno <= write_seqno + 1;
        end
    end
    // Map wr_ptr to DMA address (pre-registered buffer base + offset)
    assign dma_addr = DMA_BASE + (wr_ptr * DATA_WIDTH / 8);
    assign dma_data = data_in;
    assign dma_valid = valid_in;
endmodule

// Build:
// vitis -s FPGA_ACCEL -t hw -f hls/fpga_feed_parser.cpp
// Program FPGA:
// xbutil program --device 0000:01:00.1 --user build/parser.xclbin
```

## Staff+ Perspective

> **Staff+ Perspective**: The biggest trap in FPGA co-design is underestimating the handoff overhead. At the firm, we accelerated our market data parser to 200ns wire-to-buffer — excellent. But the CPU polling the DMA buffer added 500ns + the strategy processing added 2µs. The FPGA accelerated portion was only 10% of the total path. The key insight: accelerated components must dominate the latency budget for the effort to be worthwhile. Our second FPGA project — an FPGA order gateway — was more impactful: it reduced the order-send path from 8µs (kernel TCP stack) to <1µs (FPGA-to-NIC via direct MAC). The DMA buffer management lesson: you need to pre-register DMA buffers with the IOMMU during driver initialization. If you don't, every DMA transfer requires an IOMMU page table walk — adding 500ns-2µs. Pre-register 1GB of DMA buffers at startup. CXL was promising in early access (Alveo X3522, 2026) — it allowed us to share the symbol table between FPGA and CPU without explicit DMA. The symbol table was 8MB (500K symbols × 16 bytes) and we updated it from the CPU — the FPGA saw the updates cache-coherently within ~500ns. For production: our co-design split was feed parsing on FPGA, order sending on FPGA, strategy and risk on CPU. The FPGA communicated with the CPU via two DMA ring buffers (one for market data updates, one for fill notifications) and one MMIO register for order requests. End-to-end latency: 2.5µs from FPGA packet receive to CPU strategy decision to FPGA order send. The CPU portion was only 800ns of that. The Handoff API was defined in a shared header file between the RTL and C++ teams — any change required both teams to approve. This was the hardest part of the co-design: two different engineering cultures (hardware vs software) agreeing on interfaces. We used Cocotb for unit testing the FPGA modules in Python, which helped bridge the gap.