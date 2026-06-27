---
type: reference
title: "eBPF/XDP for HFT"
description: "XDP early packet filtering, eBPF redirect to userspace, custom TCP stack bypass via AF_XDP sockets, kernel compile tuning, and bpftrace for production tracing."
tags: ["performance"]
difficulty: staff
timestamp: "2026-06-27T03:20:00.000Z"
phase: 5
phaseName: "Kernel Bypass & Protocols"
category: "Kernel Bypass"
subcategory: "kernel-bypass"
language: "cpp"
artifact-id: "ZHFT_EBPF_XDP"
---
## Key Learning Points

- XDP (eXpress Data Path) attaches BPF program to NIC driver before `skb` allocation; packets processed at wire rate with action `XDP_PASS`, `XDP_DROP`, `XDP_TX`, `XDP_REDIRECT`
- For HFT: use `XDP_REDIRECT` to steer market-data flows directly to a userspace AF_XDP socket, bypassing the kernel network stack entirely
- AF_XDP socket: zero-copy ring buffer (UMEM) shared between kernel and userspace; eliminates `recvmsg` syscall overhead
- eBPF map (BPF_MAP_TYPE_HASH/ARRAY) for per-flow packet filters: drop non-market-data traffic at the NIC level, reducing CPU load
- Kernel compile tuning: `CONFIG_XDP_SOCKETS=y`, `CONFIG_BPF=y`, tune `net.core.busy_poll` and `net.core.busy_read` for AF_XDP; isolate cores via `isolcpus` kernel param
- bpftrace for production tracing: trace XDP drop/miss/redirect events, measure packet processing latency, track UMEM ring underruns
- Key metric: AF_XDP zero-copy adds ~50-100 ns vs raw DPDK but avoids dedicated kernel-bypass driver complexity; hybrid approach for non-HFT flows
- XDP program must be simple (~200 instructions max for inlining); use tail calls for complex multi-stage filters

## Usage

```cpp
// AF_XDP socket setup (simplified)
struct XDPSocket {
    int fd_;
    struct xsk_ring_cons* rx_;
    struct xsk_ring_prod* tx_;
    struct xsk_umem* umem_;
    void* umem_buf_;  // pre-allocated huge-page buffer

    void setup(const char* ifname, uint32_t queue_id) {
        // 1. Open XSK socket via xsk_socket__create
        // 2. Bind to ifname/queue_id
        // 3. Fill UMEM with buffer addresses
        // 4. eBPF map entry: redirect queue -> fd
    }

    // Zero-copy receive (no syscall)
    int recv_pkts(std::span<packet> out) {
        unsigned int idx_rx = 0;
        unsigned int rcvd = xsk_ring_cons__peek(rx_, batch, &idx_rx);
        if (!rcvd) return 0;
        for (unsigned int i = 0; i < rcvd; ++i) {
            auto* desc = xsk_ring_cons__rx_desc(rx_, idx_rx + i);
            out[i] = {umem_buf_ + desc->addr, desc->len};
        }
        xsk_ring_cons__release(rx_, rcvd);
        return rcvd;
    }
};

// XDP program (C, compiled to BPF bytecode)
// SEC("xdp") int filter(struct xdp_md* ctx) {
//     // Parse eth->ip->udp header
//     // Check destination port for market-data range
//     if (is_market_data_port) return XDP_REDIRECT;
//     return XDP_PASS;  // non-MD traffic goes to kernel
// }
```

## Source Code

```cpp
// bpftrace one-liners for HFT XDP monitoring
// XDP drop/miss/redirect:
//   bpftrace -e 'kprobe:xdp:* { @[probe] = count(); }'
// AF_XDP UMEM underrun:
//   bpftrace -e 'tracepoint:xsk:xdp_*_umem { @[args->xdp]++; }'
// Per-queue packet distribution:
//   bpftrace -e 'kprobe:ixgbe_clean_rx_irq { @queue = args->queue; }'

// Kernel boot params for AF_XDP HFT:
//   isolcpus=2-15 nohz_full=2-15 rcu_nocbs=2-15
//   default_hugepagesz=1G hugepagesz=1G hugepages=4
```
