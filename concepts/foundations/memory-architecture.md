---
type: reference
title: "Memory Architecture for HFT"
description: "Deep dive into memory system architecture for HFT: NUMA-aware allocation strategies, memory bandwidth profiling with STREAM and MLC, page migration policies, transparent vs explicit huge pages, memory tiering (CXL-attached, Optane PMem), DDR vs HBM tradeoffs, and diagnosing memory bottlenecks."
tags: ["memory", "numa", "bandwidth", "profiling"]
difficulty: staff
timestamp: "2026-06-27T20:30:00.000Z"
phase: 1
phaseName: "Foundations"
category: "Foundations"
subcategory: "foundations"
language: "cpp"
artifact-id: "ZHFT_MEMORY_ARCHITECTURE"
---

## Key Learning Points

- **NUMA topology awareness**: every HFT system must be NUMA-aware from day one. A server has 2-4 NUMA nodes (sockets), each with local memory and PCIe slots. The golden rule: the NIC, the cores processing its traffic, and the memory buffers for that traffic must all reside on the same NUMA node. Cross-NUMA access adds 100-300ns latency and reduces memory bandwidth by 30-50%. Query NUMA topology with `lstopo` or `numactl --hardware`. Pin processes/threads to specific cores and allocate memory on the local NUMA node via `numactl --membind=N --cpunodebind=N`. Monitor cross-NUMA traffic with `perf stat -e uncore_imc/ cas_count_read/` or Intel PCM
- **Memory bandwidth profiling**: memory bandwidth is a shared resource per NUMA node. Two cores on the same socket saturating memory bandwidth will compete, increasing latency for both. Use STREAM benchmark (array copy/scale/add/triad) to measure peak bandwidth per socket. Intel MLC (Memory Latency Checker) measures bandwidth under different read/write ratios and idle latency. For HFT: the critical metric is not peak bandwidth but bandwidth under latency-sensitive loads — how much bandwidth can a core consume before its latency degrades? Rule of thumb: keep per-core bandwidth under 60% of the socket's peak to avoid queuing delays. Monitor via `perf stat -e uncore_imc/data_reads,uncore_imc/data_writes/`
- **Page migration policies**: Linux can transparently migrate pages between NUMA nodes (AutoNUMA). For HFT, disable AutoNUMA (`numactl --no-autonuma` or `echo 0 > /proc/sys/kernel/numa_balancing`). AutoNUMA scanning causes page faults and TLB shootdowns, adding 50-200µs jitter. If a process is correctly pinned with `numactl --membind`, AutoNUMA is unnecessary. Use explicit page migration only during initialization: `mbind()` with `MPOL_BIND` to force allocation on a specific node. For large DMA buffers: allocate with `mmap` and `MAP_HUGETLB | MAP_FIXED` on each NUMA node separately
- **Transparent huge pages vs explicit huge pages**: THP (Transparent Huge Pages) automatically promotes 4K pages to 2MB pages. This reduces TLB misses but causes khugepaged jitter (CPU spikes of 5-20ms during compaction). For latency-sensitive trading, disable THP (`echo never > /sys/kernel/mm/transparent_hugepage/enabled`). Use explicit huge pages (hugetlbfs) instead — allocate at boot with `hugepagesz=2M hugepages=2048` or at runtime via `/proc/sys/vm/nr_hugepages`. Explicit huge pages: (a) never cause runtime compaction; (b) are locked in memory (no swapping); (c) reduce TLB misses deterministically. Per-process huge pages: mount hugetlbfs and `mmap` from it. For shared memory (IPC between feed handler and strategy), use huge pages to reduce TLB misses in critical path
- **Memory tiering (CXL-attached / Optane)**: modern servers support tiered memory — fast DDR near the CPU paired with slower but higher-capacity CXL-attached memory or Optane PMem. Use `numactl -H` to see memory tiers. Linux 6.0+ supports memory tiering via `demote` and `promote` policies. For HFT: hot data (order books, symbol tables) must reside in DDR (fast tier). Cold data (historical logs, configuration) can reside in CXL memory. Use `mbind` with `MPOL_BIND` to pin hot pages to DDR NUMA node. Monitor demotions/promotions with `perf stat -e node_load_misses` — if a hot page is demoted to slow tier, latency spikes
- **DDR vs HBM tradeoffs**: DDR5-6400 delivers ~50 GB/s per socket, latency ~80ns. HBM2e (attached via Xeon Max or AMD MI300) delivers ~1.2 TB/s but only available on specific platforms, latency ~150ns. For trading: HBM's enormous bandwidth benefits workloads that scan large data structures (ML models, volatility surface). DDR's lower latency benefits pointer-chasing workloads (order book with linked lists). Hybrid approach: HBM for bandwidth-bound compute (vol surface update), DDR for latency-critical hot path (order book lookup). Use `numactl` to allocate different regions to different memory tiers
- **Memory latency benchmarking methodology**: measure memory latency per layer: L1 = ~1ns, L2 = ~4ns, L3 = ~12-15ns, local DDR = ~80ns, remote DDR = ~120ns, CXL-attached = ~200ns. Use lmbench (`lat_mem_rd`) for latency at different working set sizes — this shows the latency cliff as the working set exceeds each cache level. Pointer-chasing latency (linked list traversal) is worse than sequential access — a linked list that doesn't fit in L2 can be 10x slower than an array of the same size. For HFT hot paths: use flat arrays (or custom pool allocators) instead of linked structures. Use `perf mem --ldlat-thresh=80` to profile memory access latency per instruction
- **False sharing detection for memory performance**: false sharing occurs when two cores write to different fields on the same cache line — the cache coherency protocol (MESI) invalidates the line on each write, causing 100ns+ of latency per miss. Detect with: `perf c2c record -p $PID -- sleep 60` then `perf c2c report`. Fix: pad shared structs to cache-line boundaries (`alignas(64)`), or split hot fields into separate cache lines. For trading: a common false sharing source is two order book levels (bid[0] and ask[0]) on the same cache line — separate them by 64 bytes
- **Memory allocator for trading**: glibc `malloc` is not designed for HFT — it uses locks and may call `brk()` or `mmap()` on allocation, causing jitter. Use a thread-local arena allocator: pre-allocate large pools (`mmap` with `MAP_POPULATE`) and slice them with a lock-free free-list. jemalloc and tcmalloc are better than glibc but still have occasional mmap calls. For the hot path: use a bump allocator (no free, just reset) — the trading path allocates per-event and never frees until a reset boundary

