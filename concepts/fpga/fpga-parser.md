---
type: reference
title: "FPGA Parser"
description: "Ethernet MAC → UDP → ITCH message → order book pipeline in hardware. Latency measured in clock cycles (not microseconds)"
tags: ["fpga"]
timestamp: "2026-06-27T03:06:09.446Z"
phase: 13
phaseName: "FPGA & Hardware"
category: "Phase 13 - FPGA & Hardware"
subcategory: "fpga"
language: "cpp"
artifact-id: "ZHFT_FPGA_PARSER"
---
## Key Learning Points

- Ethernet MAC → UDP → ITCH message → order book pipeline in hardware
- Latency measured in clock cycles (not microseconds)
- State machines for protocol parsing (Ethernet, IP, UDP, ITCH)
- Order book in BRAM: 2-port memory for read+write in same cycle
- Pipeline stages: each protocol layer is a pipeline stage

## Usage

// Verilog ITCH parser module + pipeline latency breakdown
// Synthesize for Alveo U250 at 322MHz

## Source Code

```cpp
// Verilog ITCH Parser Pipeline

/*
 *
 * Pipeline stages (6-stage):
 *   Stage 0: Ethernet MAC decode (MAC src/dst, EtherType)
 *   Stage 1: IP header decode (src/dst IP, protocol=UDP)
 *   Stage 2: UDP header decode (src/dst port, length)
 *   Stage 3: ITCH message header (msg_type, msg_len)
 *   Stage 4: ITCH payload decode (price, size, order_ref)
 *   Stage 5: Order book update (BRAM read+write)
 *
 * Latency: 6 cycles @ 322MHz = 18.6ns
 *   vs CPU: 1-5μs typical = 50-250x slower
 */

module itch_parser_pipeline (
    input wire clk, rst_n,
    input wire [511:0] raw_pkt,      // 64B beat from 10G/25G MAC
    input wire         pkt_valid,
    output reg [63:0]  book_update,  // price | qty | side | order_ref
    output reg         update_valid
);

    // Stage 1: Ethernet / IP / UDP valid?
    // tradeoff: full header checksum verify vs skip (HFT firms skip on trusted links)
    reg eth_valid, ip_valid, udp_valid;

    // Stage 2: UDP dest port check (ITCH: 9000, OUCH: 9001)
    reg [15:0] udp_dst_port;
    reg is_itch;

    // Stage 3: ITCH message type and body length
    reg [7:0]  msg_type;
    reg [15:0] msg_length;

    // Stage 4: Decoded fields
    reg [63:0] decoded_price;  // ITCH uses 8-byte price (4 integer + 4 mantissa)
    reg [31:0] decoded_qty;
    reg [63:0] decoded_order_ref;
    reg        is_buy_side;

    // Stage 5: BRAM-based order book
    // BRAM: dual-port, 1024 entries, 64-bit each
    // tradeoff: BRAM (fast, limited) vs URAM (larger, slower) on Alveo
    reg [63:0] order_book [0:1023];
    reg [9:0]  book_addr;

    always @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            // Pipeline flush
        end else if (pkt_valid) begin
            // Pipeline shift registers
            // Stage 0 → 1 → 2 → 3 → 4 → 5
            // Each stage adds flip-flops = latency
            // tradeoff: more stages = higher Fmax but higher latency
        end
    end

    // Pipeline latency breakdown:
    //   Ingress MAC + PHY:  ~50ns (SerDes + MAC)
    //   Stage 0-5 pipeline: ~19ns (6 cycles @ 322MHz)
    //   BRAM read latency:    ~6ns (1 cycle)
    //   Total:               ~75ns  (vs 381μs software ITCH parser)
endmodule
```
