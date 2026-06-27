---
type: reference
title: "Cross Dc"
description: "Dark fiber: leasing raw fiber strands between DCs gives the. DWDM (Dense Wavelength Division Multiplexing): each fiber pair"
tags: ["phase-6"]
difficulty: intermediate
timestamp: "2026-06-27T03:06:09.418Z"
phase: 6
phaseName: "Network Hardware"
category: "Phase 6 - Network Hardware"
subcategory: "network-hardware"
language: "cpp"
artifact-id: "ZHFT_CROSS_DC"
---
## Key Learning Points

- Dark fiber: leasing raw fiber strands between DCs gives the
- DWDM (Dense Wavelength Division Multiplexing): each fiber pair
- Wave circuits: leased wavelength from a carrier — a "light"
- Wavelength diversity: provision geographically diverse paths
- Protected vs unprotected circuits: protected circuits have 1+1
- Latency asymmetry: the forward and reverse paths may differ
- Site diversity strategy: active-passive (primary DC trades,
- State replication across DCs: use a dedicated WAN-optimised

## Usage

// g++ -O3 -std=c++20 ZHFT_CROSS_DC.txt -o cross_dc
// ./cross_dc

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
#include <map>
#include <numeric>
#include <optional>
#include <random>
#include <span>
#include <string>
#include <string_view>
#include <vector>

#include <arpa/inet.h>
#include <netdb.h>
#include <sys/socket.h>
#include <unistd.h>

// ====================================================================
// WAN latency measurement tool — measures RTT and asymmetry.
// ====================================================================
class WanLatencyProbe {
public:
    WanLatencyProbe(std::string_view remote_host, uint16_t port)
        : host_{remote_host}, port_{port}
    {}

    // Measure RTT using UDP timestamps.
    // Returns a vector of RTTs in nanoseconds.
    auto MeasureRTT(int count = 20) -> std::vector<double> {
        std::vector<double> rtts;

        int fd = ::socket(AF_INET, SOCK_DGRAM, 0);
        if (fd < 0) { std::perror("socket"); return rtts; }

        struct addrinfo hints{};
        hints.ai_family = AF_INET;
        hints.ai_socktype = SOCK_DGRAM;
        struct addrinfo* res = nullptr;

        if (getaddrinfo(host_.data(), nullptr, &hints, &res) < 0 || !res) {
            std::cerr << "DNS resolution failed\n";
            ::close(fd);
            return rtts;
        }

        auto* remote = reinterpret_cast<struct sockaddr_in*>(res->ai_addr);
        remote->sin_port = htons(port_);

        // Set receive timeout.
        struct timeval tv{2, 0};        // 2 s
        ::setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));

        for (int i = 0; i < count; ++i) {
            // Send a timestamped packet.
            uint64_t t_send = std::chrono::steady_clock::now()
                                  .time_since_epoch().count();

            if (::sendto(fd, &t_send, sizeof(t_send), 0,
                         reinterpret_cast<struct sockaddr*>(remote),
                         sizeof(*remote)) < 0) {
                std::perror("sendto");
                continue;
            }

            // Receive echo.
            uint64_t t_recv = 0;
            struct sockaddr_in from{};
            socklen_t from_len = sizeof(from);
            int ret = ::recvfrom(fd, &t_recv, sizeof(t_recv), 0,
                                 reinterpret_cast<struct sockaddr*>(&from),
                                 &from_len);
            auto t_end = std::chrono::steady_clock::now();

            if (ret < 0) {
                std::cout << "  #" << i << ": timeout\n";
                continue;
            }

            // Round trip = (t_end - t_send).
            double rtt_ns = std::chrono::duration_cast<
                std::chrono::nanoseconds>(
                    std::chrono::steady_clock::time_point{
                        std::chrono::steady_clock::duration{t_end.time_since_epoch()}
                    } - std::chrono::steady_clock::time_point{
                        std::chrono::steady_clock::duration{t_send}
                    }).count();
            rtts.push_back(rtt_ns);
        }

        freeaddrinfo(res);
        ::close(fd);
        return rtts;
    }

    // Estimate one-way latency asymmetry by comparing two directions.
    // Uses the measured RTTs from both directions.
    auto EstimateAsymmetry() -> std::pair<double, double> {
        // This simulates bidirectional measurement.
        // In reality, you'd need synchronized clocks (PTP) or
        // simultaneous measurements from both ends.
        auto fwd = MeasureRTT(10);
        if (fwd.empty()) return {0, 0};

        double avg_rtt = std::accumulate(fwd.begin(), fwd.end(), 0.0) / fwd.size();
        double one_way_assumed = avg_rtt / 2.0;

        // Simulate asymmetry: typically 1-5% in practice.
        // For demonstration, we return the assumed symmetric latency.
        return {one_way_assumed, one_way_assumed};
    }