## Source Code

```cpp
// NUMA-aware memory allocation in C++
#include <cstdint>
#include <cstring>
#include <numa.h>
#include <numaif.h>
#include <sys/mman.h>

class NumaAllocator {
public:
  static constexpr size_t kHugePageSize = 2UL << 20; // 2MB

  // Allocate NUMA-local huge pages for a ring buffer
  static void* alloc_hugepages_local(size_t bytes, int numa_node) {
    // Ensure THP is disabled — use explicit huge pages
    int fd = open("/mnt/hugepages", O_CREAT | O_RDWR, 0755);
    if (fd < 0) return nullptr;

    void* ptr = mmap(nullptr, bytes, PROT_READ | PROT_WRITE,
                     MAP_SHARED | MAP_HUGETLB, fd, 0);
    close(fd);
    if (ptr == MAP_FAILED) return nullptr;

    // Bind to specific NUMA node
    struct bitmask* mask = numa_allocate_cpumask();
    numa_bitmask_setbit(mask, numa_node);
    if (mbind(ptr, bytes, MPOL_BIND, mask->maskp, mask->size, 0) < 0) {
      munmap(ptr, bytes);
      numa_free_cpumask(mask);
      return nullptr;
    }
    numa_free_cpumask(mask);
    return ptr;
  }

  // Bump allocator for hot path (no free, reset at batch boundary)
  struct BumpAllocator {
    char* start;
    char* current;
    size_t capacity;

    BumpAllocator(size_t cap) {
      capacity = cap;
      start = static_cast<char*>(mmap(nullptr, capacity,
        PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS | MAP_HUGETLB,
        -1, 0));
      current = start;
    }

    void* alloc(size_t n) {
      char* ptr = current;
      current += n;
      return ptr;
    }

    void reset() { current = start; }
  };
};

// Memory bandwidth profiling with STREAM-like loop
void stream_benchmark(size_t n, double* a, double* b, double* c) {
  // Copy
  for (size_t i = 0; i < n; i++) c[i] = a[i];
  // Scale
  for (size_t i = 0; i < n; i++) b[i] = 2.0 * c[i];
  // Add
  for (size_t i = 0; i < n; i++) c[i] = a[i] + b[i];
  // Triad
  for (size_t i = 0; i < n; i++) a[i] = b[i] + 2.0 * c[i];
}
```

## Usage

```bash
# Check NUMA topology
lstopo --of png > numa_topology.png
numactl --hardware

# Run STREAM benchmark (link with -DSTREAM_ARRAY_SIZE=200000000)
gcc -O3 -march=native -DSTREAM_ARRAY_SIZE=200000000 stream.c -o stream
numactl --membind=0 --cpunodebind=0 ./stream

# Intel MLC
./mlc --bandwidth_matrix  # shows cross-socket bandwidth
./mlc --latency_matrix    # shows cross-socket latency

# Profile memory access per PID
perf mem record -p $(pgrep trading_app) --ldlat-thresh=80 -- sleep 10
perf mem report

# Check NUMA balancing status
cat /proc/sys/kernel/numa_balancing
# 0 = disabled, 1 = enabled (disable for HFT)

# Check THP status
cat /sys/kernel/mm/transparent_hugepage/enabled
# Should show: always [never]
```

## Staff+ Perspective

> **Staff+ Perspective**: The most expensive memory mistake I've seen is ignoring NUMA. A junior engineer on my team provisioned a new server with 2 sockets and 32 cores. The NIC was on socket 0, the feed handler was pinned to socket 1 (because those cores were "free"), and the memory buffers were allocated on socket 0 (default allocation). Every packet from the NIC took a cross-NUMA hop for DMA (socket 0 → PCIe → socket 1), plus the memory read was cross-socket (socket 1 → socket 0). Total: 400ns added per packet. Fix: move the feed handler to socket 0. Latency dropped from 12µs to 8.5µs. For memory bandwidth: during high volatility, our market data parsing slowed from 500k pkts/sec/core to 200k pkts/sec/core. The cause? Two feed handler processes on cores sharing the same memory controller were saturating the DDR4 bandwidth (both doing `memcpy` on 1KB packets). We split them across the two sockets and bandwidth contention disappeared. The huge page lesson: we had always used THP. It worked fine until a kernel upgrade triggered khugepaged compaction during market hours — a 15ms latency spike that caused our strategy to timeout on a venue. After switching to explicit huge pages, the compaction jitter vanished. Now every server boots with `hugepagesz=2M hugepages=8192` and `transparent_hugepage=never`. The false sharing story: our order book hot path had bid and ask top-of-book in the same struct. Two different cores updated the bid price and ask price simultaneously (in response to a market data update). The cache line bounced between cores 50,000 times per second, adding 100ns per update. Separating them with `alignas(64)` saved 5µs of latency per market data message.