---
type: reference
title: "UDP Multicast"
description: "IGMPv3 supports Source-Specific Multicast (SSM), where a receiver. PIM-SM (Protocol Independent Multicast — Sparse Mode) builds"
tags: ["networking"]
difficulty: advanced
timestamp: "2026-06-27T03:06:09.417Z"
phase: 5
phaseName: "Kernel Bypass & Protocols"
category: "Phase 5 - Kernel Bypass & Protocols"
subcategory: "kernel-bypass"
language: "cpp"
artifact-id: "ZHFT_UDP_MULTICAST"
---
## Key Learning Points

- IGMPv3 supports Source-Specific Multicast (SSM), where a receiver
- PIM-SM (Protocol Independent Multicast — Sparse Mode) builds
- Multicast group management: use setsockopt(IP_ADD_SOURCE_MEMBERSHIP)
- 0.0.0/4 (IPv4) or ff00::/8 (IPv6).
- MTU considerations: exchange feeds typically use ~1500 B Ethernet
- SO_REUSEPORT allows multiple processes/threads to bind the same
- Kernel timestamping: enable SO_TIMESTAMPNS or use PTP hardware
- Buffer sizing: SO_RCVBUF must be large enough to absorb bursts

## Usage

// g++ -O3 -std=c++20 ZHFT_UDP_MULTICAST.txt -o multicast_recv
// sudo ./multicast_recv 232.1.1.1 5000 192.168.1.100

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
#include <span>
#include <string_view>
#include <system_error>
#include <thread>

#include <arpa/inet.h>
#include <linux/errqueue.h>
#include <linux/net_tstamp.h>
#include <net/if.h>
#include <netdb.h>
#include <netinet/igmp.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <unistd.h>

// -------------------------------------------------------------------
// RAII multicast receiver with SSM join + kernel timestamping.
// -------------------------------------------------------------------
class MulticastReceiver {
public:
    MulticastReceiver(std::string_view group_ip, uint16_t port,
                      std::string_view source_ip,
                      std::string_view interface_ip = "0.0.0.0",
                      bool enable_timestamps = true)
        : fd_(-1)
    {
        fd_ = ::socket(AF_INET, SOCK_DGRAM, 0);
        if (fd_ < 0) {
            throw std::system_error(errno, std::generic_category(), "socket");
        }

        // Enable SO_REUSEPORT for multi-process / multi-thread.
        int reuse = 1;
        if (::setsockopt(fd_, SOL_SOCKET, SO_REUSEPORT, &reuse, sizeof(reuse)) < 0) {
            std::perror("SO_REUSEPORT");
        }

        // Bind to the multicast port (must bind to INADDR_ANY or the
        // specific interface IP, NOT the group address).
        struct sockaddr_in bind_addr{};
        bind_addr.sin_family = AF_INET;
        bind_addr.sin_port   = htons(port);
        bind_addr.sin_addr.s_addr = htonl(INADDR_ANY);
        if (::bind(fd_, reinterpret_cast<struct sockaddr*>(&bind_addr),
                   sizeof(bind_addr)) < 0) {
            throw std::system_error(errno, std::generic_category(), "bind");
        }

        // SSM join: (S, G) = (source_ip, group_ip).
        struct ip_mreq_source mreq{};
        ::inet_pton(AF_INET, group_ip.data(),  &mreq.imr_multiaddr);
        ::inet_pton(AF_INET, source_ip.data(), &mreq.imr_sourceaddr);
        mreq.imr_interface.s_addr = htonl(INADDR_ANY);

        if (::setsockopt(fd_, IPPROTO_IP, IP_ADD_SOURCE_MEMBERSHIP,
                         &mreq, sizeof(mreq)) < 0) {
            // Fallback to ASM join (any source).
            std::perror("IP_ADD_SOURCE_MEMBERSHIP (fallback to ASM)");
            struct ip_mreq fallback{};
            fallback.imr_multiaddr = mreq.imr_multiaddr;
            fallback.imr_interface.s_addr = htonl(INADDR_ANY);
            if (::setsockopt(fd_, IPPROTO_IP, IP_ADD_MEMBERSHIP,
                             &fallback, sizeof(fallback)) < 0) {
                throw std::system_error(errno, std::generic_category(), "IP_ADD_MEMBERSHIP");
            }
        }

        // Increase receive buffer.
        int rcvbuf = 64 * 1024 * 1024;
        if (::setsockopt(fd_, SOL_SOCKET, SO_RCVBUF, &rcvbuf, sizeof(rcvbuf)) < 0) {
            std::perror("SO_RCVBUF");
        }

        // Enable kernel timestamping for RX.
        if (enable_timestamps) {
            int ts_flags = SOF_TIMESTAMPING_RX_HARDWARE |
                           SOF_TIMESTAMPING_RX_SOFTWARE |
                           SOF_TIMESTAMPING_SOFTWARE;
            if (::setsockopt(fd_, SOL_SOCKET, SO_TIMESTAMPING,
                             &ts_flags, sizeof(ts_flags)) < 0) {
                // If hardware timestamps not available, try software only.
                ts_flags = SOF_TIMESTAMPING_RX_SOFTWARE | SOF_TIMESTAMPING_SOFTWARE;
                ::setsockopt(fd_, SOL_SOCKET, SO_TIMESTAMPING,
                             &ts_flags, sizeof(ts_flags));
            }
        }

        // Enable IP_PKTINFO so we can see the destination address per-packet.
        int pktinfo = 1;
        ::setsockopt(fd_, IPPROTO_IP, IP_PKTINFO, &pktinfo, sizeof(pktinfo));
    }

