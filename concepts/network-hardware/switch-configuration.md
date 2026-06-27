---
type: reference
title: "Switch Configuration"
description: "VLAN segmentation: a trading network should have at least three. ACLs (Access Control Lists) limit traffic between VLANs, protect"
tags: ["exchange-protocols", "programmable-networking", "protocols"]
difficulty: intermediate
timestamp: "2026-06-27T03:06:09.420Z"
phase: 6
phaseName: "Network Hardware"
category: "Phase 6 - Network Hardware"
subcategory: "network-hardware"
language: "cpp"
artifact-id: "ZHFT_SWITCH_CONFIG"
---
## Key Learning Points

- VLAN segmentation: a trading network should have at least three
- ACLs (Access Control Lists) limit traffic between VLANs, protect
- QoS/PFC configuration: map IEEE 802.1p priority levels to traffic
- LLDP (Link Layer Discovery Protocol) and CDP (Cisco Discovery
- Port monitoring / SPAN (Switched Port Analyzer): mirror traffic
- MLAG (Multi-Chassis Link Aggregation, aka vPC, MC-LAG) provides

## Usage

// g++ -O3 -std=c++20 ZHFT_SWITCH_CONFIG.txt -o switch_config
// ./switch_config
// Outputs JSON/YAML configuration.

## Source Code

```cpp
#include <algorithm>
#include <array>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <iostream>
#include <map>
#include <optional>
#include <set>
#include <span>
#include <sstream>
#include <string>
#include <string_view>
#include <vector>

// ====================================================================
// Switch configuration data model.
// ====================================================================

enum class VlanId : uint16_t {
    Management   = 10,
    Production    = 20,
    TestDev       = 30,
    Storage       = 40,
    PTP           = 100,
};

enum class SwitchRole {
    Leaf,
    Spine,
    Border,
};

enum class PortMode {
    Access,
    Trunk,
    Routed,
    Monitor,
};

struct PortConfig {
    std::string  name;                   // e.g., "Ethernet1/1"
    PortMode     mode          = PortMode::Access;
    VlanId       access_vlan   = VlanId::Production;
    std::set<VlanId> trunk_vlans = {VlanId::Management, VlanId::Production, VlanId::PTP};
    int          speed_gbps    = 100;
    bool         enabled       = true;
    bool         lldp_enable   = true;
    bool         cdp_enable    = true;
    std::string  description;
    // PFC / QoS settings.
    int          pfc_priority  = -1;     // -1 = disabled
    int          cos           = 0;      // 802.1p priority
    // SPAN destination.
    std::string  monitor_session;        // "" = not monitored
    // MLAG peer.
    std::string  mlag_channel;
};

struct VlanConfig {
    VlanId       id;
    std::string  name;
    std::string  subnet;                 // e.g., "10.0.20.0/24"
    std::string  gateway;                // "10.0.20.1"
    bool         igmp_snooping = true;
};

struct AclRule {
    int         sequence;
    std::string action;                 // "permit" or "deny"
    std::string protocol;               // "ip", "tcp", "udp"
    std::string src;
    std::string src_port;
    std::string dst;
    std::string dst_port;
};

struct QosConfig {
    struct TrafficClass {
        int     cos;
        int     dscp;
        int     queue;
        bool    strict_priority;
        int     bandwidth_pct;          // only for WRR queues
        bool    pfc_enabled;
    };
    std::vector<TrafficClass> classes;
};

struct MlagDomain {
    std::string domain_id;
    std::string peer_ip;
    std::string peer_link;              // port-channel to peer
    int         keepalive_interval_s = 1;
};

struct SwitchConfig {
    std::string               hostname;
    SwitchRole                role         = SwitchRole::Leaf;
    std::string               mgmt_ip;
    std::vector<PortConfig>   ports;
    std::vector<VlanConfig>   vlans;
    std::vector<AclRule>      acl_in;
    std::vector<AclRule>      acl_out;
    QosConfig                 qos;
    std::vector<MlagDomain>   mlag_domains;
    bool                      stp_enable   = false;    // disable STP on HFT leaf
    bool                      igmp_snooping = true;
    int                       mtu          = 9216;      // jumbo frames
};

// ====================================================================
// Switch config generator (JSON format).
// ====================================================================
class SwitchConfigGenerator {
public:
    SwitchConfigGenerator(const SwitchConfig& cfg) : cfg_{cfg} {}

    // Generate JSON configuration.
    auto ToJSON() const -> std::string {
        std::ostringstream json;
        json << "{\n";
        json << "  \"hostname\": \"" << cfg_.hostname << "\",\n";
        json << "  \"role\": \"" << RoleToString(cfg_.role) << "\",\n";
        json << "  \"mgmt_ip\": \"" << cfg_.mgmt_ip << "\",\n";
        json << "  \"stp_enable\": " << (cfg_.stp_enable ? "true" : "false") << ",\n";
        json << "  \"igmp_snooping\": " << (cfg_.igmp_snooping ? "true" : "false") << ",\n";
        json << "  \"mtu\": " << cfg_.mtu << ",\n";

        // VLANs.
        json << "  \"vlans\": [\n";
        for (size_t i = 0; i < cfg_.vlans.size(); ++i) {
            const auto& v = cfg_.vlans[i];
            json << "    { \"id\": " << static_cast<int>(v.id)
                 << ", \"name\": \"" << v.name
                 << "\", \"subnet\": \"" << v.subnet
                 << "\", \"gateway\": \"" << v.gateway
                 << "\", \"igmp_snooping\": " << (v.igmp_snooping ? "true" : "false")
                 << " }";
            if (i + 1 < cfg_.vlans.size()) json << ",";
            json << "\n";
        }
        json << "  ],\n";

        // Ports.
        json << "  \"ports\": [\n";
        for (size_t i = 0; i < cfg_.ports.size(); ++i) {
            const auto& p = cfg_.ports[i];
            json << "    { \"name\": \"" << p.name << "\"";
            json << ", \"mode\": \"" << PortModeToString(p.mode) << "\"";
            json << ", \"access_vlan\": " << static_cast<int>(p.access_vlan);
            if (!p.trunk_vlans.empty()) {
                json << ", \"trunk_vlans\": [";
                for (auto it = p.trunk_vlans.begin(); it != p.trunk_vlans.end(); ++it) {
                    if (it != p.trunk_vlans.begin()) json << ", ";
                    json << static_cast<int>(*it);
                }
                json << "]";
            }
            json << ", \"speed_gbps\": " << p.speed_gbps;
            json << ", \"enabled\": " << (p.enabled ? "true" : "false");
            json << ", \"lldp\": " << (p.lldp_enable ? "true" : "false");
            json << ", \"pfc_priority\": " << p.pfc_priority;
            if (!p.description.empty())
                json << ", \"description\": \"" << p.description << "\"";
            json << " }";
            if (i + 1 < cfg_.ports.size()) json << ",";
            json << "\n";
        }
        json << "  ],\n";

        // ACLs.
        json << "  \"acl_in\": [\n";
        for (size_t i = 0; i < cfg_.acl_in.size(); ++i) {
            const auto& a = cfg_.acl_in[i];
            json << "    { \"seq\": " << a.sequence
                 << ", \"action\": \"" << a.action
                 << "\", \"protocol\": \"" << a.protocol
                 << "\", \"src\": \"" << a.src
                 << "\", \"dst\": \"" << a.dst << "\" }";
            if (i + 1 < cfg_.acl_in.size()) json << ",";
            json << "\n";
        }
        json << "  ],\n";

        // QoS.
        json << "  \"qos\": {\n";
        json << "    \"classes\": [\n";
        for (size_t i = 0; i < cfg_.qos.classes.size(); ++i) {
            const auto& tc = cfg_.qos.classes[i];
            json << "      { \"cos\": " << tc.cos
                 << ", \"dscp\": " << tc.dscp
                 << ", \"queue\": " << tc.queue
                 << ", \"strict\": " << (tc.strict_priority ? "true" : "false")
                 << ", \"bandwidth_pct\": " << tc.bandwidth_pct
                 << ", \"pfc\": " << (tc.pfc_enabled ? "true" : "false")
                 << " }";
            if (i + 1 < cfg_.qos.classes.size()) json << ",";
            json << "\n";
        }
        json << "    ]\n";
        json << "  },\n";

        // MLAG.
        json << "  \"mlag\": [\n";
        for (size_t i = 0; i < cfg_.mlag_domains.size(); ++i) {
            const auto& m = cfg_.mlag_domains[i];
            json << "    { \"domain_id\": \"" << m.domain_id
                 << "\", \"peer_ip\": \"" << m.peer_ip
                 << "\", \"peer_link\": \"" << m.peer_link
                 << "\", \"keepalive_interval\": " << m.keepalive_interval_s
                 << " }";
            if (i + 1 < cfg_.mlag_domains.size()) json << ",";
            json << "\n";
        }
        json << "  ]\n";

        json << "}\n";
        return json.str();
    }

    // Validate configuration.
    auto Validate() -> std::vector<std::string> {
        std::vector<std::string> errors;

        // Check port uniqueness.
        std::set<std::string> port_names;
        for (const auto& p : cfg_.ports) {
            if (!port_names.insert(p.name).second)
                errors.push_back("Duplicate port: " + p.name);
        }

        // Check VLAN uniqueness.
        std::set<VlanId> vlan_ids;
        for (const auto& v : cfg_.vlans) {
            if (!vlan_ids.insert(v.id).second)
                errors.push_back("Duplicate VLAN: " + std::to_string(static_cast<int>(v.id)));
        }

        // Check ACL sequence uniqueness.
        std::set<int> seqs;
        for (const auto& a : cfg_.acl_in) {
            if (!seqs.insert(a.sequence).second)
                errors.push_back("Duplicate ACL sequence: " + std::to_string(a.sequence));
        }

        // Check MLAG peer links.
        for (const auto& m : cfg_.mlag_domains) {
            if (m.peer_ip.empty())
                errors.push_back("MLAG " + m.domain_id + " missing peer IP");
        }

        // Warn if MTU is not jumbo-friendly.
        if (cfg_.mtu < 9000)
            errors.push_back("MTU " + std::to_string(cfg_.mtu) + " < 9000, jumbo frames not enabled");

        return errors;
    }

private:
    static auto RoleToString(SwitchRole r) -> const char* {
        switch (r) {
            case SwitchRole::Leaf:   return "leaf";
            case SwitchRole::Spine:  return "spine";
            case SwitchRole::Border: return "border";
        }
        return "unknown";
    }

    static auto PortModeToString(PortMode m) -> const char* {
        switch (m) {
            case PortMode::Access:  return "access";
            case PortMode::Trunk:   return "trunk";
            case PortMode::Routed:  return "routed";
            case PortMode::Monitor: return "monitor";
        }
        return "unknown";
    }

    const SwitchConfig& cfg_;
};

// ====================================================================
// Demonstration: build a typical HFT leaf config, validate, and print.
// ====================================================================
auto main() -> int {
    std::cout << "=== Network Switch Configuration Generator ===\n\n";

    // Build a sample leaf switch config.
    SwitchConfig cfg;
    cfg.hostname = "HFT-LEAF-01";
    cfg.role     = SwitchRole::Leaf;
    cfg.mgmt_ip  = "10.0.10.1";
    cfg.mtu      = 9216;

    // VLANs.
    cfg.vlans = {
        {VlanId::Management, "mgmt",    "10.0.10.0/24", "10.0.10.1"},
        {VlanId::Production, "prod",    "10.0.20.0/24", "10.0.20.1"},
        {VlanId::TestDev,    "testdev", "10.0.30.0/24", "10.0.30.1"},
        {VlanId::PTP,        "ptp",     "10.0.100.0/24","10.0.100.1"},
    };

    // Ports.
    PortConfig uplink1{"Ethernet1/1", PortMode::Trunk, VlanId::Production,
                       {VlanId::Management, VlanId::Production, VlanId::PTP}, 100};
    PortConfig uplink2{"Ethernet1/2", PortMode::Trunk, VlanId::Production,
                       {VlanId::Management, VlanId::Production, VlanId::PTP}, 100};
    PortConfig server1{"Ethernet2/1", PortMode::Access, VlanId::Production, {}, 25};
    PortConfig server2{"Ethernet2/2", PortMode::Access, VlanId::Production, {}, 25};
    PortConfig mdata_port{"Ethernet3/1", PortMode::Access, VlanId::Production, {}, 100,
                          true, true, true, "", 5, "Market data feed"};
    PortConfig span_port{"Ethernet4/1", PortMode::Monitor};

    cfg.ports = {uplink1, uplink2, server1, server2, mdata_port, span_port};

    // ACLs: block non-essential traffic to production.
    cfg.acl_in = {
        {10, "permit", "tcp", "10.0.10.0/24", "any", "10.0.20.0/24", "eq 80"},
        {20, "permit", "udp", "192.168.1.100", "any", "10.0.20.0/24", "eq 5000"},
        {30, "permit", "udp", "any", "any", "10.0.100.0/24", "eq 319"}, // PTP
        {40, "deny", "ip", "any", "any", "any", "any"},
    };

    // QoS: market data highest priority.
    cfg.qos.classes = {
        {7, 56, 3, true, 0, false},    // PTP
        {5, 46, 2, true, 0, false},    // Market data
        {4, 26, 1, false, 30, false},  // Order entry
        {3, 24, 1, false, 30, false},  // RoCEv2 with PFC
        {0, 0, 0, false, 40, false},   // Best effort
    };

    // MLAG.
    MlagDomain mlag{"1", "10.0.10.2", "port-channel100"};
    cfg.mlag_domains.push_back(mlag);

    // Generate and validate.
    SwitchConfigGenerator gen{cfg};

    auto errors = gen.Validate();
    if (!errors.empty()) {
        std::cout << "Validation errors:\n";
        for (const auto& e : errors)
            std::cout << "  - " << e << "\n";
        std::cout << "\n";
    } else {
        std::cout << "Configuration validated successfully.\n\n";
    }

    std::string json = gen.ToJSON();
    std::cout << "Generated JSON (" << json.size() << " B):\n";
    std::cout << json.substr(0, 2000) << "...\n";

    // Write to file.
    std::ofstream out("/tmp/hft_leaf_config.json");
    out << json;
    out.close();
    std::cout << "Wrote /tmp/hft_leaf_config.json\n\n";

    std::cout << "=== Deployment Recommendations ===\n";
    std::cout << "1. Use an automation framework (Ansible, Nornir) to push configs\n";
    std::cout << "2. Pre-stage configs via Zero Touch Provisioning (ZTP)\n";
    std::cout << "3. Backup running config before applying changes\n";
    std::cout << "4. Use out-of-band mgmt for config pushes (never in-band)\n";
    std::cout << "5. For Arista: EOS configlets. For Cisco: NX-OS\n";
    std::cout << "6. Validate post-deploy: ping, traceroute, packet loss\n";

    return 0;
}
```
