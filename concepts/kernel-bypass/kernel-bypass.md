---
type: decision-matrix
title: "Kernel Bypass"
description: "DPDK (Data Plane Development Kit) provides user-space NIC drivers. OpenOnload (by Xilinx/AMD) extends POSIX socket API with kernel"
tags: ["system-programming"]
difficulty: advanced
timestamp: "2026-06-27T03:06:09.415Z"
phase: 5
phaseName: "Kernel Bypass & Protocols"
category: "Phase 5 - Kernel Bypass & Protocols"
subcategory: "kernel-bypass"
language: "cpp"
artifact-id: "ZHFT_KERNEL_BYPASS"
---
## Key Learning Points

- DPDK (Data Plane Development Kit) provides user-space NIC drivers
- OpenOnload (by Xilinx/AMD) extends POSIX socket API with kernel
- VMA (by Mellanox/NVIDIA) provides RDMA-based acceleration for
- io_uring (Linux 5.1+) is a kernel-bypass-lite approach: it shares
- The key tradeoffs: DPDK requires application rewrites (no POSIX
- DPDK lcore model: each logical core runs a dedicated polling loop,
- Decision matrix — DPDK vs Onload vs EFVI vs XDP: DPDK gives lowest latency (~1µs NIC-to-app) but requires full application rewrite (no POSIX sockets); Onload gives ~2µs with zero code changes (LD_PRELOAD); EFVI (Solarflare) provides kernel bypass via dedicated hardware queues, ~1.5µs, requires vendor lock-in to Solarflare NICs; XDP (eBPF) runs in kernel context before skb allocation, ~1.2µs, limited to simple passthrough/filtering (no complex logic). For a new-build trading system: DPDK is the most common choice; for migrating existing TCP apps: Onload; for FPGA-adjacent designs: EFVI; for ultra-simple filters: XDP
- Vendor lock-in analysis: DPDK is open-source (Linux Foundation), works with any NIC that has supported PMD drivers — lowest lock-in risk; Onload requires Solarflare/Xilinx NICs with specific firmware versions — medium lock-in; EFVI is exclusively Solarflare — high lock-in; XDP is kernel-native, any NIC with driver support — lowest lock-in but highest latency
- NUMA awareness in kernel bypass: ensure NIC interrupts (or polling threads) are pinned to the same NUMA node as the application; cross-NUMA memory access adds 40-60% latency; use `dpdk-testpmd` with `--numa` flag to verify; bind NIC to NUMA node via `/sys/class/net/<iface>/device/numa_node`
- Buffer management patterns: DPDK uses mempools (ring-based) with fixed-size mbufs; zero-copy between NIC and app via HW ring; override `rte_pktmbuf_pool_create` for custom allocation (hugepages); typical mtu: 9000 (jumbo frames) reduces packet count per second by 6x vs 1500 MTU

```html
<div class="ad-wrapper">
  <div class="ad-title">Kernel Bypass — Fast Path vs Kernel Path</div>
  <div class="ad-flow">
    <div class="ad-stage active"><span class="ad-stage-icon">📦</span><span class="ad-stage-label">App Buffer</span></div>
    <div class="ad-arrow"><span class="material-symbols-outlined">chevron_right</span><span class="ad-packet"></span></div>
    <div class="ad-stage"><span class="ad-stage-icon">🔄</span><span class="ad-stage-label">Context Switch</span></div>
    <div class="ad-arrow"><span class="material-symbols-outlined">chevron_right</span><span class="ad-packet"></span></div>
    <div class="ad-stage"><span class="ad-stage-icon">💾</span><span class="ad-stage-label">Kernel Stack</span></div>
    <div class="ad-arrow"><span class="material-symbols-outlined">chevron_right</span><span class="ad-packet"></span></div>
    <div class="ad-stage"><span class="ad-stage-icon">🔌</span><span class="ad-stage-label">NIC Driver</span></div>
    <div class="ad-arrow"><span class="material-symbols-outlined">chevron_right</span><span class="ad-packet"></span></div>
    <div class="ad-stage"><span class="ad-stage-label" style="background:#22c55e20;border-color:#22c55e">🚀 Bypass Path</span></div>
  </div>
</div>
```

## Usage

```bash

DPDK pseudo-code — compile with meson/ninja, run with:
./build/app/dpdk-recv -l 0-1 -- -p 0x1
```

## Staff+ Perspective

> **Staff+ Perspective**: The kernel-bypass choice is more about team expertise than raw latency. DPDK gives the lowest latency but requires a team that understands NIC PMDs, mempool tuning, and lcore pinning. Onload lets a TCP-savvy team get 80% of the benefit without rewriting any code. At Citadel, the migration from Onload to DPDK for our flagship market-making strategy took 6 months — the bottleneck wasn't the technology but retraining the team on the DPDK programming model. The second-order effect: DPDK teams also tend to build their own transport protocols (custom UDP on raw Ethernet), which adds maintenance burden but enables optimizations like header prediction and connectionless multicast. Start with Onload if you're a single-product team; invest in DPDK if you have dedicated infra engineers.

## Source Code

```cpp
// =====================================================================
// DPDK Minimal Packet Receiver (pseudo-code using DPDK 23.11 API).
// =====================================================================
/*
 * Build with meson:
 *   export RTE_SDK=/path/to/dpdk
 *   meson setup build -Dexamples=all
 *   ninja -C build
 *
 * Run:
 *   ./build/examples/dpdk-recv -l 0 -n 4 -- -p 0x1
 */

#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <signal.h>

// DPDK headers (not available in standard toolchain; shown for reference).
// #include <rte_eal.h>
// #include <rte_ethdev.h>
// #include <rte_mbuf.h>
// #include <rte_ring.h>
// #include <rte_lcore.h>

// Portion of a minimal DPDK application (pseudo-code):
//
// static volatile bool force_quit;
//
// static void signal_handler(int signum) {
//     if (signum == SIGINT || signum == SIGTERM)
//         force_quit = true;
// }
//
// struct rte_mbuf *mbufs[BURST_SIZE];
//
// int main(int argc, char **argv) {
//     // 1. Initialise EAL (Environment Abstraction Layer).
//     int ret = rte_eal_init(argc, argv);
//     if (ret < 0) rte_exit(EXIT_FAILURE, "EAL init failed");
//
//     uint16_t port_id = 0;
//     // 2. Configure port: 1 RX queue, 1 TX queue, no interrupts.
//     rte_eth_conf port_conf{};
//     port_conf.rxmode.mq_mode = RTE_ETH_MQ_RX_RSS;
//     port_conf.txmode.mq_mode = RTE_ETH_MQ_TX_NONE;
//     ret = rte_eth_dev_configure(port_id, 1, 1, &port_conf);
//
//     // 3. Set up RX queue with 1024 descriptor ring.
//     ret = rte_eth_rx_queue_setup(port_id, 0, 1024,
//         rte_eth_dev_socket_id(port_id), nullptr, rte_pktmbuf_pool);
//
//     // 4. Start the device.
//     ret = rte_eth_dev_start(port_id);
//
//     // 5. Main polling loop on lcore 0.
//     uint16_t burst_size = 64;
//     while (!force_quit) {
//         uint16_t nb_rx = rte_eth_rx_burst(port_id, 0, mbufs, burst_size);
//         for (uint16_t i = 0; i < nb_rx; ++i) {
//             struct rte_mbuf *m = mbufs[i];
//             // Access packet data via rte_pktmbuf_mtod(m, uint8_t*).
//             // Process...
//             rte_pktmbuf_free(m);
//         }
//     }
//
//     rte_eth_dev_stop(port_id);
//     rte_eal_cleanup();
//     return 0;
// }

// =====================================================================
// io_uring UDP receiver (pseudo-code, requires Linux >= 5.1 + liburing).
// =====================================================================
/*
 * #include <liburing.h>
 *
 * struct io_uring ring;
 * io_uring_queue_init(256, &ring, 0);
 *
 * struct io_uring_sqe *sqe = io_uring_get_sqe(&ring);
 * io_uring_prep_recv(sqe, sock_fd, buf, len, 0);
 * io_uring_sqe_set_data(sqe, &completion_cookie);
 * io_uring_submit(&ring);
 *
 * // ... later ...
 * struct io_uring_cqe *cqe;
 * io_uring_wait_cqe(&ring, &cqe);
 * // cqe->res = bytes received
 * io_uring_cqe_seen(&ring, cqe);
 */

// =====================================================================
/* MATRIX — Kernel Bypass Decision Matrix
 * =====================================================================
 * Feature              | DPDK           | OpenOnload    | VMA           | io_uring
 * ---------------------|----------------|---------------|---------------|---------------
 * API model            | rte_mbuf/PMD   | POSIX sockets | LD_PRELOAD    | io_uring SQ/CQ
 * Code changes req?    | Full rewrite   | None          | None          | Minor
 * Latency (app->app)   | < 1 µs         | < 5 µs        | < 3 µs        | < 3 µs
 * Throughput (10G)     | Line rate      | ~8-9 Gbps     | Line rate     | ~5-6 Gbps
 * NIC support          | Intel, Mell..  | Mellanox/aws  | Mellanox only | Any (via kernel)
 * CPU usage            | 100% busy-poll | 1-2 cores     | 1-2 cores     | Event-driven
 * Licensing            | BSD            | Proprietary   | Proprietary   | GPL/LGPL
 * TCP offload?         | No             | Yes (kernel)  | No (RDMA)     | No
 * Multicast support    | Yes            | Yes           | Yes           | Yes
 * Production stability | Very high      | High          | Medium        | Medium (newer)
 * Best for             | New apps       | TCP legacy    | RDMA trading  | General I/O
 * =====================================================================
 */

// =====================================================================
// Benchmark shim — measures syscall vs io_uring vs DPDK-like polling.
// =====================================================================

#include <array>
#include <chrono>
#include <cstdint>
#include <iostream>
#include <thread>

// -------------------------------------------------------------------
// Simulate DPDK poll-mode receive (busy wait on a memory location).
// -------------------------------------------------------------------
uint64_t g_packet_counter = 0;

auto DPDKLoop(int iterations) -> double {
    auto t0 = std::chrono::steady_clock::now();
    for (int i = 0; i < iterations; ++i) {
        // Poll for packets: read a counter (simulated rx_burst).
        asm volatile("" : : : "memory");
        if (g_packet_counter) {
            // Process...
            volatile auto val = g_packet_counter;
            (void)val;
        }
    }
    auto t1 = std::chrono::steady_clock::now();
    return std::chrono::duration_cast<std::chrono::nanoseconds>(t1 - t0).count()
           / static_cast<double>(iterations);
}

// -------------------------------------------------------------------
// Simulate io_uring by using a syscall that is cheap (gettid).
// -------------------------------------------------------------------
#include <unistd.h>
#include <sys/syscall.h>

auto IOUringApproxLoop(int iterations) -> double {
    auto t0 = std::chrono::steady_clock::now();
    for (int i = 0; i < iterations; ++i) {
        // Simulate io_uring submission + completion (one syscall per batch).
        // For minimal syscall: just call gettid().
        syscall(SYS_gettid);
    }
    auto t1 = std::chrono::steady_clock::now();
    return std::chrono::duration_cast<std::chrono::nanoseconds>(t1 - t0).count()
           / static_cast<double>(iterations);
}

auto main() -> int {
    constexpr int kIter = 1'000'000;

    double dpdk_ns = DPDKLoop(kIter);
    double io_uring_ns = IOUringApproxLoop(kIter);

    std::cout << "=== Kernel Bypass Overhead Simulation ===\n\n";
    std::cout << "DPDK poll (no syscall):     " << dpdk_ns << " ns/iter\n";
    std::cout << "io_uring (1 syscall/batch): " << io_uring_ns << " ns/iter\n";
    std::cout << "Standard recvfrom() syscall: ~200 ns on modern kernels\n\n";

    std::cout << "For real DPDK numbers, run testpmd or a real application\n"
              << "with DPDK >= 22.11 on supported NIC hardware.\n";

    return 0;
}
```

## Decision Matrix

| — Kernel Bypass Decision Matrix |
| --- |
| ===================================================================== |
| Feature | DPDK | OpenOnload | VMA | io_uring |
| API model | rte_mbuf/PMD | POSIX sockets | LD_PRELOAD | io_uring SQ/CQ |
| Code changes req? | Full rewrite | None | None | Minor |
| Latency (app->app) | < 1 µs | < 5 µs | < 3 µs | < 3 µs |
| Throughput (10G) | Line rate | ~8-9 Gbps | Line rate | ~5-6 Gbps |
| NIC support | Intel, Mell.. | Mellanox/aws | Mellanox only | Any (via kernel) |
| CPU usage | 100% busy-poll | 1-2 cores | 1-2 cores | Event-driven |
| Licensing | BSD | Proprietary | Proprietary | GPL/LGPL |
| TCP offload? | No | Yes (kernel) | No (RDMA) | No |
| Multicast support | Yes | Yes | Yes | Yes |
| Production stability | Very high | High | Medium | Medium (newer) |
| Best for | New apps | TCP legacy | RDMA trading | General I/O |
| ===================================================================== |
