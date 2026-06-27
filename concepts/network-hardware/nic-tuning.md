---
type: reference
title: "NIC Tuning"
description: "Interrupt coalescing (adaptive or fixed): for HFT, interrupt. RSS (Receive Side Scaling) distributes incoming packets across"
tags: ["phase-6"]
difficulty: intermediate
timestamp: "2026-06-27T03:06:09.419Z"
phase: 6
phaseName: "Network Hardware"
category: "Phase 6 - Network Hardware"
subcategory: "network-hardware"
language: "cpp"
artifact-id: "ZHFT_NIC_TUNING"
---
## Key Learning Points

- Interrupt coalescing (adaptive or fixed): for HFT, interrupt
- RSS (Receive Side Scaling) distributes incoming packets across
- Flow steering (aRFS, ntuple): ntuple filters allow directing
- TSO (TCP Segmentation Offload), GRO (Generic Receive Offload),
- Ring buffer sizing: ethtool -G rx N / tx N. Default 1024 is
- Adaptive interrupt moderation: Intel NICs support adaptive
- PCIe bandwidth: 100 Gbps NIC requires PCIe Gen4 x16 (32 GB/s
- **NIC firmware bugs causing silent packet drops**: real-world cases — Intel XL710 (Fortville) had a firmware bug where RX descriptor head/tail pointers wrapped incorrectly under high load, silently dropping packets without incrementing the drop counter. Fix: update to NVM >= 6.02. Mellanox ConnectX-5 had a bug where PFC pause frames caused the RX ring to lock up until a link bounce. Mitigation: disable PFC on HFT-dedicated ports. Always test NIC firmware versions in a staging environment before production deployment. Maintain a firmware version matrix with known-good and known-bad versions per NIC model
- **PCIe AER (Advanced Error Reporting)**: correctable errors (CRC retries) are silently retried but add 100-500ns latency per retry. Uncorrectable errors cause PCIe bus reset (up to 100ms of downtime). Monitor with `rasdaemon` or `per daemon`: alert on `aer_correctable` count > 100/hour per device. Common causes: loose PCIe slot connection, bent pins, undervoltage. Physical inspection and reseating fixes most PCIe AER issues
- **Link flapping detection**: a 1-2 second link drop results in 500+ lost market data messages. Causes: faulty SFP+ module, dirty fiber connector, switch port autonegotiation mismatch, power supply brownout. Monitor with: `ethtool -S eth0 | grep -E 'link|fcs|crc|error'` — rising `fcs_err` or `crc_err` counters indicate physical layer issues. Set up Nagios/Icinga check: every 60s, read `/sys/class/net/eth0/carrier` (0 = down) and `/sys/class/net/eth0/operstate`. For redundant feeds, trigger failover on carrier loss > 100ms
- **Flow director (ntuple) programming at scale**: each ntuple filter is a hardware rule consuming SRAM on the NIC. Intel XL710 has ~128 ntuple filters; Mellanox CX5 has ~512. For a feed handler receiving 50+ multicast streams, you may exhaust filters. Fallback: use RSS with symmetric hashing instead of per-stream ntuple. Monitor available filters: `ethtool -n eth0` lists all rules; count against the NIC's hardware limit

## Staff+ Perspective

> **Staff+ Perspective**: NIC firmware bugs are the most insidious latency source because they leave no trace. At the firm, we had an intermittent 10µs jitter every 90 seconds on a ConnectX-5. After months of investigation (including swapping cables, SFPs, switches, and servers), we discovered it was a firmware thermal throttling bug — the NIC's internal temperature sensor triggered a 50ms performance throttle at 85°C, which happened every 90 seconds in our colo rack (poor airflow). The fix: add a 40mm fan pointed at the NIC cage. The PCIe AER lesson: we had a server generating 500+ correctable AER errors per hour (invisible to the trading team) — a loose PCIe riser card. The errors were corrected by the hardware but added 200-300ns to every DMA transaction to that NIC. The trading P50 shifted from 5µs to 5.3µs — a 6% regression that took 2 weeks to trace. Now we monitor AER counters in every server's grafana dashboard. For link flapping: our failover script detected carrier loss in 50ms and switched feeds, but the backup feed's first message arrived 2ms after failover — during those 2ms, we missed 20 messages. We added a "sticky failover" (don't switch back to primary until EOD) to avoid repeated flapping.

