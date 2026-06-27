---
type: reference
title: "FPGA Order Gen"
description: "FIX/OUCH encoding: binary vs ASCII (OUCH is binary → faster). Sequence number management: incrementing per-session counter"
tags: ["fpga", "order-types"]
difficulty: advanced
timestamp: "2026-06-27T03:06:09.445Z"
phase: 13
phaseName: "FPGA & Hardware"
category: "Phase 13 - FPGA & Hardware"
subcategory: "fpga"
language: "cpp"
artifact-id: "ZHFT_FPGA_ORDER_GEN"
---
## Key Learning Points

- FIX/OUCH encoding: binary vs ASCII (OUCH is binary → faster)
- Sequence number management: incrementing per-session counter
- CRC computation: CRC-16 for FIX, CRC-32C for Ethernet
- Heartbeat timer: periodic keepalive when no orders
- Order state machine: New→Acked→Filled|Canceled|Rejected

## Usage

// Verilog FIX encoder + order state machine

## Source Code

```cpp
// --------------------------------------------------------------------
// Verilog FIX Encoder (simplified — NASDAQ OUCH 4.1 is binary)

/*
 *
 * OUCH message types:
 *   0x01 = Add Order (12 bytes payload)
 *   0x02 = Cancel (2 bytes payload)
 *   0x03 = Replace (10 bytes payload)
 *
 * FIX over FPGA:
 *   Most HFT firms use OUCH (NASDAQ) or binary FIX (CME MDP 3.0)
 *   ASCII FIX has variable-length overhead → hard in hardware
 *   tradeoff: ASCII FIX (market standard) vs binary OUCH (lower latency)
 */

module ouch_encoder (
    input wire clk, rst_n,
    // Order interface
    input wire [7:0]  msg_type,     // 0x01=add, 0x02=cancel, 0x03=replace
    input wire [63:0] order_ref,
    input wire [31:0] quantity,
    input wire [63:0] price,
    input wire        side,         // 0=buy, 1=sell
    input wire        order_valid,
    // Encoded output to MAC
    output reg [511:0] tx_data,
    output reg         tx_valid
);

    // Sequence number (per session)
    reg [31:0] seqno;
    reg [31:0] next_seqno;

    always @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            seqno <= 32'd0;
            tx_valid <= 1'b0;
        end else if (order_valid) begin
            seqno <= next_seqno;
            // Build OUCH packet:
            // [msg_type(1) | seqno(4) | order_ref(8) | qty(4) | price(8) | side(1)]
            tx_data[7:0]   <= msg_type;
            tx_data[39:8]  <= seqno;       // 32-bit seqno
            tx_data[103:40] <= order_ref;  // 64-bit order ref
            tx_data[135:104] <= quantity;
            tx_data[199:136] <= price;     // 64-bit price
            tx_data[200]    <= side;
            tx_valid <= 1'b1;
        end else begin
            tx_valid <= 1'b0;
            // Heartbeat timer (not shown)
        end
    end

    // CRC-16 for FIX (polynomial 0x8005)
    // tradeoff: parallel CRC (1 cycle) vs LFSR (N cycles)
    // Parallel CRC: pre-computed XOR tree, 4-5 LUT levels
    function [15:0] crc16(input [511:0] data);
        // synthesized XOR tree for CRC-16/XMODEM
        // tradeoff: DSP slices vs LUTs for CRC
        crc16 = 16'h0000;
    endfunction

    // Order state machine
    localparam IDLE       = 3'd0;
    localparam SENT       = 3'd1;
    localparam ACK_PEND   = 3'd2;
    localparam ACKED      = 3'd3;
    localparam FILL_PART  = 3'd4;
    localparam FILL_FULL  = 3'd5;
    localparam CANCEL_SENT = 3'd6;

    reg [2:0] order_state;
    // State machine transitions on incoming ACK/REJ/FILL from exchange
    // tradeoff: full state machine vs simple (missing edge cases = bugs)
endmodule
```
