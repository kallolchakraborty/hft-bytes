---
type: reference
title: "FPGA Intro"
description: "Logic cells = LUT (lookup table) + flip-flop → any combinatorial + register. DSP slices: hardened multiply-accumulate (MAC) — 18x27 multiplier"
tags: ["fpga"]
difficulty: intermediate
timestamp: "2026-06-27T03:06:09.445Z"
phase: 13
phaseName: "FPGA & Hardware"
category: "Phase 13 - FPGA & Hardware"
subcategory: "fpga"
language: "cpp"
artifact-id: "ZHFT_FPGA_INTRO"
---
## Key Learning Points

- Logic cells = LUT (lookup table) + flip-flop → any combinatorial + register
- DSP slices: hardened multiply-accumulate (MAC) — 18x27 multiplier
- BRAM: block RAM (36Kb per block), distributed RAM (LUT-based, smaller)
- Routing fabric: programmable interconnects (dominant delay in modern FPGAs)
- Pipeline stages: trade latency for clock speed (deeper pipeline = faster Fmax)
- Clock domains: crossing requires synchronizers (metastability)
- Xilinx Vivado vs Intel Quartus: toolchain differences
- HLS (High-Level Synthesis): C++ → RTL, 60-80% of hand-coded Verilog perf

## Usage

// Verilog: UDP packet filter
// HLS C++: market data parser skeleton

## Source Code

```cpp
// --------------------------------------------------------------------
// Verilog: UDP Packet Filter (illustrative)

// tradeoff: match-action pipeline vs CPU-like branch

/*
module udp_filter (
    input wire clk, rst_n,
    input wire [511:0] packet_data,    // 64B at 512b = 1 beat
    input wire         data_valid,
    output reg         filter_match,
    output reg [31:0]  src_ip,
    output reg [15:0]  src_port,
    output reg [15:0]  dst_port
);

    // UDP header: src_port(16) | dst_port(16) | len(16) | cksum(16)
    // Parse at fixed offset (14B Ethernet + 20B IP header = 34B)
    // tradeoff: hardcoded offset vs flexible parser

    localparam UDP_HEADER_OFFSET = 34 * 8;  // 34 bytes → 272 bits

    always @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            filter_match <= 1'b0;
        end else if (data_valid) begin
            src_port <= packet_data[UDP_HEADER_OFFSET +: 16];
            dst_port <= packet_data[UDP_HEADER_OFFSET + 16 +: 16];

            // Pass filter if dst_port == 9000 (NASDAQ ITCH port)
            filter_match <= (packet_data[UDP_HEADER_OFFSET + 16 +: 16] == 16'd9000);
        end
    end
endmodule
 */

// --------------------------------------------------------------------
// HLS C++: Market Data Parser Skeleton

// Synthesized with Vitis HLS / Vivado HLS
// tradeoff: HLS vs Verilog — development speed (10x faster) vs resource
// control (pragmas needed for pipelining)

#include <cstdint>

// Interface: AXI4-Stream (axis)
// pragma: pipeline II=1 (initiation interval = 1 clock cycle)
void market_data_parser(
    volatile uint64_t* in_data,   // AXI stream input (512-bit = 8x64)
    volatile uint64_t* out_book,  // output order book update
    int* volume
) {
#pragma HLS INTERFACE axis port=in_data
#pragma HLS INTERFACE axis port=out_book
#pragma HLS PIPELINE II=1

    static uint64_t buffer;
    static int state = 0;

    // Simple ITCH message decode (simplified)
    uint64_t word = *in_data;
    // tradeoff: single-cycle decode vs multi-cycle for complex messages
    // Fmax target: 322MHz on Alveo U250

    switch (state) {
        case 0:  // message type
            buffer = word;
            state = 1;
            break;
        case 1:  // price/size
            // word[47:0] = price (mantissa), word[63:48] = qty
            out_book[0] = (word & 0xFFFFFFFFFFFF) | (buffer << 48);
            *volume += (word >> 48) & 0xFFFF;
            state = 0;
            break;
    }
}
```
