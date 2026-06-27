---
type: reference
title: "Multicast Deep"
description: "IGMPv3 adds Source-Specific Multicast (SSM) — receivers can. PIM-SM (Sparse Mode) uses a Rendezvous Point (RP) as a meeting"
tags: ["phase-5"]
difficulty: advanced
timestamp: "2026-06-27T03:06:09.416Z"
phase: 5
phaseName: "Kernel Bypass & Protocols"
category: "Phase 5 - Kernel Bypass & Protocols"
subcategory: "kernel-bypass"
language: "cpp"
artifact-id: "ZHFT_MULTICAST_DEEP"
---
## Key Learning Points

- IGMPv3 adds Source-Specific Multicast (SSM) — receivers can
- PIM-SM (Sparse Mode) uses a Rendezvous Point (RP) as a meeting
- Source tree vs Shared tree: a source tree (SPT) is the shortest
- Multicast routing: on the router, 'show ip mroute' shows the
- IGMP snooping: switches listen to IGMP reports to decide which
- Source failover with (S,G): exchanges typically have primary
- PIM-SM RP redundancy: Anycast RP (anycast-RP) or MSDP (Multicast

## Usage

```bash

g++ -O3 -std=c++20 ZHFT_MULTICAST_DEEP.txt -o mcast_deep
sudo ./mcast_deep  (needs raw socket for IGMP simulation)
```

## Source Code

```cpp
#include <algorithm>
#include <array>
#include <cerrno>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <iostream>
#include <map>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <thread>
#include <vector>

#include <arpa/inet.h>
#include <net/if.h>
#include <netinet/igmp.h>
#include <netinet/in.h>
#include <netinet/ip.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <unistd.h>

// ====================================================================
// Multicast topology discovery via IGMP queries / SNMP (simulated).
// ====================================================================

// -------------------------------------------------------------------
// Represents a discovered multicast source.
// -------------------------------------------------------------------
struct McastSource {
    std::string group_ip;
    std::string source_ip;
    uint16_t    port;
    bool        is_active = true;       // false = failed (awaiting failover)
};

struct McastGroupState {
    std::string              group_ip;
    std::vector<McastSource> sources;       // primary, backup, etc.
    int                      active_index = 0;
};

// ====================================================================
// Failover group manager: monitors sources and switches on failure.
// ====================================================================
class FailoverGroupManager {
public:
    // Register a multicast group with primary and backup sources.
    void AddGroup(std::string_view group, const std::vector<McastSource>& sources) {
        auto& state = groups_[std::string{group}];
        state.group_ip = group;
        state.sources  = sources;
        state.active_index = 0;

        // Join the primary source via IP_ADD_SOURCE_MEMBERSHIP.
        JoinSource(state.group_ip, state.sources[0]);
    }

    // Check liveness of the active source.
    // In production, this would check packet arrival rate, sequence
    // numbers, or use BFD (Bidirectional Forwarding Detection).
    void CheckLiveness() {
        for (auto& [group, state] : groups_) {
            if (state.sources.empty()) continue;
            const auto& active = state.sources[state.active_index];

            // Simulated liveness check: if the source is not active,
            // initiate failover.
            if (!active.is_active) {
                Failover(state);
            }
        }
    }

    // Simulate source failure (for testing).
    void FailSource(std::string_view group_ip, std::string_view source_ip) {
        auto it = groups_.find(std::string{group_ip});
        if (it == groups_.end()) return;
        for (auto& src : it->second.sources) {
            if (src.source_ip == source_ip) {
                src.is_active = false;
                std::cout << "[FAILOVER] Source " << source_ip
                          << " for group " << group_ip << " marked FAILED\n";
                break;
            }
        }
        CheckLiveness();
    }

    // Print current group state (like 'show ip mroute').
    void DumpState() const {
        std::cout << "=== Multicast Group State ===\n";
        for (const auto& [group, state] : groups_) {
            std::cout << "Group: " << group << "\n";
            for (size_t i = 0; i < state.sources.size(); ++i) {
                const auto& src = state.sources[i];
                std::cout << "  Source " << i << ": " << src.source_ip
                          << " (port " << src.port << ") "
                          << (src.is_active ? "ACTIVE" : "FAILED");
                if (static_cast<int>(i) == state.active_index)
                    std::cout << " ← CURRENT";
                std::cout << "\n";
            }
        }
        std::cout << "\n";
    }

private:
    // Join a group-source pair (simulated — IGMP setsockopt).
    void JoinSource(std::string_view group, const McastSource& source) {
        int sock = ::socket(AF_INET, SOCK_DGRAM, 0);
        if (sock < 0) { std::perror("socket"); return; }

        struct ip_mreq_source mreq{};
        ::inet_pton(AF_INET, source.source_ip.data(), &mreq.imr_sourceaddr);
        ::inet_pton(AF_INET, source.group_ip.data(),  &mreq.imr_multiaddr);
        mreq.imr_interface.s_addr = htonl(INADDR_ANY);

        if (::setsockopt(sock, IPPROTO_IP, IP_ADD_SOURCE_MEMBERSHIP,
                         &mreq, sizeof(mreq)) < 0) {
            std::perror("IP_ADD_SOURCE_MEMBERSHIP");
        } else {
            std::cout << "  Joined (S,G) = ("
                      << source.source_ip << ", " << source.group_ip << ")\n";
        }

        // Keep the socket open to maintain the membership.
        // In production, use a dedicated socket per group or a
        // management socket with MRT (Multicast Routing Table) API.
        open_sockets_.push_back(sock);
    }

    // Leave a source group.
    void LeaveSource(std::string_view group, const McastSource& source) {
        int sock = ::socket(AF_INET, SOCK_DGRAM, 0);
        if (sock < 0) return;

        struct ip_mreq_source mreq{};
        ::inet_pton(AF_INET, source.source_ip.data(), &mreq.imr_sourceaddr);
        ::inet_pton(AF_INET, source.group_ip.data(),  &mreq.imr_multiaddr);
        mreq.imr_interface.s_addr = htonl(INADDR_ANY);
        ::setsockopt(sock, IPPROTO_IP, IP_DROP_SOURCE_MEMBERSHIP,
                     &mreq, sizeof(mreq));
        ::close(sock);
    }

    // Switch to the next available source.
    void Failover(McastGroupState& state) {
        int new_idx = -1;
        for (size_t i = 0; i < state.sources.size(); ++i) {
            if (state.sources[i].is_active) {
                new_idx = static_cast<int>(i);
                break;
            }
        }
        if (new_idx < 0) {
            std::cerr << "  No available sources for group "
                      << state.group_ip << "!\n";
            return;
        }

        // Leave current source, join new one.
        if (state.active_index >= 0 &&
            state.active_index < static_cast<int>(state.sources.size())) {
            LeaveSource(state.group_ip, state.sources[state.active_index]);
        }
        JoinSource(state.group_ip, state.sources[new_idx]);
        state.active_index = new_idx;

        std::cout << "[FAILOVER] Switched to source " << new_idx
                  << " (" << state.sources[new_idx].source_ip << ")"
                  << " for group " << state.group_ip << "\n";
    }

    std::map<std::string, McastGroupState, std::less<>> groups_;
    std::vector<int> open_sockets_;     // keep sockets alive for membership
};

// ====================================================================
// Simulated PIM-SM router state (for educational display).
// ====================================================================
struct PimSMState {
    struct SGRoute {
        std::string group;
        std::string source;
        std::string rpf_neighbor;       // RPF interface / next-hop
        bool        is_spt = false;     // shortest-path tree
        int         uptime_sec = 0;
    };
    std::vector<SGRoute> routes;

    void Print() const {
        std::cout << "\n=== PIM-SM Multicast Routing Table ===\n";
        std::cout << "Group           Source           RPF Neighbor   SPT  Up\n";
        std::cout << "------------------------------------------------------\n";
        for (const auto& r : routes) {
            std::cout << r.group << "  " << r.source << "  "
                      << r.rpf_neighbor << "     "
                      << (r.is_spt ? "Yes" : "No ") << "  "
                      << r.uptime_sec << "s\n";
        }
    }
};

// ====================================================================
// Demonstration.
// ====================================================================
auto main() -> int {
    std::cout << "=== Multicast Deep Dive ===\n\n";

    // --- Failover Manager ---
    FailoverGroupManager mgr;

    McastSource primary{"232.1.1.1", "192.168.1.100", 5000, true};
    McastSource backup{"232.1.1.1",  "192.168.1.101", 5000, true};
    McastSource tertiary{"232.1.1.1", "192.168.1.102", 5000, true};

    mgr.AddGroup("232.1.1.1", {primary, backup, tertiary});
    mgr.DumpState();

    std::cout << "Simulating primary failure...\n";
    mgr.FailSource("232.1.1.1", "192.168.1.100");
    mgr.DumpState();

    std::cout << "Simulating backup failure (should switch to tertiary)...\n";
    mgr.FailSource("232.1.1.1", "192.168.1.101");
    mgr.DumpState();

    // --- PIM-SM router state (simulated) ---
    PimSMState pim{};
    pim.routes.push_back({"232.1.1.1", "192.168.1.100",
                          "10.0.0.1", false, 3600});
    pim.routes.push_back({"232.1.1.1", "192.168.1.101",
                          "10.0.0.2", true, 120});
    pim.Print();

    std::cout << "\n=== IGMP Snooping Check ===\n";
    std::cout << "To verify IGMP snooping on the switch:\n";
    std::cout << "  show igmp snooping groups\n";
    std::cout << "  show mac address-table multicast\n";
    std::cout << "  show bridge multicast filtering\n\n";

    std::cout << "=== Key Commands ===\n";
    std::cout << "Router:  show ip mroute [group]\n";
    std::cout << "Router:  show ip pim rp mapping\n";
    std::cout << "Host:    cat /proc/net/igmp\n";
    std::cout << "Host:    ip maddr show\n";
    std::cout << "Switch:  show igmp snooping mrouter\n";

    return 0;
}
```
