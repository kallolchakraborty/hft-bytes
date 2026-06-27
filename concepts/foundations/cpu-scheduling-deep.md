---
type: reference
title: "CPU Scheduling & Resource Partitioning for HFT"
description: "Deep dive into Linux CPU scheduling for HFT: SCHED_FIFO priority inversions, isolcpus vs cgroups/cpuset, NO_HZ_FULL RCU stall mitigation, idle state exit latencies per C-state, and deterministic thread placement for trading workloads."
tags: ["scheduling", "linux", "cpu", "real-time"]
difficulty: staff
timestamp: "2026-06-27T11:45:00.000Z"
phase: 1
phaseName: "Foundations"
category: "Foundations"
subcategory: "foundations"
language: "cpp"
artifact-id: "ZHFT_CPU_SCHEDULING"
---

## Key Learning Points

- **SCHED_FIFO vs SCHED_RR vs SCHED_OTHER**: SCHED_FIFO (real-time FIFO, priority 1-99) runs a thread until it blocks or yields — no time slicing; SCHED_RR adds a time quantum (100ms default) for round-robin among same-priority RT threads; SCHED_OTHER (CFS) is the default fair scheduler. For HFT polling threads: SCHED_FIFO with priority 99 (max). WARNING: a SCHED_FIFO thread stuck in an infinite loop locks the entire core — the kernel cannot preempt it. Always add a watchdog timer (`setitimer(ITIMER_REAL)`) that sends SIGALRM after N ms as a kill switch
- **SCHED_FIFO priority inversion**: a low-priority FIFO thread holding a lock is preempted by a medium-priority FIFO thread, blocking a high-priority thread that needs the same lock. The high-priority thread spins until the low-priority thread runs again — which may not happen if the medium-priority thread never blocks. Fix: use `SCHED_FIFO` for all trading threads with proper priority assignment; avoid locks between threads of different priorities; consider `pthread_mutexattr_setprotocol(PTHREAD_PRIO_INHERIT)` for mutexes shared across priority levels
- **Priority assignment hierarchy**: NIC interrupt handler (SCHED_FIFO priority 50-60), market data parser (SCHED_FIFO priority 49), order book builder (SCHED_FIFO priority 48), strategy (SCHED_FIFO priority 47), OMS (SCHED_FIFO priority 46), gateway (SCHED_FIFO priority 45), risk checks (SCHED_FIFO priority 44). Non-critical threads (logging, monitoring, health checks) use SCHED_OTHER. This ensures a data-processing pipeline can always preempt a downstream stage if backpressure builds
- **isolcpus**: kernel boot parameter that removes specified cores from the scheduler's load-balancing domain. Tasks running on isolated cores are never migrated by the kernel (unless explicitly `sched_setaffinity`). All interrupts, workqueues, and kernel threads are also excluded. Caveat: some kernel threads (e.g., `migration/N`, `watchdog/N`) still run on isolated cores unless further restricted. Verify with `ps -eo pid,comm,policy,rtprio,cpubind | grep -E '\[.*\]'` to catch kernel threads on isolated cores
- **cpuset (cgroup v1/v2)**: the alternative to `isolcpus`. Creates a partition of cores (`cpuset.cpus`) and optionally a memory node (`cpuset.mems`). With `cpuset.sched_load_balance=0`, the kernel won't load-balance within the partition. Unlike `isolcpus`, cpuset can be configured at runtime without reboot. HFT pattern: use `isolcpus` for boot-time isolation, then create a cpuset for the trading application with `cpus_exclusive` and `mem_exclusive` flags — this prevents any kernel thread from entering the trading cores
- **NO_HZ_FULL (adaptive ticks)**: disables the periodic timer tick on isolated cores — a core running a single SCHED_FIFO thread (or idle) receives zero timer interrupts. Benefits: eliminates ~1000 interrupts/sec per core (LOC: local timer interrupt). Caveats: (a) RCU callbacks never fire on the isolated core — must use `rcu_nocbs` to offload; (b) no `itimers` or `alarm()`; (c) `/proc/stat` counters become stale; (d) the kernel cannot detect soft lockups (`nosoftlockup` may be needed). Monitor RCU stalls with `echo 10 > /sys/module/rcupdate/parameters/rcu_cpu_stall_timeout`
- **RCU stall mitigation with nohz_full**: RCU (Read-Copy-Update) relies on quiescent states (context switches, user/kernel boundary) detected via the scheduler tick. With NO_HZ_FULL, the tick never fires, so RCU assumes the CPU is in an extended quiescent state and may declare a grace period without waiting — but if a kernel thread on the isolated core holds an RCU read lock, the grace period stalls. Mitigations: (a) `rcu_nocbs=2-63` (offload RCU callbacks to housekeeping cores); (b) `rcu_nocb_poll` (poll for callbacks instead of waiting for wakeup); (c) avoid running kernel threads on isolated cores (use cpuset with `cpus_exclusive`); (d) mount `/sys/kernel/debug/rcu/` and monitor `rcu_pending`
- **Idle state (C-state) exit latency**: when a logical core enters a deep C-state (C6, C7), the voltage rail to the core is gated — exit latency is 50-500µs. In HFT, a poll loop that calls `sched_yield()` or sleeps briefly may allow the core to enter C1E (~10µs exit) or C6 (~100µs). When the next market data packet arrives, the hardirq fires immediately but the core takes 10-100µs to wake up before any instruction executes. Fix: `processor.max_cstate=1 intel_idle.max_cstate=0` limits C-states to C1 (mwait) only, with ~1µs exit latency
- **Core partitioning for HFT workloads**: typical 24-core (48 HT) server partitioning: core 0-1: housekeeping (OS, ssh, monitoring); core 2-3: NIC IRQ + kernel networking; core 4-5: market data parser; core 6-7: order book; core 8-9: strategy 1; core 10-11: strategy 2; core 12-13: OMS; core 14-15: gateway; remaining cores: spare/overhead. Each pair is one physical core (2 HTs) — in production, disable HT or use only 1 HT per physical core for latency-critical tasks

