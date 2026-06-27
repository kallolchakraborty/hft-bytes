---
type: reference
title: "Packet Capture"
description: "PF_RING DNA/FT (by ntop) provides zero-copy packet capture via. PACKET_MMAP (Linux kernel built-in, TPACKET_V3): uses mmap'd"
tags: ["phase-6"]
timestamp: "2026-06-27T03:06:09.420Z"
phase: 6
phaseName: "Network Hardware"
category: "Phase 6 - Network Hardware"
subcategory: "network-hardware"
language: "cpp"
artifact-id: "ZHFT_PACKET_CAPTURE"
---
## Key Learning Points

- PF_RING DNA/FT (by ntop) provides zero-copy packet capture via
- PACKET_MMAP (Linux kernel built-in, TPACKET_V3): uses mmap'd
- netmap (by Università di Pisa): lightweight framework that
- eBPF/XDP (eXpress Data Path): XDP programs run in the NIC
- AF_XDP (Linux 4.18+): socket family that connects eBPF/XDP
- For HFT tap/SPAN ports: the capture must never drop packets
- Zero-copy capture: the key principle is that packets move

## Usage

// XDP program: clang -O2 -target bpf -c kernel/xdp_filter.c -o xdp_filter.o
// Attach: ip link set dev eth0 xdp obj xdp_filter.o
//
// PACKET_MMAP: g++ -O3 -std=c++20 -DPACKET_MMAP ZHFT_PACKET_CAPTURE.txt -o capture
// sudo ./capture eth0

## Source Code

