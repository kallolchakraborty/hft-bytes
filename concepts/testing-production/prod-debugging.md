---
type: reference
title: "Production Debugging Tooling for HFT"
description: "GDB attached to live trading processes, core dump analysis for HFT crashes, rr record/replay for deterministic debugging of order book events, strace/ltrace for syscall latency profiling, crash telemetry pipelines with breakpad/crashpad."
tags: ["testing"]
difficulty: staff
timestamp: "2026-06-27T04:00:00.000Z"
phase: 15
phaseName: "Testing & Production"
category: "Testing"
subcategory: "testing"
language: "bash"
artifact-id: "ZHFT_PROD_DEBUGGING"
---
## Key Learning Points

- GDB on live HFT processes: `gdb -p <pid>` attaches in read-only mode; can inspect current order book state, position aggregates, sequence numbers, but cannot modify execution state; use `p` to print strategy variables, `info threads` to list all threads, `bt` for backtrace of stuck thread
- Core dump analysis: configure kernel to capture cores on crash (`ulimit -c unlimited`; `sysctl kernel.core_pattern`); enable minidumps (Google breakpad) for production with sensitive data stripping; analyze with `gdb /path/to/binary core` + `bt full` + `frame N` → identify exact line of crash
- rr (record/replay): `rr record /opt/hft/strategy --config prod` → deterministic replay of the exact execution; reproduce heisenbugs that disappear under debugger; `rr replay` jumps forward/backward with `reverse-continue` / `reverse-next`
- strace/ltrace: `strace -e network -p <pid>` shows all syscalls with timestamps; filter for `recvmsg`, `sendto`, `writev` to measure kernel-bypass fallback paths; `strace -T -p <pid>` adds syscall duration; `ltrace -e malloc+free` for heap profiling
- GDB scripting for automated crash triage: `set pagination off` + `bt full` + `info registers` → pipe to analysis script that classifies crash type (null ptr, segfault, assertion, corrupted book)

## Usage

```bash
# Attach to live strategy (read-only)
gdb -p $(pgrep -x strategy)

# In GDB shell:
(gdb) p order_book->total_buy_qty
(gdb) info threads
(gdb) thread apply all bt

# Capture core dump with breakpad
# Set in /etc/sysctl.d/99-core.conf:
# kernel.core_pattern = /var/crash/core.%e.%p.%h.%t
# fs.suid_dumpable = 2
# ulimit -c unlimited in init script

# rr record session
rr record /opt/hft/bin/strategy --config prod
# rr replay
rr replay

# strace syscall latency profiling
strace -e trace=network -T -p $(pgrep market-data) -o /tmp/md_syscalls.log
# Lines show: sendto(3, ..., 64) = 64 <0.000042>  ← 42µs syscall
```

## Source Code

```gdb
# GDB triage script: dump crash context to file
define dump-crash
    set pagination off
    set logging file /var/crash/triage_$arg0.txt
    set logging on
    bt full
    info registers
    info threads
    x/20gx $rsp
    set logging off
end

# Usage: gdb -batch -x triage.gdb -p $(pgrep strategy)
# Or on core dump: gdb -batch -x triage.gdb /opt/hft/bin/strategy core.12345

# Breakpad signal handler: catches SIGSEGV/SIGABRT, writes minidump
# /var/crash/minidumps/*.dmp → analyzed with minidump_stackwalk
```