    ~MulticastReceiver() { if (fd_ >= 0) ::close(fd_); }

    // Non-copyable, movable.
    MulticastReceiver(const MulticastReceiver&) = delete;
    MulticastReceiver& operator=(const MulticastReceiver&) = delete;
    MulticastReceiver(MulticastReceiver&& other) noexcept : fd_(other.fd_) {
        other.fd_ = -1;
    }

    // -----------------------------------------------------------------
    // Receive a single datagram with timestamp extraction.
    // Returns the number of bytes received, or -1 on error.
    // -----------------------------------------------------------------
    struct RecvResult {
        int                  bytes;
        std::chrono::nanoseconds timestamp;     // from kernel
        struct sockaddr_in   src_addr;
    };

    auto Recv(std::span<char> buf) -> RecvResult {
        // Use recvmsg() to get ancillary data (timestamps, pktinfo).
        struct sockaddr_in src_addr{};
        struct iovec iov{};
        iov.iov_base = buf.data();
        iov.iov_len  = buf.size();

        // Control message buffer for timestamps + pktinfo.
        std::array<char, 1024> cmsg_buf{};

        struct msghdr msg{};
        msg.msg_name       = &src_addr;
        msg.msg_namelen    = sizeof(src_addr);
        msg.msg_iov        = &iov;
        msg.msg_iovlen     = 1;
        msg.msg_control    = cmsg_buf.data();
        msg.msg_controllen = cmsg_buf.size();

        int ret = ::recvmsg(fd_, &msg, 0);
        if (ret < 0) return {ret, std::chrono::nanoseconds::zero(), src_addr};

        // Parse control messages for timestamp.
        auto ts = std::chrono::nanoseconds::zero();
        struct cmsghdr* cmsg = CMSG_FIRSTHDR(&msg);
        while (cmsg) {
            if (cmsg->cmsg_level == SOL_SOCKET &&
                cmsg->cmsg_type  == SO_TIMESTAMPNS) {
                // Kernel provided nanotime.
                struct timespec* tv = reinterpret_cast<struct timespec*>(CMSG_DATA(cmsg));
                ts = std::chrono::seconds{tv->tv_sec} +
                     std::chrono::nanoseconds{tv->tv_nsec};
            }
            // For hardware timestamps, check SCM_TIMESTAMPING.
            cmsg = CMSG_NXTHDR(&msg, cmsg);
        }

        return {ret, ts, src_addr};
    }

    auto NativeFd() const -> int { return fd_; }

private:
    int fd_;
};

// -------------------------------------------------------------------
// Helper: print multicast group membership (Linux /proc/net/igmp).
// -------------------------------------------------------------------
void DumpIGMPGroups() {
    std::FILE* fp = std::fopen("/proc/net/igmp", "r");
    if (!fp) return;
    std::array<char, 1024> line{};
    std::cout << "IGMP groups from /proc/net/igmp:\n";
    while (std::fgets(line.data(), static_cast<int>(line.size()), fp)) {
        std::cout << "  " << line.data();
    }
    std::fclose(fp);
}

// -------------------------------------------------------------------
// Demonstration: listen on a multicast group for 10 packets.
// -------------------------------------------------------------------
auto main(int argc, char** argv) -> int {
    if (argc < 4) {
        std::cerr << "Usage: " << argv[0]
                  << " <group_ip> <port> <source_ip> [interface_ip]\n";
        std::cerr << "Example: " << argv[0] << " 232.1.1.1 5000 192.168.1.100\n";
        return 1;
    }

    std::string_view group_ip = argv[1];
    uint16_t         port     = static_cast<uint16_t>(std::atoi(argv[2]));
    std::string_view source_ip = argv[3];
    std::string_view iface_ip = (argc > 4) ? argv[4] : "0.0.0.0";

    try {
        MulticastReceiver receiver(group_ip, port, source_ip, iface_ip, true);

        std::cout << "=== UDP Multicast Receiver ===\n";
        std::cout << "Group: " << group_ip << ":" << port << "\n";
        std::cout << "Source: " << source_ip << "\n";
        std::cout << "Listening...\n\n";

        // Receive 5 packets and print timestamps.
        std::array<char, 65536> buf{};
        for (int i = 0; i < 5; ++i) {
            auto result = receiver.Recv(buf);
            if (result.bytes < 0) {
                std::perror("recvmsg");
                break;
            }
            auto ts_ns = result.timestamp.time_since_epoch().count();
            char src[INET_ADDRSTRLEN];
            ::inet_ntop(AF_INET, &result.src_addr.sin_addr, src, sizeof(src));
            std::cout << "[" << i << "] " << result.bytes << " B from "
                      << src << ":" << ntohs(result.src_addr.sin_port);
            if (ts_ns > 0) {
                std::cout << " @ " << (ts_ns / 1000) << " µs since epoch";
            }
            std::cout << "\n";
        }

        std::cout << "\n=== Configuration Check ===\n";
        DumpIGMPGroups();

    } catch (const std::exception& e) {
        std::cerr << "Error: " << e.what() << "\n";
        return 1;
    }

    return 0;
}
```
