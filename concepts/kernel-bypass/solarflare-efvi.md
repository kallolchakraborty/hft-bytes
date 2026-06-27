---
type: reference
title: "Solarflare ef_vi & Onload"
description: "ef_vi API for zero-copy packet IO, vi_resource allocation, ef_event completion model, tc-to-tc bypass, Onload TCP acceleration stack, OpenOnload multicast, filter programming, and Solarflare vs Mellanox comparison for HFT."
tags: ["performance"]
difficulty: staff
timestamp: "2026-06-27T03:40:00.000Z"
phase: 5
phaseName: "Kernel Bypass & Protocols"
category: "Kernel Bypass"
subcategory: "kernel-bypass"
language: "cpp"
artifact-id: "ZHFT_SOLARFLARE_EFVI"
---
## Key Learning Points

- ef_vi (efabless Virtual Interface): direct userspace access to Solarflare NIC hardware without syscalls; each `vi_resource` maps to a NIC hardware RX/TX queue; pinned to one core
- Packet IO: `ef_vi_receive()` polls RX descriptor ring in userspace-mapped memory; `ef_vi_transmit()` posts TX descriptors directly; all without kernel involvement
- ef_event: event-driven completion model; `ef_eventq_get` returns batched completion events; alternatives: polling (lower latency, higher CPU) vs event-driven (balanced)
- tc-to-tc bypass: Solarflare's "transfer from tc" feature copies receive data directly into a transmit descriptor ring buffer; eliminates userspace packet copy for low-latency order forwarding
- Filter programming: `ioctl(SIOCSFFLAG)` or `ef_vi_filter_add()` to steer specific flows (UDP port, IP, VLAN) to a given VI; hardware RSS independent per VI
- Onload TCP acceleration: user-space TCP stack that intercepts `send/recv` via `LD_PRELOAD`; bypasses kernel TCP entirely; full socket API compatibility
- OpenOnload for multicast: Onload's multicast acceleration eliminates kernel `recvmsg` for market data over UDP multicast; reduces latency from ~5-10 us to ~1-2 us per packet
- Limitations: Solarflare ef_vi is proprietary (requires Solarflare NICs); Mellanox VMA (Messaging Accelerator) is the competing solution for ConnectX adapters; VMA uses `libvma` for similar acceleration

## Usage

```cpp
// ef_vi receive path (zero-copy polling)
struct EFVIReceiver {
    ef_vi vi_;
    ef_driver_handle driver_;
    int n_rx_ = 0;
    ef_addr rx_dma_buf_;   // DMA buffer for receive
    void* rx_buf_;          // userspace mapping

    void setup(const char* ifname, int queue) {
        ef_vi_set_name(ifname, &vi_);
        // Allocate VI resource
        ef_vi_alloc_from_rxq(&vi_, driver_, &vi_, -1, queue, rx_dma_buf_);
        // Map DMA buffers
        ef_vi_receive_init(&vi_, rx_dma_buf_, rx_buf_, buf_size, n_rx_);
    }

    int recv_pkts() {
        // Poll RX descriptor
        int idx = ef_vi_receive(&vi_, &rx_dma_buf_);
        if (idx < 0) return 0;
        // Packet data is at rx_buf_ + ef_vi_receive_copy(&vi_, idx)
        return 1;
    }
};

// tc-to-tc forward: receive then transmit without copy
void forward_pkt(ef_vi* rx_vi, ef_vi* tx_vi, void* buf, int len) {
    // Use ef_vi_transfer_to_tc to move RX buf to TX queue
    // No memcpy needed — hardware scatter-gather
    ef_vi_transmit_copy(tx_vi, buf, len);
}
```

## Source Code

```cpp
// Onload usage: LD_PRELOAD for TCP acceleration
// LD_PRELOAD=libonload.so ./trading_gateway --session cme
// OpenOnload for multicast market data:
// LD_PRELOAD=libonload.so EF_TCP_MULTICAST_PROXY=1 ./feed_handler

// ef_vi filter: steer CME MDP traffic to dedicated VI
// struct ef_filter_spec spec;
// ef_filter_spec_init(&spec, EF_FILTER_FLAGS_NONE);
// spec.ether_type = 0x0800;     // IPv4
// spec.udp.dst_port = 5100;     // CME MDP port range
// spec.vlan_id = 0x123;         // optional VLAN filter
// ef_vi_filter_add(&vi, &spec, rx_dma_buf_);

// Solarflare ef_vi latency: ~0.5-1us per packet (vs ~3-5us via kernel)
```
