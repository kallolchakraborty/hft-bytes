---
type: reference
title: "Production Profiling"
description: "perf stat/record/report, flamegraphs, bpftrace one-liners for latency, USDT probes in trading applications, CPI analysis for front-end stalls."
tags: ["performance"]
timestamp: "2026-06-27T03:06:09.440Z"
phase: 14
phaseName: "Monitoring & Security"
category: "Monitoring & Security"
subcategory: "monitoring"
language: "cpp"
artifact-id: "ZHFT_PRODUCTION_PROFILING"
---
## Key Learning Points

- perf stat identifies top-level bottlenecks: cycles, instructions, cache misses, branch mispredictions, stalled cycles
- perf record / report call-graph profiles identify hot functions; use --call-graph dwarf for full stack traces
- Flamegraphs visualise CPU time per call path; svg output enables drill-down on hot frames
- bpftrace provides low-overhead one-liners: trace syscall latency, scheduler wakeups, context switches
- USDT probes embedded in your trading app enable dtrace/bpftrace instrumentation without recompilation
- CPI (cycles-per-instruction) analysis: > 2.0 indicates front-end stalls; > 3.0 indicates cache miss-bound
- Cache miss rate per function via perf c2c (false sharing detection)
- Profiling in production: sampling rate of 99 Hz (perf) is safe; avoid frame-pointers on modern GCC

## Usage

```cpp
// USDT probe for bpftrace
#include <sys/sdt.h>

void handlePacket(const char* data, size_t len) {
    DTRACE_PROBE2(hft_app, packet_received, data, len);
    // ... processing ...
    DTRACE_PROBE1(hft_app, packet_done, getpid());
}
```

```bash
# bpftrace: trace syscall latency in the trading PID
bpftrace -e 'tracepoint:syscalls:sys_enter_* /pid == 12345/ {
    @start[tid] = nsecs;
}
tracepoint:syscalls:sys_exit_* /@start[tid]/ {
    @us[tid] = hist((nsecs - @start[tid]) / 1000);
    delete(@start[tid]);
}'

# perf: CPU profile at 99 Hz, generate flamegraph
perf record -F 99 -p $(pgrep trading_app) -g -- sleep 60
perf script | stackcollapse-perf.pl | flamegraph.pl > flame.svg

# perf stat: quick hardware counters
perf stat -e cycles,instructions,cache-misses,branch-misses \
         -p $(pgrep trading_app) sleep 10
```

## Source Code

```cpp
// RDTSC-based in-process profiling
static inline uint64_t rdtscp() {
    uint32_t lo, hi;
    asm volatile("rdtscp" : "=a"(lo), "=d"(hi) :: "ecx");
    return ((uint64_t)hi << 32) | lo;
}

struct ScopeTimer {
    const char* name;
    uint64_t start = rdtscp();
    ~ScopeTimer() {
        uint64_t elapsed = rdtscp() - start;
        static thread_local FILE* log = fopen("profile.csv", "a");
        fprintf(log, "%s,%lu\n", name, elapsed);
    }
};
```
