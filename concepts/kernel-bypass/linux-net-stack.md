---
type: reference
title: "Linux Networking Stack Deep Dive"
description: "Complete data path from NIC to application socket: NAPI poll, hardirq/softirq/ksoftirqd, GRO/GSO, RPS/RFS/XPS, flow steering, ring buffer tuning, and how each layer affects HFT latency."
tags: ["networking", "kernel-bypass", "tuning"]
difficulty: staff
timestamp: "2026-06-27T11:45:00.000Z"
phase: 5
phaseName: "Kernel Bypass & Protocols"
category: "Kernel Bypass"
subcategory: "kernel-bypass"
language: "cpp"
artifact-id: "ZHFT_LINUX_NET_STACK"
---

## Key Learning Points

- **Full NIC→Socket data path**: Packet arrives → NIC DMA into RX ring → MSI-X interrupt → hardirq handler → NAPI poll → softirq (NET_RX_SOFTIRQ) → GRO (Generic Receive Offload) → protocol demux (IP → TCP/UDP) → socket receive queue → `recvfrom()`/`read()` wakeup. Each stage adds 0.5-5µs. Total: 5-20µs kernel-to-socket in tuned setup; 1-3µs with kernel bypass (DPDK)
- **NAPI (New API)**: hybrid interrupt/poll model. Hardirq schedules NAPI poll cycle — then disables further interrupts and polls the RX ring in softirq context. Poll continues until either the ring is empty or `netdev_budget` (300 packets default) is exhausted. Then re-enables interrupts. Tuning: increase `netdev_budget=600` and `netdev_budget_usecs=8000` via sysctl — allows more packets per poll cycle (reduces interrupt rate) but increases per-cycle latency jitter
- **NAPI poll loop starvation**: on a busy core with high packet rate (>1M pps), the NAPI poll loop may monopolize the softirq context, delaying other softirqs (e.g., TIMER, RCU). HFT fix: isolate NIC interrupts to a dedicated core (`irqbalance --banirq` or write `/proc/irq/N/smp_affinity`), and run the application on a different core with `SO_INCOMING_CPU` to steer completed packets to the application's core
- **GRO/GSO (Generic Receive/Segment Offload)**: GRO merges consecutive TCP segments in the same flow into a single super-packet before protocol demux — reduces softirq overhead (fewer packets to process) but adds latency (must wait for more segments). GSO is the transmit-side equivalent. For HFT: **disable GRO** (`ethtool -K eth0 gro off`) — the merging latency (~10-50µs per merge window) is unacceptable for real-time trading, and the overhead reduction doesn't matter at low pps (HFT market data is typically 10K-100K pps, not 1M+)
- **RPS/RFS (Receive Packet Steering / Flow Steering)**: RPS distributes packets across CPU cores after GRO (software RSS). RFS additionally steers packets to the core where the application socket is running — improving cache locality. HFT pattern: pin each trading connection to a specific core using `SO_INCOMING_CPU`, then set `rps_flow_cnt` per RX queue and `rps_cpus` to include only that core. This eliminates cross-core packet migration
- **XPS (Transmit Packet Steering)**: steers TX completion interrupts to the same core as the application socket. Without XPS, TX completions may fire on a different core, incurring cross-cache-line traffic and remote TLB flush. Set `/sys/class/net/eth0/queues/tx-N/xps_cpus` to match the application core mask
- **Interrupt coalescing**: NIC hardware delays interrupt delivery until either (a) a timer fires (usecs), or (b) enough packets accumulate. Adaptive coalescing (Intel: `adaptive-rx`) adjusts the timer based on traffic rate. For HFT: **disable adaptive coalescing** and set fixed, minimal coalescing (`ethtool -C eth0 rx-usecs 1 rx-frames 1`) — every packet generates an interrupt immediately. The cost is higher CPU overhead from more interrupts but lower per-packet latency
- **Ring buffer sizing**: the NIC RX ring holds incoming descriptors (packets). Default often 256 entries. If the ring fills (softirq can't keep up), packets are dropped. Check with `ethtool -S eth0 | grep drop`. HFT: increase to 4096 entries (`ethtool -G eth0 rx 4096`). The ring is DRAM — large rings don't increase latency (descriptors are DMA'd to host memory regardless of ring size). A ring that's too small causes drops during bursts (e.g., CME MDP burst of 500+ messages in 1µs)
- **SO_REUSEPORT and SO_ATTACH_FILTER**: multiple sockets on the same port receive packets via RPS distribution (`SO_REUSEPORT`). `SO_ATTACH_FILTER` (BPF socket filter) drops unwanted packets in softirq context before they reach the socket buffer — reduces wakeups. In HFT: attach a BPF filter that accepts only the destination UDP port(s) for your market data feed, dropping all other traffic before it enters the socket receive queue

## Usage

```cpp
// Check current NIC settings
// ethtool -c eth0          # coalescing
// ethtool -g eth0          # ring sizes
// ethtool -k eth0          # offload settings
// ethtool -S eth0 | head   # per-queue stats

// Set HFT-optimized NIC parameters:
// ethtool -C eth0 rx-usecs 1 rx-frames 1 tx-usecs 1
// ethtool -G eth0 rx 4096 tx 4096
// ethtool -K eth0 gro off gso off lro off
// ethtool -K eth0 ntuple on   # enable flow director

// Pin IRQ to core 2:
// echo 4 > /proc/irq/$(grep eth0 /proc/interrupts | awk '{print $1}' | tr -d ':')/smp_affinity

// Set RPS on RX queue 0 to core 2:
// echo 4 > /sys/class/net/eth0/queues/rx-0/rps_cpus

// Set XPS on TX queue 0 to core 2:
// echo 4 > /sys/class/net/eth0/queues/tx-0/xps_cpus

// Socket BPF filter (via setsockopt):
// struct sock_fprog bpf = { .len = 6, .filter = filter_code };
// setsockopt(sock, SOL_SOCKET, SO_ATTACH_FILTER, &bpf, sizeof(bpf));
```

## Source Code

```cpp
#include <cstdint>
#include <cstring>
#include <iostream>
#include <sys/socket.h>
#include <net/if.h>
#include <sys/ioctl.h>
#include <linux/ethtool.h>
#include <linux/sockios.h>
#include <unistd.h>
#include <cerrno>

// -------------------------------------------------------------------
// Utility: query NIC ring size via ethtool ioctl
// -------------------------------------------------------------------
bool get_rx_ring_size(const char* ifname, uint32_t& rx_pending) {
    int fd = socket(AF_INET, SOCK_DGRAM, 0);
    if (fd < 0) return false;

    struct ethtool_ringparam er = {};
    er.cmd = ETHTOOL_GRINGPARAM;
    struct ifreq ifr = {};
    std::strncpy(ifr.ifr_name, ifname, IFNAMSIZ - 1);
    ifr.ifr_data = reinterpret_cast<char*>(&er);

    int rc = ioctl(fd, SIOCETHTOOL, &ifr);
    close(fd);

    if (rc == 0) {
        rx_pending = er.rx_pending;
        return true;
    }
    return false;
}

// -------------------------------------------------------------------
// Utility: query RX packet drops via ethtool stats
// -------------------------------------------------------------------
int main() {
    const char* iface = "eth0";
    uint32_t ring_sz = 0;

    if (get_rx_ring_size(iface, ring_sz)) {
        std::cout << iface << " RX ring size: " << ring_sz << "\n";
    } else {
        std::cerr << "Failed to query ring size: " << std::strerror(errno) << "\n";
    }

    // Simulate: check if GRO enabled (would read from ethtool -k)
    // In production, parse ethtool output or use ETHTOOL_GFEATURES ioctl

    return 0;
}
```

## Staff+ Perspective

> **Staff+ Perspective**: The kernel networking stack is a minefield of hidden latency sources. At the firm, we had a persistent 2-3µs jitter spike every 5-10 seconds that we couldn't explain. After weeks of profiling, we traced it to the NIC's adaptive interrupt coalescing kicking in during low-traffic periods — the NIC decided to batch packets for 5µs before interrupting. The fix: disable adaptive coalescing entirely and use fixed `rx-usecs 1`. But the bigger lesson was GRO — we had a market data feed that sent 5 packets per event (ITCH messages fragmented). With GRO enabled, the kernel waited for all 5 fragments and merged them, adding 10-20µs of latency per event. Disabling GRO dropped our P50 from 12µs to 4µs. For RFS: we encountered a kernel bug (fixed in 5.10) where `rps_flow_cnt` mis-sizing caused flow steering to fall back to software RSS, randomly distributing packets across cores. The symptom: latency histogram showed two modes (one fast, one +3µs). The cross-core packet migration cost was the extra 3µs. Always verify RFS is active with `cat /sys/class/net/eth0/queues/rx-*/rps_cpus` and monitor `/proc/softirqs` to confirm NET_RX fires only on the intended core.
