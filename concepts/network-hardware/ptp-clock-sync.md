---
type: reference
title: "PTP & Hardware Clock Sync"
description: "Precision Time Protocol (IEEE 1588) provides sub-microsecond clock synchronisation across trading servers. Hardware timestamping, boundary clocks, phc2sys, and ptp4l tuning for HFT."
tags: ["clock-synchronization"]
timestamp: "2026-06-27T03:06:09.415Z"
phase: 6
phaseName: "Network Hardware"
category: "Network Hardware"
subcategory: "network-hardware"
language: "cpp"
artifact-id: "ZHFT_PTP_CLOCK_SYNC"
---
## Key Learning Points

- PTP (IEEE 1588-2008, aka 1588v2) achieves < 100 ns accuracy with hardware timestamping on modern NICs
- Ordinary Clock (OC) is a single-port PTP node; Boundary Clock (BC) is multi-port with transparent forwarding
- Transparent Clock (TC) measures residence time and corrects for switch latency in the PTP message
- Hardware timestamping is critical: software timestamping adds jitter of 10-50 us; hardware is sub-100 ns
- phc2sys synchronises the system clock to a PTP hardware clock (PHC) via kernel adjtimex
- ptp4l implements the PTP protocol; key options: -2 (layer 2), --step_threshold for leap adjustments
- Clock servo discipline: PI controller with proportional/integral gains tuned to network asymmetry
- GPS-disciplined Grandmaster (e.g., Trimble, Meinberg) provides primary reference; NTP backup for holdover

## Usage

```cpp
// Hardware timestamp via SIOCSHWTSTAMP (Linux)
#include <linux/net_tstamp.h>
#include <sys/ioctl.h>
#include <net/if.h>

int enableHwTimestamp(int sockfd, const char* iface) {
    struct ifreq ifr = {};
    struct hwtstamp_config cfg = {};
    strncpy(ifr.ifr_name, iface, sizeof(ifr.ifr_name) - 1);

    cfg.tx_type = HWTSTAMP_TX_ON;
    cfg.rx_filter = HWTSTAMP_FILTER_PTP_V2_EVENT;
    ifr.ifr_data = (void*)&cfg;

    if (ioctl(sockfd, SIOCSHWTSTAMP, &ifr) < 0)
        return -1;
    return 0;
}
```

```bash
# ptp4l: ordinary clock with hardware timestamping
ptp4l -2 -H -i eth0 -m --step_threshold=1.0

# phc2sys: sync system clock to PHC
phc2sys -s eth0 -c CLOCK_REALTIME --step_threshold=1.0 -m

# Check sync status
pmc -u -b 0 'GET CURRENT_DATA_SET'

# Measure offset from grandmaster
# Target: < 1 us offset in steady state
```

## Source Code

```cpp
// Read PTP hardware clock via ioctl
#include <linux/ptp_clock.h>

int64_t readPhc(const char* dev) {
    int fd = open(dev, O_RDONLY);
    struct ptp_clock_time ts;
    struct ptp_sys_offset sysoff = {};
    ioctl(fd, PTP_SYS_OFFSET, &sysoff);
    // sysoff contains pairs of [system, phc, system] timestamps
    int64_t phc_ns = sysoff.ts[1].sec * 1000000000LL + sysoff.ts[1].nsec;
    close(fd);
    return phc_ns;
}
```