private:
    std::string host_;
    uint16_t    port_;
};

// ====================================================================
// State sync protocol sketch (pseudo-code).
// Replicates a small trading state (positions, orders) across DCs.
// ====================================================================
namespace StateSync {

// -------------------------------------------------------------------
// Log entry for state replication.
// -------------------------------------------------------------------
struct ReplicationEntry {
    uint64_t seqno;
    uint64_t timestamp_ns;
    uint8_t  entry_type;         // 1 = order_add, 2 = order_cancel, 3 = position
    // Payload would be a serialized protobuf / SBE message.
    uint8_t  payload[1024];
};

// -------------------------------------------------------------------
// Sender: streams replication entries to a remote DC.
// -------------------------------------------------------------------
class StateReplicatorSender {
public:
    StateReplicatorSender(std::string_view peer_ip, uint16_t port)
        : seqno_{0}
    {
        fd_ = ::socket(AF_INET, SOCK_DGRAM, 0);
        if (fd_ < 0) return;

        struct sockaddr_in peer{};
        peer.sin_family = AF_INET;
        peer.sin_port   = htons(port);
        ::inet_pton(AF_INET, peer_ip.data(), &peer.sin_addr);
        peer_ = peer;

        // Set SO_PRIORITY for QoS treatment.
        int prio = 6;
        ::setsockopt(fd_, SOL_SOCKET, SO_PRIORITY, &prio, sizeof(prio));
    }

    ~StateReplicatorSender() { if (fd_ >= 0) ::close(fd_; }

    // Replicate a state change (simplified — inline for demo).
    // In production, this would buffer, batch, and use a reliable
    // protocol (e.g., UDT, QUIC, or custom over RDMA).
    void Replicate(uint8_t type, const void* data, std::size_t len) {
        ReplicationEntry entry{};
        entry.seqno        = seqno_++;
        entry.timestamp_ns = static_cast<uint64_t>(
            std::chrono::steady_clock::now().time_since_epoch().count());
        entry.entry_type   = type;
        std::memcpy(entry.payload, data,
                    std::min(len, sizeof(entry.payload)));

        ::sendto(fd_, &entry, sizeof(ReplicationEntry), 0,
                 reinterpret_cast<struct sockaddr*>(&peer_),
                 sizeof(peer_));
    }

    auto Seqno() const -> uint64_t { return seqno_; }

private:
    int                fd_ = -1;
    struct sockaddr_in peer_{};
    uint64_t           seqno_ = 0;
};

// -------------------------------------------------------------------
// Receiver: consumes replication entries and applies them.
// -------------------------------------------------------------------
class StateReplicatorReceiver {
public:
    StateReplicatorReceiver(uint16_t port) : expected_seqno_{1} {
        fd_ = ::socket(AF_INET, SOCK_DGRAM, 0);
        if (fd_ < 0) return;

        struct sockaddr_in bind_addr{};
        bind_addr.sin_family = AF_INET;
        bind_addr.sin_port   = htons(port);
        bind_addr.sin_addr.s_addr = htonl(INADDR_ANY);
        if (::bind(fd_, reinterpret_cast<struct sockaddr*>(&bind_addr),
                   sizeof(bind_addr)) < 0) {
            std::perror("bind");
        }

        // Large receive buffer for burst absorption.
        int rcvbuf = 64 * 1024 * 1024;
        ::setsockopt(fd_, SOL_SOCKET, SO_RCVBUF, &rcvbuf, sizeof(rcvbuf));
    }