## Usage

```cpp
// Set SCHED_FIFO priority 99 for current thread:
// sudo ./sched_setup

// Kernel boot parameters for HFT (add to GRUB_CMDLINE_LINUX):
// isolcpus=2-63 nohz_full=2-63 rcu_nocbs=2-63
// intel_idle.max_cstate=0 processor.max_cstate=1
// idle=poll rcu_nocb_pool
// Default: mitigations=off (disable Spectre/Meltdown mitigations)

// Verify isolation:
// cat /sys/devices/system/cpu/isolated
// cat /proc/interrupts | grep LOC   # isolated cores should show 0
// ps -eo pid,comm,cpubind | sort -k3 | uniq -c | sort -rn
```

## Source Code

```cpp
#include <cstdint>
#include <cstring>
#include <iostream>
#include <sched.h>
#include <pthread.h>
#include <thread>
#include <chrono>
#include <cerrno>
#include <unistd.h>
#include <sys/resource.h>

// -------------------------------------------------------------------
// Set current thread to SCHED_FIFO with given priority.
// Requires CAP_SYS_NICE or root.
// -------------------------------------------------------------------
bool set_realtime_priority(int priority, int policy = SCHED_FIFO) {
    struct sched_param param = {};
    param.sched_priority = priority;
    int rc = sched_setscheduler(0, policy, &param);
    if (rc != 0) {
        std::cerr << "sched_setscheduler failed: " << std::strerror(errno)
                  << " (try: sudo setcap cap_sys_nice=ep ./binary)\n";
        return false;
    }
    return true;
}

// -------------------------------------------------------------------
// Pin current thread to specific CPU core.
// -------------------------------------------------------------------
bool pin_to_core(int core_id) {
    cpu_set_t cpuset;
    CPU_ZERO(&cpuset);
    CPU_SET(core_id, &cpuset);
    int rc = pthread_setaffinity_np(pthread_self(), sizeof(cpu_set_t), &cpuset);
    if (rc != 0) {
        std::cerr << "pthread_setaffinity_np failed: " << std::strerror(errno) << "\n";
        return false;
    }
    return true;
}

// -------------------------------------------------------------------
// Query the current scheduling policy and priority.
// -------------------------------------------------------------------
void print_sched_info() {
    int policy;
    struct sched_param param = {};
    int rc = pthread_getschedparam(pthread_self(), &policy, &param);
    if (rc == 0) {
        const char* policy_name =
            (policy == SCHED_FIFO)  ? "SCHED_FIFO" :
            (policy == SCHED_RR)    ? "SCHED_RR"   :
            (policy == SCHED_OTHER) ? "SCHED_OTHER" : "unknown";
        std::cout << "Policy: " << policy_name
                  << ", Priority: " << param.sched_priority << "\n";
    }
}

int main() {
    // Pin to core 2, set RT priority 99
    if (!pin_to_core(2)) return 1;
    if (!set_realtime_priority(99, SCHED_FIFO)) return 1;
    print_sched_info();

    // Simulate a polling loop with watchdog
    // In production, setitimer(ITIMER_REAL) sends SIGALRM after N ms
    // as a deadman switch for stuck FIFO threads

    volatile bool running = true;
    uint64_t counter = 0;

    while (running) {
        // Polling work — this loop will never be preempted
        // by the kernel (SCHED_FIFO priority 99)
        counter++;

        // Yield point — voluntarily yield if no work
        if (counter % 1000000 == 0) {
            sched_yield();  // let same-priority siblings run
        }

        // Break after some iterations (safety)
        if (counter >= 10000000) running = false;
    }

    std::cout << "Done. Counter = " << counter << "\n";
    return 0;
}
```

## Staff+ Perspective

> **Staff+ Perspective**: The most dangerous HFT scheduling incident I've seen was a priority inversion that caused a 500ms trading halt. A low-priority SCHED_FIFO risk-check thread held a mutex while calculating VaR (1ms work). A medium-priority logging thread (also SCHED_FIFO) got scheduled and started writing a large log buffer to disk (blocked on I/O for 500ms). The high-priority market-data thread tried to acquire the same mutex and spun for 500ms. The fix: remove all shared locks between the risk and market-data threads (use lock-free state), and move all I/O (logging) to SCHED_OTHER threads. The isolcpus lesson: we initially used only `isolcpus` without `rcu_nocbs`, and after 3 weeks of uptime, a kernel RCU callback fired on an isolated core during a `kworker` migration, causing a 21-second RCU stall that panic'd the server. Adding `rcu_nocbs=all` and monitoring with a script that checked `cat /sys/devices/system/cpu/isolated` and alerted on any non-conforming process prevented recurrence. For C-states: we ran with `idle=poll` (never halt the core) for latency-critical threads — this consumes full power (~150W/core) but guarantees zero idle exit latency. The power bill was ~$200K/year extra but the latency improvement (3µs p99 reduction) was worth it for the flagship strategy.
