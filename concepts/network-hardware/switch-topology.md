---
type: reference
title: "Switch Topology"
description: "Leaf-spine (Clos) topology: every leaf switch connects to every. Cut-through forwarding: the switch starts forwarding a frame as"
tags: ["exchange-protocols", "programmable-networking", "protocols"]
difficulty: intermediate
timestamp: "2026-06-27T03:06:09.421Z"
phase: 6
phaseName: "Network Hardware"
category: "Phase 6 - Network Hardware"
subcategory: "network-hardware"
language: "cpp"
artifact-id: "ZHFT_SWITCH_TOPOLOGY"
---
## Key Learning Points

- Leaf-spine (Clos) topology: every leaf switch connects to every
- Cut-through forwarding: the switch starts forwarding a frame as
- Micro-burst handling: HFT traffic is extremely bursty (hundreds
- PFC (Priority Flow Control): IEEE 802.1Qbb pauses individual
- ECN (Explicit Congestion Notification): switches mark packets
- Buffer sizing rule of thumb: for a switch in a trading network,

## Usage

```bash

g++ -O3 -std=c++20 ZHFT_SWITCH_TOPOLOGY.txt -o switch_latency
sudo ./switch_latency <switch_ip>
```

## Source Code

```cpp
#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <iostream>
#include <numeric>
#include <span>
#include <string_view>
#include <vector>

#include <arpa/inet.h>
#include <netdb.h>
#include <netinet/ip_icmp.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <unistd.h>

// ====================================================================
// Switch latency measurement using ICMP timestamp (type 13/14).
// ICMP timestamps have microsecond resolution.
// For sub-microsecond accuracy, use hardware timestamping.
// ====================================================================

// Compute ICMP checksum.
auto IcmpChecksum(const void* data, int len) -> uint16_t {
    auto* buf = static_cast<const uint16_t*>(data);
    uint32_t sum = 0;
    for (int i = 0; i < len / 2; ++i) sum += ntohs(buf[i]);
    if (len & 1) sum += static_cast<const uint8_t*>(data)[len - 1] << 8;
    while (sum >> 16) sum = (sum & 0xFFFF) + (sum >> 16);
    return ~sum & 0xFFFF;
}

// Measure RTT to a switch via ICMP echo.
// Returns RTT in nanoseconds, or -1 on failure.
auto MeasureICMPRTT(std::string_view host, int count = 10) -> std::vector<double> {
    std::vector<double> rtts;

    struct addrinfo hints{};
    hints.ai_family = AF_INET;
    hints.ai_socktype = SOCK_RAW;
    hints.ai_protocol = IPPROTO_ICMP;
    struct addrinfo* res = nullptr;

    if (getaddrinfo(host.data(), nullptr, &hints, &res) < 0 || !res) {
        std::cerr << "getaddrinfo failed\n";
        return rtts;
    }

    int sock = ::socket(AF_INET, SOCK_DGRAM, IPPROTO_ICMP);
    if (sock < 0) {
        // Fallback: raw socket (needs root).
        sock = ::socket(AF_INET, SOCK_RAW, IPPROTO_ICMP);
    }
    if (sock < 0) {
        std::perror("socket (try with sudo)");
        freeaddrinfo(res);
        return rtts;
    }

    // Set receive timeout.
    struct timeval timeout{1, 0}; // 1 s
    ::setsockopt(sock, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout));

    auto* addr = reinterpret_cast<struct sockaddr_in*>(res->ai_addr);

    for (int i = 0; i < count; ++i) {
        // Build ICMP echo request.
        struct IcmpPacket {
            struct icmphdr hdr;
            uint64_t       timestamp;     // nanoseconds
        } pkt{};
        pkt.hdr.type     = ICMP_ECHO;
        pkt.hdr.code     = 0;
        pkt.hdr.un.echo.id = static_cast<uint16_t>(getpid() & 0xFFFF);
        pkt.hdr.un.echo.sequence = static_cast<uint16_t>(i);
        pkt.timestamp = std::chrono::steady_clock::now()
                            .time_since_epoch().count();
        pkt.hdr.checksum = IcmpChecksum(&pkt, sizeof(pkt));

        struct sockaddr_in dest = *addr;
        auto t_send = std::chrono::steady_clock::now();

        if (::sendto(sock, &pkt, sizeof(pkt), 0,
                     reinterpret_cast<struct sockaddr*>(&dest),
                     sizeof(dest)) < 0) {
            std::perror("sendto");
            continue;
        }

        // Receive reply.
        std::array<char, 512> recv_buf{};
        struct sockaddr_in from{};
        socklen_t from_len = sizeof(from);
        auto ret = ::recvfrom(sock, recv_buf.data(), recv_buf.size(),
                              0, reinterpret_cast<struct sockaddr*>(&from),
                              &from_len);
        auto t_recv = std::chrono::steady_clock::now();

        if (ret < 0) {
            std::cerr << "  [timeout]\n";
            continue;
        }

        auto ns = std::chrono::duration_cast<std::chrono::nanoseconds>(
                      t_recv - t_send).count();
        rtts.push_back(static_cast<double>(ns));
    }

    ::close(sock);
    freeaddrinfo(res);
    return rtts;
}

// ====================================================================
// Switch topology simulation (for documentation purposes).
// ====================================================================
struct SwitchTopology {
    struct LeafSpine {
        int num_leaves;
        int num_spines;
        int link_speed_gbps;

        auto LatencyEstimate(int hops = 3) const -> double {
            // Cut-through: ~500 ns per hop + 5 ns/m cable (10m intra-rack).
            double per_hop_ns = 500.0 + (10.0 * 5.0);   // switch + cable
            return per_hop_ns * hops;
        }
    };

    struct Traditional3Tier {
        int num_access;
        int num_aggregation;
        int num_core;

        auto LatencyEstimate() const -> double {
            // Store-and-forward: each hop adds ~5 µs + cable.
            return 3 * (5000.0 + 50.0);  // 3 hops × (5 µs + 50 m cable)
        }
    };
};

// ====================================================================
// Micro-burst buffer sizing calculator.
// ====================================================================
auto CalculateBufferNeeded(double line_rate_gbps, double rtt_us) -> double {
    // BDP = Bandwidth × Delay.
    // At 100 Gbps with 1 µs RTT: 100e9 × 1e-6 = 100,000 bits = 12.5 KB.
    double bdp_bytes = (line_rate_gbps * 1e9 * rtt_us * 1e-6) / 8.0;
    return bdp_bytes;
}

// ====================================================================
// Demonstration.
// ====================================================================
auto main(int argc, char** argv) -> int {
    std::cout << "=== Switch Topology & Fabric ===\n\n";

    if (argc > 1) {
        std::string_view target = argv[1];
        std::cout << "Measuring RTT to switch: " << target << "\n";
        auto rtts = MeasureICMPRTT(target, 5);

        if (!rtts.empty()) {
            double avg = std::accumulate(rtts.begin(), rtts.end(), 0.0) / rtts.size();
            double min = *std::min_element(rtts.begin(), rtts.end());
            double max = *std::max_element(rtts.begin(), rtts.end());
            std::cout << "  Min RTT: " << (min / 1000.0) << " µs\n";
            std::cout << "  Avg RTT: " << (avg / 1000.0) << " µs\n";
            std::cout << "  Max RTT: " << (max / 1000.0) << " µs\n";
            std::cout << "  One-way (est): " << (avg / 2000.0) << " µs\n";
        } else {
            std::cout << "  No replies received.\n";
        }
        std::cout << "\n";
    }

    // Topology comparison.
    SwitchTopology::LeafSpine ls{32, 8, 100};
    SwitchTopology::Traditional3Tier trad{48, 8, 4};

    std::cout << "Topology Latency Estimates:\n\n";
    std::cout << "Leaf-Spine (3 hops):  " << ls.LatencyEstimate(3) << " ns"
              << " (" << (ls.LatencyEstimate(3) / 1000.0) << " µs)\n";
    std::cout << "Traditional (3 hops): " << trad.LatencyEstimate() << " ns"
              << " (" << (trad.LatencyEstimate() / 1000.0) << " µs)\n\n";

    // Buffer sizing.
    std::cout << "Buffer Sizing (BDP):\n";
    double buf_local  = CalculateBufferNeeded(100, 1.0);    // 1 µs RTT
    double buf_dc     = CalculateBufferNeeded(100, 50.0);   // 50 µs RTT
    double buf_xdc    = CalculateBufferNeeded(100, 200.0);  // 200 µs RTT
    std::cout << "  100 Gbps, 1 µs RTT:    " << (buf_local / 1024) << " KB\n";
    std::cout << "  100 Gbps, 50 µs RTT:   " << (buf_dc / 1024) << " KB\n";
    std::cout << "  100 Gbps, 200 µs RTT:  " << (buf_xdc / 1024 / 1024) << " MB\n\n";

    std::cout << "=== Topology Comparison ===\n";
    std::cout << "| Feature          | Leaf-Spine      | Traditional 3-Tier |\n";
    std::cout << "|------------------|-----------------|--------------------|\n";
    std::cout << "| Latency          | Low & uniform   | Variable           |\n";
    std::cout << "| Bisection BW     | Full            | Oversubscribed     |\n";
    std::cout << "| Scalability      | Linear          | Complex            |\n";
    std::cout << "| HFT suitability  | Excellent       | Acceptable         |\n";
    std::cout << "| Cost             | Higher (more SW)| Lower              |\n";
    std::cout << "| Micro-burst hndl | Deep buffer ASIC| Shallow buffers    |\n";

    return 0;
}
```
