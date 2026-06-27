---
type: reference
title: "Hardware Telemetry & RAS"
description: "Performance counter pipeline (cycles, instructions, cache misses), Intel RDT (CMT/MBM) for cache occupancy and memory bandwidth monitoring, RAPL power capping, MCE (Machine Check Exception) handling, ECC error thresholding, and temperature telemetry via lm-sensors and ipmitool."
tags: ["performance", "operations"]
timestamp: "2026-06-27T03:50:00.000Z"
phase: 14
phaseName: "Monitoring & Security"
category: "Monitoring"
subcategory: "monitoring"
language: "cpp"
artifact-id: "ZHFT_HARDWARE_TELEMETRY"
---
## Key Learning Points

- Perf counter pipeline: collect `cycles`, `instructions`, `L1-dcache-load-misses`, `LLC-load-misses`, `branch-misses` per core every 1 second; feed into time-series DB (Prometheus/InfluxDB); alert on IPC < 2.0 or LLC miss rate > 1%
- Intel RDT (Resource Director Technology): CMT (Cache Monitoring Technology) tracks L3 cache occupancy per core/thread/cgroup; MBM (Memory Bandwidth Monitoring) tracks local/remote memory bandwidth; useful for detecting NUMA violations
- RAPL (Running Average Power Limit): limits package/DRAM power; domains: `package-0`, `dram`, `core`, `uncore`; read/write via MSR (`/dev/cpu/*/msr`); critical for controlling turbo frequency behavior in co-located HFT racks
- MCE handling: Machine Check Exceptions signal hardware errors (ECC corrected/uncorrected, bus errors, cache parity); `mcelog` daemon logs and thresholds; uncorrected MCEs trigger immediate failover
- ECC error tracking: corrected ECC errors indicate degrading DIMMs; alert on rate > 1 per hour per DIMM; schedule replacement before uncorrected error causes crash
- Temperature telemetry: `lm-sensors` for CPU/board temps, `ipmitool sdr` for chassis inlet/outlet temps; throttle frequency via RAPL if inlet > 35°C; alert on > 40°C

## Usage

```cpp
// Perf counter collection (C++ via perf_event_open)
struct PerfCounters {
    uint64_t cycles_, instructions_;
    uint64_t l1_misses_, llc_misses_;
    double ipc() const { return instructions_ / (double)cycles_; }
    double llc_miss_rate() const { return llc_misses_ / (double)cycles_; }

    void collect(int core) {
        // perf_event_open for PERF_COUNT_HW_CPU_CYCLES etc.
        // mmap the ring buffer, read counter values
        // Close event fd after read
    }
};

// RAPL power control
struct RAPL {
    enum Domain { PACKAGE, DRAM, CORE, UNCORE };
    void setLimit(Domain d, double watts) {
        int fd = open("/dev/cpu/0/msr", O_RDWR);
        uint64_t msr = msrAddress(d);
        uint64_t val = wattsToMSR(watts);
        pwrite(fd, &val, 8, msr);
        close(fd);
    }
};

// MCE monitoring thresholds
// corrected_errors/h: 0-1 = normal, 1-5 = monitor, >5 = replace DIMM
// uncorrected_errors: ANY = immediate failover + replace
```

## Source Code

```bash
# lm-sensors telemetry
# sensors -u | grep -E "(temp[0-9]_input|power[0-9]_average)"

# RAPL power reading (watts)
# for socket in /sys/class/powercap/intel-rapl/intel-rapl:*; do
#   echo "$(cat $socket/name): $(cat $socket/energy_uj) uJ"
# done

# ipmitool chassis temperature
# ipmitool sdr | grep -i temp
# ipmitool sensor get "CPU Temp" | grep "Sensor Reading"

# perf counter pipeline (one-liner per core)
# for core in $(seq 0 15); do
#   perf stat -C $core -e cycles,instructions,L1-dcache-load-misses,\
#     LLC-load-misses -a --sleep 1 --no-merge 2>&1
# done
```
