---
type: reference
title: "PTP & Hardware Clock Sync"
description: "Precision Time Protocol (IEEE 1588) provides sub-microsecond clock synchronisation across trading servers. Hardware timestamping, boundary clocks, phc2sys, and ptp4l tuning for HFT."
tags: ["clock-synchronization"]
difficulty: advanced
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
- **Asymmetric link delay compensation**: PTP assumes network path delay is symmetric (RX = TX). In real networks, fiber length differences, switch PHY delays, and cable asymmetry cause offset errors of 10-100µs. Measure asymmetry with a cable delay test set or by swapping TX/RX fibers and comparing offset. Most PTP implementations allow manual asymmetry correction via `--network_transport_offset` or `--delay_asymmetry` in ptp4l. For colocated trading racks, use short (1-2m) matched-length fiber pairs to minimize asymmetry. Monitor asymmetry as `delay_asymmetry` in `pmc -u -b 0 'GET CURRENT_DATA_SET'`
- **GNSS multi-constellation backup**: GPS is the primary GNSS for most grandmasters, but GPS jamming/spoofing is real and increasing. Use a multi-constellation GNSS receiver (GPS + Galileo + GLONASS + BeiDou) for resilience. A GPS outage of 30+ minutes causes holdover drift beyond 1µs — enough to create timestamp ordering disputes. Best practice: deploy two independent grandmasters (different models, different antennae) each with multi-constellation. On GNSS loss, switch to NTP stratum-1 from a co-located atomic clock (Cs or Rb). Monitor GNSS health with `gpsmon` or `ntpshmmon`. Alert on GNSS satellite count < 4 or HDOP > 2.0
- **SyncE (Synchronous Ethernet)**: while PTP synchronizes time (phase), SyncE synchronizes frequency (rate). SyncE recovers the bit clock from the physical Ethernet link, providing jitter-free frequency reference. Combined PTP + SyncE = ITU-T G.8275.1 (time + phase sync with < 100ns accuracy). For HFT: SyncE is not strictly necessary unless you're running time-sensitive financial applications that require both frequency and phase (e.g., timestamping at the PHY level across multiple switches). If your switch chain is > 3 hops, add SyncE to avoid frequency accumulation errors that degrade PTP performance
- **Holdover performance**: when a grandmaster loses GNSS, it enters holdover — keeping time from its internal oscillator. Oscillator types: (a) TCXO (Temperature-Compensated Crystal Oscillator) — drifts 1-5µs per 10 minutes; (b) OCXO (Oven-Controlled Crystal Oscillator) — drifts 0.1-1µs per hour; (c) Rb (Rubidium atomic clock) — drifts < 0.1µs per day. For HFT: a 10µs drift means two servers on the same network could disagree on the ordering of trades by 10µs — enough for one trade to appear to happen "before" market data that triggered it. Use Rb grandmasters for critical trading racks. Test holdover: disconnect the GNSS antenna and measure offset growth over time. Your colo should specify: "maximum holdover duration without exceeding 1µs error"
- **Timestamp ordering and dispute resolution**: when a trade is disputed (e.g., an exchange's fill timestamp vs your order timestamp), the clock with the most precise PTP sync wins. The firm must prove: (a) its clock was PTP-synchronized at the moment of the trade; (b) the PTP chain was functioning (no GNSS outage, no asymmetry error); (c) the measurement methodology (hardware timestamp at NIC, not software). Requirements: (a) all timestamp sources log PTP sync status with each timestamp; (b) monitor and archive PTP offset logs (1-second resolution) for at least 2 years; (c) have a documented PTP chain (grandmaster → switch → server) with expected accuracy at each hop. In a dispute: the exchange's timestamp is the authoritative source, but your internal timestamps must be within 1µs of the exchange's to prove your version of events. Regulation: SEC Rule 613 (CAT) requires timestamps to be accurate within 50µs; MiFID II RTS 25 requires 100µs for timestamping (or 1ms for less liquid instruments). For HFT: target 1µs internal sync to provide margin against regulatory limits
- **Redundant PTP topology**: deploy two grandmasters (primary and backup) each with independent GNSS. Switches run Boundary Clock (BC) with two PTP ports — one following each grandmaster. Servers run Ordinary Clock (OC) that follows the primary; if primary's Announce messages stop, the server automatically switches to backup. The switchover must be hitless (less than 1µs jump) — use the "two-step" clock option. Test: disable the primary's antenna and verify servers switch to backup within 2 seconds and maintain < 1µs offset. Monitor: which grandmaster each server follows via `pmc -u -b 0 'GET PARENT_DATA_SET'`
- **PTP in virtualized/containerized environments**: PTP hardware timestamping bypasses the hypervisor if the NIC is passed through (PCIe passthrough or SR-IOV). For VMs: assign a dedicated PTP-capable NIC via PCI passthrough. For containers: use `--device /dev/ptp0` and run ptp4l/phc2sys inside the container. Do NOT use software PTP inside VMs — the hypervisor scheduling jitter adds 50-500µs of noise. If you must use virtualized trading, accept that PTP accuracy degrades to 10-50µs

## Staff+ Perspective

> **Staff+ Perspective**: The most frightening PTP incident I've experienced was a GNSS spoofing attack during a colo maintenance window. A technician accidentally pointed the GNSS antenna at a signal repeater inside the datacenter, causing a 50µs clock jump on our grandmaster. All PTP slaves followed the jump. Our timestamp-based monitoring detected the jump immediately (PTP offset > 10µs alert), but by then 3 seconds had passed. We had to reconstruct the order of 200+ trades across 2 venues to determine if any fills were mis-timestamped. A 50µs jump at 10µs/per trade resolution meant about 5 trades had ambiguous ordering. We had to manually reconcile with the exchange. The fix: install two grandmasters with physically separated antennae (different rooftops) and an automatic sanity check — if the two grandmasters differ by > 1µs, both are suspect and the system falls back to NTP (less accurate but safer than a bad PTP source). Now every PTP server logs offset history to a time-series database, and we run a weekly "holdover test" — disconnect GNSS for 1 hour and verify drift < 5µs. For asymmetric link: at a colo move, we installed new fiber pairs between the switch and server. The new pair was 3m vs 2m on the old pair (different patch panel routing). PTP offset jumped 5µs. We added `--delay_asymmetry 5000` (5µs correction in nanoseconds) to ptp4l to compensate. Lesson: always validate PTP offset after any physical cabling change.

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