```cpp
// =====================================================================
// eBPF/XDP program for market data filtering (kernel space).
// Compile: clang -O2 -target bpf -c xdp_filter.c -o xdp_filter.o
// =====================================================================
/*
#include <linux/bpf.h>
#include <linux/if_ether.h>
#include <linux/ip.h>
#include <linux/udp.h>
#include <bpf/bpf_helpers.h>

// Market data exchange UDP ports.
#define PORT_A 5000
#define PORT_B 5001
#define PORT_C 5002

// XDP program: drop everything except UDP packets with specific ports.
SEC("xdp")
int xdp_filter_func(struct xdp_md *ctx) {
    void *data_end = (void *)(long)ctx->data_end;
    void *data     = (void *)(long)ctx->data;

    // Ethernet header.
    struct ethhdr *eth = data;
    if ((void *)(eth + 1) > data_end) return XDP_DROP;

    // Only IPv4.
    if (eth->h_proto != __constant_htons(ETH_P_IP)) return XDP_DROP;

    struct iphdr *ip = (struct iphdr *)(eth + 1);
    if ((void *)(ip + 1) > data_end) return XDP_DROP;

    // Only UDP.
    if (ip->protocol != IPPROTO_UDP) return XDP_DROP;

    struct udphdr *udp = (struct udphdr *)(ip + 1);
    if ((void *)(udp + 1) > data_end) return XDP_DROP;

    uint16_t dst_port = __constant_ntohs(udp->dest);

    // Allow only our market data ports.
    if (dst_port == PORT_A || dst_port == PORT_B || dst_port == PORT_C) {
        return XDP_PASS;    // pass to kernel (or AF_XDP)
    }

    return XDP_DROP;        // drop everything else
}

char _license[] SEC("license") = "GPL";
*/

// =====================================================================
// PACKET_MMAP (TPACKET_V3) capture loop (userspace).
// Needs CAP_NET_RAW / root.
// =====================================================================

#include <algorithm>
#include <array>
#include <cerrno>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <iostream>
#include <span>
#include <string_view>
#include <vector>

#include <arpa/inet.h>
#include <linux/filter.h>
#include <linux/if_ether.h>
#include <linux/if_packet.h>
#include <net/ethernet.h>
#include <net/if.h>
#include <sys/mman.h>
#include <sys/socket.h>
#include <unistd.h>

// ====================================================================
// PacketMMAP capture using TPACKET_V3 (requires Linux >= 3.2).
// ====================================================================
class PacketMMAPCapture {
public:
    PacketMMAPCapture(std::string_view iface, int block_size = 1 << 22,
                      int frame_size = 2048, int blocks = 8)
        : fd_(-1), mmap_base_(nullptr)
    {
        // Create AF_PACKET socket.
        fd_ = ::socket(AF_PACKET, SOCK_RAW, htons(ETH_P_ALL));
        if (fd_ < 0) {
            std::perror("socket"); return;
        }

        // Bind to interface.
        struct ifreq ifr{};
        std::strncpy(ifr.ifr_name, iface.data(), IFNAMSIZ - 1);
        if (::ioctl(fd_, SIOCGIFINDEX, &ifr) < 0) {
            std::perror("ioctl SIOCGIFINDEX"); return;
        }
        struct sockaddr_ll sll{};
        sll.sll_family   = AF_PACKET;
        sll.sll_protocol = htons(ETH_P_ALL);
        sll.sll_ifindex  = ifr.ifr_ifindex;
        if (::bind(fd_, reinterpret_cast<struct sockaddr*>(&sll),
                   sizeof(sll)) < 0) {
            std::perror("bind"); return;
        }

        // Set up TPACKET_V3 ring.
        int version = TPACKET_V3;
        if (::setsockopt(fd_, SOL_PACKET, PACKET_VERSION, &version,
                         sizeof(version)) < 0) {
            std::perror("PACKET_VERSION"); return;
        }

        struct tpacket_req3 req{};
        req.tp_block_size = block_size;
        req.tp_frame_size = frame_size;
        req.tp_block_nr   = blocks;
        req.tp_frame_nr   = (block_size / frame_size) * blocks;
        req.tp_retire_blk_tov = 0;          // no timeout -> poll
        req.tp_feature_req_word = 0;

        if (::setsockopt(fd_, SOL_PACKET, PACKET_RX_RING, &req,
                         sizeof(req)) < 0) {
            std::perror("PACKET_RX_RING"); return;
        }

        // mmap the ring buffer.
        std::size_t mmap_len = static_cast<std::size_t>(block_size) * blocks;
        mmap_base_ = ::mmap(nullptr, mmap_len,
                            PROT_READ | PROT_WRITE, MAP_SHARED, fd_, 0);
        if (mmap_base_ == MAP_FAILED) {
            std::perror("mmap"); mmap_base_ = nullptr; return;
        }

        // Parse block/frame geometry.
        frame_size_  = frame_size;
        block_size_  = block_size;
        blocks_      = blocks;
        frames_per_block_ = block_size / frame_size;

        std::cout << "[PacketMMAP] " << iface
                  << ": blocks=" << blocks
                  << ", block_size=" << (block_size / 1024) << " KB"
                  << ", frame_size=" << frame_size << " B\n";
    }

    ~PacketMMAPCapture() {
        if (mmap_base_) {
            ::munmap(mmap_base_,
                     static_cast<std::size_t>(block_size_) * blocks_);
        }
        if (fd_ >= 0) ::close(fd_);
    }

    // -----------------------------------------------------------------
    // Poll and process packets. Returns number of packets processed.
    // -----------------------------------------------------------------
    auto PollAndProcess(int max_packets = 1024) -> int {
        if (!mmap_base_) return -1;

        auto* block_iter = static_cast<struct tpacket_block_desc*>(mmap_base_);
        int processed = 0;

        for (int b = 0; b < blocks_; ++b) {
            struct tpacket_block_desc* block = block_iter + b;

            // Check block status (volatile because kernel updates it).
            auto status = __atomic_load_n(&block->hdr.bh1.block_status,
                                          __ATOMIC_ACQUIRE);

            if (!(status & TP_STATUS_USER)) {
                // Block not ready yet; poll returns.
                break;
            }

            // Parse frames inside the block.
            char* block_start = static_cast<char*>(mmap_base_) +
                                (static_cast<std::size_t>(b) * block_size_);
            auto* block_hdr = &block->hdr;

            int num_pkts = block_hdr->bh1.num_pkts;
            for (int f = 0; f < num_pkts && processed < max_packets; ++f) {
                auto* ppd = reinterpret_cast<struct tpacket3_hdr*>(
                    block_start + (f * frame_size_));

                int pkt_len = ppd->tp_snaplen;
                uint8_t* pkt_data = reinterpret_cast<uint8_t*>(
                    reinterpret_cast<char*>(ppd) + ppd->tp_net);

                // Process packet (callback or inline).
                // Example: parse Ethernet header.
                if (pkt_len >= static_cast<int>(sizeof(struct ethhdr))) {
                    auto* eth = reinterpret_cast<struct ethhdr*>(pkt_data);
                    (void)eth;  // do something with the packet
                }

                ++processed;
            }

            // Release block back to kernel.
            __atomic_store_n(&block->hdr.bh1.block_status,
                             TP_STATUS_KERNEL, __ATOMIC_RELEASE);
        }

        return processed;
    }

    auto Fd() const -> int { return fd_; }

private:
    int       fd_ = -1;
    void*     mmap_base_ = nullptr;
    int       frame_size_ = 0;
    int       block_size_ = 0;
    int       blocks_ = 0;
    int       frames_per_block_ = 0;
};

// ====================================================================
// Benchmark: compare poll vs capture methods.
// ====================================================================
auto main(int argc, char** argv) -> int {
    std::string iface = "eth0";
    if (argc > 1) iface = argv[1];

    std::cout << "=== Packet Capture at Line Rate ===\n\n";

    // PACKET_MMAP capture loop.
    PacketMMAPCapture capture{iface, 2 << 22, 2048, 8};

    std::cout << "\nPolling for packets on " << iface
              << " (Ctrl+C to stop)...\n";

    auto last_print = std::chrono::steady_clock::now();
    int total_packets = 0;

    for (int round = 0; round < 100; ++round) {
        int n = capture.PollAndProcess(1024);
        if (n > 0) total_packets += n;

        auto now = std::chrono::steady_clock::now();
        if (now - last_print >= std::chrono::seconds(1)) {
            std::cout << "  Packets: " << total_packets << "\n";
            last_print = now;
            total_packets = 0;
        }

        // Busy-poll: no sleep.
        asm volatile("pause");
    }

    std::cout << "\n=== Capture Methods Comparison ===\n";
    std::cout << "| Method        | Max PPS/core | Latency  | Kernel mod | License |\n";
    std::cout << "|---------------|--------------|----------|------------|--------|\n";
    std::cout << "| PF_RING FT    | ~30 M        | < 1 µs   | Yes        | Comm.  |\n";
    std::cout << "| PACKET_MMAP V3| ~5-10 M      | ~2-5 µs  | No (in-k)  | GPL    |\n";
    std::cout << "| netmap        | ~15-20 M     | ~1 µs    | Yes        | BSD    |\n";
    std::cout << "| AF_XDP        | ~20-25 M     | ~1 µs    | No (in-k)  | GPL    |\n";
    std::cout << "| XDP drop      | ~30-50 M     | < 100 ns | No (BPF)   | GPL    |\n";
    std::cout << "| FPGA capture  | > 100 M      | < 100 ns | No         | Custom |\n";

    return 0;
}
```
