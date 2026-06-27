---
type: reference
title: "P4 & Programmable Switches"
description: "P4_16 language for programming packet-processing pipelines in hardware. Tofino-based switches enable line-rate custom logic: market-data fan-out, latency measurement, order routing based on packet content."
tags: ["programmable-networking"]
timestamp: "2026-06-27T03:06:09.415Z"
phase: 6
phaseName: "Network Hardware"
category: "Network Hardware"
subcategory: "network-hardware"
language: "cpp"
artifact-id: "ZHFT_P4_SWITCHES"
---
## Key Learning Points

- P4_16 defines a protocol-independent packet forwarding plane; compiled to ASIC (Tofino) or software (BMv2, eBPF)
- Match-action tables: parser extracts headers, match on header fields, action executes on matched entries
- In-band telemetry writes per-hop latency directly into packet headers as it traverses the fabric
- HFT use case 1: market data fan-out — replicate a single input feed to multiple servers at line rate without CPU
- HFT use case 2: latency-based order routing — measure path latency in-band, route orders via the lowest-latency path
- HFT use case 3: packet filtering — drop unwanted symbol feeds, only forward selected instruments to the trading engine
- P4 program elements: parser (header extraction), ingress/egress match-action pipelines, deparser (packet reassembly)
- Tofino Native Architecture (TNA): P4 program on Intel Tofino ASIC with 12 stages of match-action logic

## Usage

```p4
// P4_16: simple market-data feed filter
#include <core.p4>
#include <v1model.p4>

header ethernet_t {
    bit<48> dst_addr;
    bit<48> src_addr;
    bit<16> ether_type;
}

header udp_t {
    bit<16> src_port;
    bit<16> dst_port;
    bit<16> length;
    bit<16> checksum;
}

// Custom market-data header (simplified)
header mdf_header_t {
    bit<16> symbol_id;
    bit<8>  msg_type;
    bit<32> sequence;
}

struct headers {
    ethernet_t     ethernet;
    udp_t          udp;
    mdf_header_t   mdf;
}

parser MyParser(packet_in packet, out headers hdr,
                inout metadata meta, inout standard_metadata_t sm) {
    state start {
        packet.extract(hdr.ethernet);
        packet.extract(hdr.udp);
        packet.extract(hdr.mdf);
        transition accept;
    }
}

control MyIngress(inout headers hdr, inout metadata meta,
                  inout standard_metadata_t sm) {
    // Drop packets for non-interesting symbols
    action drop() { mark_to_drop(sm); }
    table symbol_filter {
        key = { hdr.mdf.symbol_id : exact; }
        actions = { NoAction; drop; }
        size = 1024;
        default_action = drop;
    }
    apply { symbol_filter.apply(); }
}

// Fan-out replication: Tofino can replicate packets
// to multiple ports via multicast groups
control MyEgress(inout headers hdr, inout metadata meta,
                 inout standard_metadata_t sm) {
    apply { /* multicast replication happens here */ }
}
```

## Source Code

```cpp
// Example P4Runtime controller (in C++ using grpc)
// Program the symbol_filter table at runtime
// p4runtime_client --grpc-addr 10.0.0.1:9559 \
//   --table symbol_filter --match symbol_id:42 --action NoAction
```
