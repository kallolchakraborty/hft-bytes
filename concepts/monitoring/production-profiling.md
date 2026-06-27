---
type: reference
title: "Production Profiling"
description: "perf stat/record/report, flamegraphs, bpftrace one-liners for latency, USDT probes in trading applications, CPI analysis for front-end stalls."
tags: ["performance"]
difficulty: advanced
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
- **Profiling without disturbing production**: the cardinal rule — never profile a trading process at > 100 Hz sampling rate during market hours. Each `perf` sample triggers an NMI (Non-Maskable Interrupt) that pauses the CPU for ~1µs. At 100 Hz, this is 100µs/second of interruption — invisible in latency histograms. At 1000 Hz (recommended by many tutorials), it's 1ms/second of pause — visible as a 1-5% latency increase at p99. Safe rates: 49-99 Hz for production, 1000+ Hz for dedicated canary servers. Use `perf stat` (counting mode) instead of `perf record` (sampling mode) for continuous monitoring in production — counting mode reads PMU counters without interruption. For deep profiling: profile on a "canary" server that mirrors production but is not in the trading path
- **eBPF-based profiling overhead**: bpftrace and bcc tools are safe for production if used with: (a) single-attach probes (trace one PID, not all PIDs); (b) minimal printf in the probe handler; (c) aggregation in kernel (BPF maps) instead of per-event userspace output. Overhead budget: a bpftrace probe on a function entry/exit adds ~100ns per invocation. If the probe fires 1M times/second, that's 10% overhead — too much. Limit probes to rare events (context switches, syscalls) at < 1000 fires/second. For hot-path tracing (every market data message), use hardware counters or compile-in instrumentation (USDT probes) instead of dynamic bpftrace attachment. Benchmark: measure latency p99 with and without bpftrace attached — if p99 increases > 1%, the probe is too hot
- **Statistical profiling vs instrumentation**: statistical profiling (perf record -F 99) snapshots the call stack at regular intervals. It captures what the CPU is doing, not what it's waiting for. Instrumentation (USDT probes, DTrace) measures specific events (function entry/exit, packet received). For HFT: use both. Statistical profiling identifies hot functions (95% of CPU time in 3 functions — optimize those). Instrumentation measures critical path latency (tick-to-trade decomposed into stages). Statistical profiling adds < 1% overhead; instrumentation adds 1-10% depending on probe rate. Use statistical in production, instrumentation in staging/shadow mode
- **Off-CPU analysis**: HFT latency problems are often caused by not being on-CPU (waiting for I/O, scheduling, locks). `perf sched` records scheduler events: context switches, wakeups, migrations. Use `offcputime` from bcc to record stack traces when a thread is de-scheduled and the duration of the off-CPU period. Common off-CPU issues in HFT: (a) thread waiting on a mutex (contended lock in OMS); (b) thread blocked on a syscall (unexpected `read`/`write` in hot path); (c) thread migrated to another core (NUMA imbalance). Off-CPU time > 10µs per event in the hot path is a problem. Fix: remove locks (lock-free data structures), avoid syscalls (pre-allocated resources), pin threads to cores (isolcpus + taskset)
- **perf for flamegraph generation on live systems**: use folded stack format with `perf script` and `FlameGraph/stackcollapse-perf.pl`. On production: use `-F 99` (safe) and `--call-graph fp` (frame-pointer) or `--call-graph dwarf` (debug info). Frame-pointer is faster (no symbol lookup per sample) but requires `-fno-omit-frame-pointer` at compile time. Dwarf is more complete (captures inlined functions) but 2-5x overhead. For flamegraphs in production: compile with `-fno-omit-frame-pointer` and use frame-pointer unwinding. Run with `-F 99 -g --pid $PID -- sleep 60`. Generate flamegraph: `perf script | FlameGraph/stackcollapse-perf.pl | FlameGraph/flamegraph.pl > flame.svg`. For delta analysis: compare two flamegraphs side-by-side to see which functions regressed
- **Perf overhead measurement methodology**: before profiling any production process, measure the overhead. (a) run the trading application without profiler for 10 minutes — record p50/p99/p999 latency; (b) run with profiler attached for 10 minutes — record the same metrics; (c) the difference is the profiler overhead. If p99 increases > 1%, lower sampling rate or switch to counting mode. Publish the overhead measurement to the team so everyone knows the profiler's impact. For bpftrace: run `bpftrace -e 'tracepoint:sched:sched_switch { @[pid] = count(); }'` — this counts context switches per PID with < 1% overhead (aggregation in kernel, output every 5 seconds). Avoid bpftrace one-liners that `printf` per event (those go to userspace and have higher overhead)
- **When to use perf vs bpftrace vs gperftools vs instrumented profiling**: (a) `perf stat`: continuous monitoring in production (alert on IPC < 2.0, LLC misses > 5%). (b) `perf record` with flamegraphs: deep-dive investigation of CPU-bound bottlenecks (run on canary server, not live trading). (c) `bpftrace`: tracing kernel events on live systems — context switches, syscall latency, lock contention. (d) `gperftools` (Google CPU profiler): statistical profiler with zero-overhead sampling (SIGPROF at 100 Hz) — suitable for continuous profiling in production. (e) USDT probes: compile-time instrumentation for critical path latency — always-on, low overhead, ideal for tick-to-trade tracking. (f) `valgrind/callgrind`: never on production (100x slowdown) — only for deep analysis on a dedicated server

## Staff+ Perspective

> **Staff+ Perspective**: We learned the profiling overhead lesson the hard way — a junior engineer ran `perf record -F 1000` on the flagship MM server during market hours "to see what's happening with latency." The result: the sampling NMI interrupts added 50µs to every packet processing path, causing a 30% increase in p99 latency. The strategy missed 200 basis points that day. The engineer's flamegraph was beautiful, but the trading desk was furious. After that: (a) perf record above 99 Hz on production requires written approval from the head of engineering; (b) all profiling runs on dedicated canary servers first; (c) the overhead of any production profiling is measured and published before the session starts. For off-CPU analysis: we found a recurring 50µs latency spike every 30 seconds in our trading pipeline. After weeks of investigation with `offcputime`, we found it was a periodic 50ms NFS mount timeout — the monitoring system had mounted a network filesystem on the trading server for log collection. Any time the monitoring system tried to read a file, the NFS call blocked for 50ms. Fix: remove NFS mount, use local-only logging. The `perf sched` trace showed the exact thread and stack frame that was blocked. For USDT probes: we now compile all trading applications with DTRACE_PROBE macros at every critical path boundary (packet received, order book updated, order sent). This instrumentation is always-on, adds < 1ns per probe (zero-overhead when not in use), and allows us to trace any stage of the pipeline in production with `bpftrace -l 'usdt:/opt/app/trading:packet_received'`. It's the single most valuable profiling investment we've made.

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
