---
type: reference
title: "Capacity Planning"
description: "Sizing cores, memory, and network bandwidth for HFT systems. Throughput math: packets/sec per feed, orders/sec peak, NUMA-aware allocation. Core budgeting, NIC queue distribution, and headroom targets."
tags: ["performance"]
difficulty: advanced
timestamp: "2026-06-27T03:06:09.405Z"
phase: 1
phaseName: "Foundations"
category: "Foundations"
subcategory: "foundations"
language: "cpp"
artifact-id: "ZHFT_CAPACITY_PLANNING"
---
## Key Learning Points

- Market data throughput: one equity options feed (e.g., OPRA) peaks at 10+ million packets/sec during volatile periods
- Order-to-trade ratio: HFT firms typically send 50-200 cancels/modifies per executed trade; peak order rates exceed 10k orders/sec per instrument
- Core budgeting: reserve one core per data feed parser, one per order-book reconstruction (per symbol group), one per strategy instance, one per OMS/gateway instance
- NIC queue distribution: RSS (Receive-Side Scaling) distributes flows across RX queues; each queue pinned to a dedicated core
- NUMA awareness: NIC must be on the same NUMA node as the cores processing its traffic; cross-NUMA latency adds 100-300 ns
- Memory sizing: order book per symbol is ~1-2 KB (LOB depth of 10-20 levels); 10,000 symbols ~ 20 MB for books + overhead
- Network bandwidth: one 100 Gbps link per feed pair; two links (primary + backup) per exchange; 20-40 Gbps typical utilisation with 2:1 headroom
- Headroom rule: never exceed 70% sustained CPU utilisation; the remaining 30% absorbs volatility spikes without packet-loss

## Usage

```cpp
// Capacity calculation helpers
struct CapacityMath {
    // Packets per second from line rate
    static double maxPktPerSec(double lineRateGbps, double avgPktSizeBytes) {
        // lineRateGbps * 1e9 / (8 * (pktSize + 20))  -- 20 bytes for ethernet framing
        return lineRateGbps * 1e9 / (8.0 * (avgPktSizeBytes + 20.0));
    }

    // Cores needed for a load at target utilisation
    static int coresNeeded(double pktPerSec, double pktPerSecPerCore, double maxUtil) {
        // pktPerSecPerCore: measured empirically (~2M pkts/sec per core for simple parsing)
        return static_cast<int>(std::ceil(pktPerSec / (pktPerSecPerCore * maxUtil)));
    }

    // Memory for N symbols with M levels of depth
    static size_t lobMemory(size_t symbols, size_t depth) {
        // Each level: price(8) + qty(4) + orderCount(4) + padding = ~32 bytes
        // Book: bid + ask sides * depth * 32 bytes * symbols
        return 2 * depth * 32 * symbols;
    }
};

// Example: OPRA peak = 12M pkts/s, core capacity = 2M pkts/s
// cores_needed = ceil(12_000_000 / (2_000_000 * 0.7)) = 9 cores
// LOB memory for 5000 symbols at depth 20 = 2 * 20 * 32 * 5000 = 6.4 MB
```

## Source Code

```cpp
// NIC RSS queue pinning via ethtool
// ethtool -L eth0 combined 8    # 8 RX queues
// ethtool -X eth0 hkey <key>    # set RSS hash key
// # Pin IRQs to cores
// for irq in /proc/irq/*/smp_affinity; do
//   echo 1 > $irq               # pin to core 0
// done
```
