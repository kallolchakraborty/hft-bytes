---
type: reference
title: "Data Center Networking for HFT"
description: "BGP peering with exchanges, PIM-SM multicast distribution for market data, VXLAN/EVPN for cross-facility connectivity, PFC/ECN flow control, cut-through vs store-and-forward switching, switch ASIC latency comparison (Arista, Cisco, Mellanox)."
tags: ["infrastructure"]
timestamp: "2026-06-27T03:40:00.000Z"
phase: 6
phaseName: "Network Hardware"
category: "Network Hardware"
subcategory: "network-hardware"
language: "cpp"
artifact-id: "ZHFT_DC_NETWORKING"
---
## Key Learning Points

- BGP peering with exchanges: exchange announces market-data multicast groups via BGP; each trading firm runs a BGP session (eBGP multi-hop) to receive routes; `no-export` community prevents route propagation beyond colo
- PIM-SM for multicast market data: every market-data feed uses PIM-SM (Protocol Independent Multicast — Sparse Mode); Rendezvous Point (RP) per facility; Shortest Path Tree (SPT) switchover after first packet; IGMP/MLD joins for each group
- VXLAN/EVPN: extend Layer 2 between colo cabinets and cross-datacenter links; VXLAN tunnels encapsulate market-data multicast; EVPN controls MAC/VNI route distribution; adds ~50-100ns overhead per packet
- PFC (Priority Flow Control): per-priority pause frames prevent packet loss on congested links; critical for market-data feeds where a single lost packet causes gap recovery; must be configured only on market-data VLANs (not admin traffic)
- ECN (Explicit Congestion Notification): switches mark congestion in IP headers before dropping; end-host DCTCP/DCQCN reduces send rate; prevents tail-drop latency spikes
- Cut-through vs store-and-forward: cut-through switches forward as soon as header is parsed (~100-200ns cut-through vs ~1-5us store-and-forward for 1500B packet); all HFT colo switches use cut-through
- Switch ASIC latency: Arista 7130 (Broadcom Tomahawk) ~200ns, Cisco Nexus 3550 (Silicon One) ~250ns, Mellanox SN4600 (Spectrum-3) ~300ns; Arista Arctica for P4-programmable latency

## Usage

```cpp
// BGP session configuration (simplified)
// BGP config for exchange peering:
// router bgp 65001
//   neighbor 10.1.1.1 remote-as 12345
//   address-family ipv4 multicast
//     neighbor 10.1.1.1 activate
//     network 224.0.0.0/4

// PIM-SM RP configuration
// ip pim rp-address 10.0.0.1 group-list MARKET_DATA_GROUPS
// ip pim spt-threshold infinity   // stay on RP tree if preferred
// ip igmp version 3

// VLAN mapping for HFT (example):
// VLAN 100: CME MDP primary
// VLAN 101: CME MDP backup
// VLAN 200: Eurex T7 primary
// VLAN 201: Eurex T7 backup
// VLAN 300: Admin/management (loss-tolerant)

// Switch latency comparison (one-way, cut-through, 64B packet):
// ┌────────────┬───────────────┬──────────┬──────────┐
// │ Switch     │ ASIC          │ Latency  │ P4-cap  │
// ├────────────┼───────────────┼──────────┼──────────┤
// │ Arista 7130│ Tomahawk 4    │  ~200ns  │  No      │
// │ Cisco 3550 │ Silicon One   │  ~250ns  │  Yes     │
// │ Mellanox   │ Spectrum-3    │  ~300ns  │  No      │
// │ Arista     │ Arctica       │  <100ns  │  Yes     │
// └────────────┴───────────────┴──────────┴──────────┘
```

## Source Code

```cpp
// IGMP join for multicast market-data group
// # ip maddr add 233.50.130.10 dev eth0
// # echo "3" > /proc/sys/net/ipv4/conf/eth0/force_igmp_version

// Verify PIM neighbor state:
// # show ip pim neighbor
// # show ip mroute 233.50.130.10

// PFC configuration (DCBX)
// # lldptool -T -i eth0 -V PFC enableTx=yes
// # lldptool -T -i eth0 -V PFC priorityMap=0:0,1:0,...,3:3,...

// Cut-through verification:
// # show hardware capacity | grep forwarding-mode
// forwarding-mode: cut-through
```