    ~StateReplicatorReceiver() { if (fd_ >= 0) ::close(fd_); }

    // Poll for a replication entry. Blocks briefly.
    auto Receive() -> std::optional<ReplicationEntry> {
        ReplicationEntry entry{};
        auto ret = ::recv(fd_, &entry, sizeof(entry), MSG_DONTWAIT);
        if (ret < 0) return std::nullopt;

        // Check seqno gap.
        if (entry.seqno != expected_seqno_) {
            std::cerr << "REPLICATION GAP: expected " << expected_seqno_
                      << ", got " << entry.seqno << "\n";
            // Request retransmission (out of scope for this demo).
        }
        expected_seqno_ = entry.seqno + 1;
        return entry;
    }

private:
    int      fd_ = -1;
    uint64_t expected_seqno_ = 1;
};

} // namespace StateSync

// ====================================================================
// Demonstration.
// ====================================================================
auto main(int argc, char** argv) -> int {
    std::cout << "=== Cross-Datacenter Connectivity ===\n\n";

    // WAN latency measurement.
    if (argc > 1) {
        std::string target = argv[1];
        uint16_t port = (argc > 2) ? static_cast<uint16_t>(std::atoi(argv[2])) : 5000;
        WanLatencyProbe probe{target, port};
        std::cout << "Measuring RTT to " << target << ":" << port << "...\n";
        auto rtts = probe.MeasureRTT(10);

        if (!rtts.empty()) {
            auto [min_it, max_it] = std::minmax_element(rtts.begin(), rtts.end());
            double avg = std::accumulate(rtts.begin(), rtts.end(), 0.0) / rtts.size();
            std::cout << "  Min RTT: " << (*min_it / 1000.0) << " µs\n";
            std::cout << "  Avg RTT: " << (avg / 1000.0) << " µs\n";
            std::cout << "  Max RTT: " << (*max_it / 1000.0) << " µs\n";
            std::cout << "  One-way (est): " << (avg / 2000.0) << " µs\n";
        }
    }

    std::cout << "\n=== Connectivity Options Comparison ===\n";
    std::cout << "| Option        | Latency/100km | Monthly cost | Provision time |\n";
    std::cout << "|---------------|---------------|--------------|----------------|\n";
    std::cout << "| Dark fiber    | 500 µs        | $5000-15000  | 6-18 months    |\n";
    std::cout << "| DWDM lambda   | 501-505 µs    | $2000-8000   | 1-3 months     |\n";
    std::cout << "| Wave circuit  | 500-700 µs    | $1000-5000   | 1-4 weeks      |\n";
    std::cout << "| MPLS VPN      | 500-1000 µs   | $500-3000    | 1-4 weeks      |\n";
    std::cout << "| Public net    | 500-5000 µs   | $100-500     | Instant        |\n\n";

    std::cout << "=== State Replication (Pseudo-Code Output) ===\n";
    // Simulate replication.
    char dummy_state[64]{};
    StateSync::StateReplicatorSender sender{"10.0.0.2", 9000};
    sender.Replicate(1, dummy_state, sizeof(dummy_state));
    std::cout << "Sent replication entry (seqno=" << sender.Seqno() - 1 << ")\n";

    std::cout << "\n=== Key Principles ===\n";
    std::cout << "1. Dark fiber = lowest latency, highest cost, longest lead time\n";
    std::cout << "2. Always measure actual path distance (fiber rarely follows straight line)\n";
    std::cout << "3. Latency asymmetry of 1-5% is normal; measure both directions\n";
    std::cout << "4. Use unprotected circuits + app-layer failover for lowest latency\n";
    std::cout << "5. State replication must be deterministic and seqno-checked\n";
    std::cout << "6. For true HA, use geographically diverse fiber paths\n";

    return 0;
}
```