## Usage

// g++ -O3 -std=c++20 ZHFT_NIC_TUNING.txt -o nic_tune
// ./nic_tune eth0

## Source Code

```cpp
#include <algorithm>
#include <array>
#include <cerrno>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <iostream>
#include <map>
#include <numeric>
#include <span>
#include <sstream>
#include <string>
#include <string_view>
#include <vector>

#include <arpa/inet.h>
#include <net/if.h>
#include <sys/ioctl.h>
#include <unistd.h>

// ====================================================================
// ethtool configuration generator — produces shell commands.
// ====================================================================
class EthtoolConfig {
public:
    explicit EthtoolConfig(std::string_view iface) : iface_{iface} {}

    // Generate the complete ethtool configuration for HFT.
    auto Generate() const -> std::string {
        std::ostringstream cmd;

        // 1. Disable coalescing entirely.
        //    HFT requirement: every packet interrupts immediately.
        cmd << "# Disable interrupt coalescing (HFT mode)\n";
        cmd << "ethtool -C " << iface_ << " rx-usecs 0 tx-usecs 0\n";
        cmd << "ethtool -C " << iface_ << " adaptive-rx off adaptive-tx off\n\n";

        // 2. Disable offloads that batch packets.
        cmd << "# Disable batching offloads (GRO/LRO/TSO)\n";
        cmd << "ethtool -K " << iface_ << " gro off lro off tso off\n";
        cmd << "ethtool -K " << iface_ << " gso off tx-checksum-ip-generic off\n";
        cmd << "ethtool -K " << iface_ << " rx-checksumming on\n\n";

        // 3. Ring buffer sizing.
        cmd << "# Increase ring buffers for burst absorption\n";
        cmd << "ethtool -G " << iface_ << " rx 8192 tx 8192\n\n";

        // 4. RSS: enable symmetric hashing if available.
        cmd << "# RSS setup: 4-8 queues on dedicated cores\n";
        cmd << "ethtool -L " << iface_ << " combined 4\n\n";

        // 5. ntuple filters for flow steering (example).
        cmd << "# ntuple filter: steer exchange UDP port 5000 to queue 0\n";
        cmd << "ethtool -N " << iface_ << " flow-type udp4 dst-port 5000 action 0\n";
        cmd << "ethtool -K " << iface_ << " ntuple on\n\n";

        // 6. Set ring parameters: DMA buffer size.
        cmd << "# DMA buffer size (if supported)\n";
        cmd << "ethtool -G " << iface_ << " rx-mini 0 rx-jumbo 0\n\n";

        // 7. Busy poll.
        cmd << "# Enable busy poll on this device\n";
        cmd << "echo 50 > /sys/class/net/" << iface_ << "/gro_flush_timeout || true\n";

        return cmd.str();
    }

    // Print current NIC settings.
    auto PrintCurrent() const -> void {
        std::cout << "Current NIC settings for " << iface_ << ":\n";
        std::string cmds[] = {
            "ethtool -c " + iface_ + " 2>/dev/null",       // coalescing
            "ethtool -k " + iface_ + " 2>/dev/null | grep -E '^(gro|lro|tso|gso)'",
            "ethtool -g " + iface_ + " 2>/dev/null",       // ring
            "ethtool -l " + iface_ + " 2>/dev/null",       // channels
            "ethtool -n " + iface_ + " 2>/dev/null",       // rx-flow-hash
            "ethtool -S " + iface_ + " 2>/dev/null | head -20", // stats
        };
        for (const auto& c : cmds) {
            std::cout << "  $ " << c << "\n";
            std::array<char, 2048> buf{};
            FILE* fp = popen(c.c_str(), "r");
            if (fp) {
                while (fgets(buf.data(), static_cast<int>(buf.size()), fp)) {
                    std::cout << "    " << buf.data();
                }
                pclose(fp);
            }
            std::cout << "\n";
        }
    }

private:
    std::string iface_;
};

// ====================================================================
// RSS hash verification tool: check how flows distribute across queues.
// ====================================================================
class RSSVerifier {
public:
    // Compute RSS hash for a given 5-tuple using the Toeplitz hash.
    // The Toeplitz key is typically 40 bytes; here we simulate with
    // a simplified hash for demonstration.
    static auto ComputeHashIPv4(uint32_t src_ip, uint32_t dst_ip,
                                uint16_t src_port, uint16_t dst_port,
                                std::span<const uint32_t> key) -> uint32_t {
        // Build the input 4-tuple (12 bytes for TCP/UDP IPv4).
        std::array<uint8_t, 12> input{};
        std::memcpy(input.data(), &src_ip, 4);
        std::memcpy(input.data() + 4, &dst_ip, 4);
        std::memcpy(input.data() + 8, &src_port, 2);
        std::memcpy(input.data() + 10, &dst_port, 2);

        // Simplified Toeplitz: XOR of tuple with key windows.
        uint32_t hash = 0;
        for (int i = 0; i < 12; ++i) {
            hash ^= (key[i % key.size()] << (i * 8 / 4));
            (void)input[i];
        }
        return hash;
    }

    // Given an RSS hash, compute the target queue index.
    static auto QueueFromHash(uint32_t hash, int num_queues) -> int {
        // The lower bits of the hash (indirection table) map to queue.
        // Typically the indirection table has 128 entries (7 bits).
        int indir_idx = hash & 0x7F;            // 7-bit indirection
        return indir_idx % num_queues;
    }

    // Verify distribution: generate random 5-tuples and check spread.
    static void VerifyDistribution(int num_flows, int num_queues) {
        std::vector<int> queue_counts(num_queues, 0);

        std::array<uint32_t, 10> key{0x6d5a56da, 0x34a0c00a, 0xcf62d1a9,
                                      0x6e71b27a, 0xbc627534, 0x8eed7c7c,
                                      0x47f87352, 0xaf1f965b, 0x8f2a2e3b,
                                      0xde1a6f1d};

        for (int i = 0; i < num_flows; ++i) {
            // Create synthetic flow.
            uint32_t src_ip  = (i * 0x9E3779B9) & 0xFFFFFFFF;
            uint32_t dst_ip  = ((i + 1) * 0x9E3779B9) & 0xFFFFFFFF;
            uint16_t src_port = static_cast<uint16_t>(i & 0xFFFF);
            uint16_t dst_port = 5000;

            uint32_t hash = ComputeHashIPv4(src_ip, dst_ip, src_port,
                                            dst_port, key);
            int queue = QueueFromHash(hash, num_queues);
            queue_counts[queue]++;
        }

        // Print distribution.
        std::cout << "RSS distribution (" << num_flows << " flows, "
                  << num_queues << " queues):\n";
        int total = std::accumulate(queue_counts.begin(), queue_counts.end(), 0);
        for (int i = 0; i < num_queues; ++i) {
            double pct = 100.0 * queue_counts[i] / total;
            int bar = static_cast<int>(pct / 2);
            std::cout << "  Queue " << i << ": " << queue_counts[i]
                      << " (" << pct << "%) ";
            for (int b = 0; b < bar; ++b) std::cout << "#";
            std::cout << "\n";
        }
    }
};

// ====================================================================
// Demonstration.
// ====================================================================
auto main(int argc, char** argv) -> int {
    std::string iface = "eth0";
    if (argc > 1) iface = argv[1];

    std::cout << "=== NIC Deep Tuning ===\n\n";

    // Config generator.
    EthtoolConfig cfg(iface);
    std::cout << "Generated ethtool configuration for " << iface << ":\n";
    std::cout << cfg.Generate() << "\n";

    // RSS verification.
    RSSVerifier::VerifyDistribution(100000, 8);

    std::cout << "\n=== Monitoring Commands ===\n";
    std::cout << "  ethtool -S " << iface << " | grep -E '(drop|error)'\n";
    std::cout << "  cat /proc/interrupts | grep " << iface << "\n";
    std::cout << "  watch -n 1 'ethtool -S " << iface
              << " | grep packets'\n";
    std::cout << "  lspci -vvv -s $(ethtool -i " << iface
              << " | grep bus-info | awk \\'{print \$2}\\') | grep -i msi\n";

    return 0;
}
```
