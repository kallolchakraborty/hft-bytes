---
type: reference
title: "NIC Tuning"
description: "Interrupt coalescing (adaptive or fixed): for HFT, interrupt. RSS (Receive Side Scaling) distributes incoming packets across"
tags: ["phase-6"]
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
