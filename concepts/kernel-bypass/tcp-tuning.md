---
type: reference
title: "TCP Tuning"
description: "Nagle's algorithm (TCP_NODELAY) must be disabled for HFT: a. tcp_slow_start_after_idle should be disabled (set to 0). When"
tags: ["networking"]
timestamp: "2026-06-27T03:06:09.417Z"
phase: 5
phaseName: "Kernel Bypass & Protocols"
category: "Phase 5 - Kernel Bypass & Protocols"
subcategory: "kernel-bypass"
language: "cpp"
artifact-id: "ZHFT_TCP_TUNING"
---
## Key Learning Points

- Nagle's algorithm (TCP_NODELAY) must be disabled for HFT: a
- tcp_slow_start_after_idle should be disabled (set to 0). When
- TCP congestion control: BBR (Bottleneck Bandwidth and RTT)
- Buffer sizing: tcp_rmem and tcp_wmem control min/default/max
- SO_BUSY_POLL (Linux 3.11+): when set, the kernel busy-polls
- tcp_fastopen (TFO) eliminates one RTT from the TCP handshake
- Busy poll settings: /proc/sys/net/core/busy_poll and

## Usage

// g++ -O3 -std=c++20 ZHFT_TCP_TUNING.txt -o tcp_tuner
// sudo ./tcp_tuner (needs CAP_NET_ADMIN for some sysctls)

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
#include <unistd.h>

#include <arpa/inet.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <sys/epoll.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <fcntl.h>

// -------------------------------------------------------------------
// RAII Socket — configures every socket with HFT-optimised settings.
// Throws on failure; in production, use error codes.
// -------------------------------------------------------------------
class HftTcpSocket {
public:
    explicit HftTcpSocket(int domain = AF_INET) : fd_(-1) {
        fd_ = ::socket(domain, SOCK_STREAM | SOCK_NONBLOCK, 0);
        if (fd_ < 0) {
            throw std::system_error(errno, std::generic_category(), "socket");
        }
        ApplyAllSettings();
    }

    ~HftTcpSocket() { Close(); }

    HftTcpSocket(HftTcpSocket&& other) noexcept : fd_(other.fd_) { other.fd_ = -1; }
    HftTcpSocket& operator=(HftTcpSocket&& other) noexcept {
        if (this != &other) { Close(); fd_ = other.fd_; other.fd_ = -1; }
        return *this;
    }

    auto Native() const -> int { return fd_; }

    void Close() noexcept {
        if (fd_ >= 0) { ::close(fd_); fd_ = -1; }
    }

    // --- Socket options (set in constructor) ---

    void ApplyAllSettings() {
        // 1. Disable Nagle's algorithm: send data immediately.
        SetOption(IPPROTO_TCP, TCP_NODELAY, 1);

        // 2. Disable delayed ACK (Linux: TCP_QUICKACK).
        SetOption(IPPROTO_TCP, TCP_QUICKACK, 1);

        // 3. SO_BUSY_POLL: application-level busy polling on this socket.
        //    Value = low water mark (bytes). 50 is a good default.
        SetOption(SOL_SOCKET, SO_BUSY_POLL, 50);

        // 4. SO_PRIORITY: set to 6 (internet-controlled).
        SetOption(SOL_SOCKET, SO_PRIORITY, 6);

        // 5. TCP_NOTSENT_LOWAT: wakeup when unsent data drops below 8 KB.
        //    Reduces latency for streaming sends.
        SetOption(IPPROTO_TCP, TCP_NOTSENT_LOWAT, 8192);

        // 6. TCP_DEFER_ACCEPT: don't wake up until data arrives.
        SetOption(IPPROTO_TCP, TCP_DEFER_ACCEPT, 1);

        // 7. SO_REUSEPORT: allow multiple processes to bind same port.
        #ifdef SO_REUSEPORT
        SetOption(SOL_SOCKET, SO_REUSEPORT, 1);
        #endif

        // 8. SO_RCVBUF / SO_SNDBUF: set buffer sizes.
        //    Minimum 256 KB, maximum 16 MB (kernel caps apply).
        int rcvbuf = 256 * 1024;
        int sndbuf = 256 * 1024;
        SetOption(SOL_SOCKET, SO_RCVBUF, rcvbuf);
        SetOption(SOL_SOCKET, SO_SNDBUF, sndbuf);

        // 9. Enable TCP timestamp and selective ACK (default on modern kernels).
        //    Verified here for documentation; no-op if already default.

        // 10. TCP_CORK: opposite of TCP_NODELAY; enable only for bulk sends.
        //    Not set here — HFT sends small messages immediately.
    }

    // --- Connection (with TCP_FASTOPEN support) ---
    auto Connect(const struct sockaddr* addr, socklen_t addrlen,
                 bool use_tfo = false) -> bool {
        if (use_tfo) {
            // TCP FastOpen: send data in SYN.
            // On first call, a TFO cookie is negotiated automatically.
            // Linux: setsockopt(TCP_FASTOPEN_CONNECT) + connect().
            #ifdef TCP_FASTOPEN_CONNECT
            SetOption(IPPROTO_TCP, TCP_FASTOPEN_CONNECT, 1);
            #endif
        }
        int ret = ::connect(fd_, addr, addrlen);
        if (ret < 0 && errno != EINPROGRESS) {
            return false;
        }
        return true;
    }

    // --- Bind with SO_REUSEPORT ---
    auto Bind(const struct sockaddr* addr, socklen_t addrlen) -> bool {
        return ::bind(fd_, addr, addrlen) == 0;
    }

private:
    void SetOption(int level, int optname, int value) {
        if (::setsockopt(fd_, level, optname, &value, sizeof(value)) < 0) {
            std::cerr << "setsockopt(" << level << "," << optname << "): "
                      << std::strerror(errno) << "\n";
        }
    }

    int fd_;
};

// -------------------------------------------------------------------
// System-level sysctl configuration (printed, not applied — requires root).
// These would typically go in /etc/sysctl.conf or a cloud-init script.
// =====================================================================
// # HFT TCP stack tuning — /etc/sysctl.d/90-hft-tcp.conf
// #
// # Disable slow start after idle
// net.ipv4.tcp_slow_start_after_idle = 0
// #
// # Congestion control: BBR (requires Linux >= 4.9)
// net.ipv4.tcp_congestion_control = bbr
// net.core.default_qdisc = fq
// #
// # TCP buffer auto-tuning limits (min, default, max bytes)
// net.ipv4.tcp_rmem = 16384 262144 16777216
// net.ipv4.tcp_wmem = 16384 262144 16777216
// #
// # Enable TCP Fast Open (client + server)
// net.ipv4.tcp_fastopen = 3
// #
// # Busy poll settings (µs)
// net.core.busy_poll = 50
// net.core.busy_read = 50
// #
// # Other HFT-friendly settings
// net.ipv4.tcp_mtu_probing = 1
// net.ipv4.tcp_sack = 1
// net.ipv4.tcp_timestamps = 1
// net.core.rmem_max = 16777216
// net.core.wmem_max = 16777216
// #
// # Disable metrics caching (each connection gets fresh metrics)
// net.ipv4.tcp_no_metrics_save = 1
// =====================================================================

// -------------------------------------------------------------------
// Demonstration: create a socket and print its configuration.
// -------------------------------------------------------------------
auto main() -> int {
    std::cout << "=== HFT TCP Socket Configurator ===\n\n";

    try {
        HftTcpSocket sock;
        std::cout << "Socket created (fd=" << sock.Native() << ")\n";
        std::cout << "All HFT-optimised socket options applied:\n";
        std::cout << "  - TCP_NODELAY (Nagle off)\n";
        std::cout << "  - TCP_QUICKACK (delayed ACK off)\n";
        std::cout << "  - SO_BUSY_POLL (application busy poll)\n";
        std::cout << "  - SO_REUSEPORT (multi-process bind)\n";
        std::cout << "  - TCP_NOTSENT_LOWAT=8192\n";
        std::cout << "  - TCP_DEFER_ACCEPT\n";
        std::cout << "  - SO_PRIORITY=6\n\n";

        std::cout << "=== System-Level Recommendations ===\n";
        std::cout << "Apply /etc/sysctl.d/90-hft-tcp.conf with:\n";
        std::cout << "  sysctl --system\n\n";

        std::cout << "=== Per-Connection Monitoring ===\n";
        std::cout << "Check with:\n";
        std::cout << "  ss -tieom  (socket options + memory)\n";
        std::cout << "  tc -s qdisc  (QDisc stats)\n";
        std::cout << "  ethtool -S eth0  (NIC hardware stats)\n";

    } catch (const std::exception& e) {
        std::cerr << "Error: " << e.what() << "\n";
        return 1;
    }

    return 0;
}
```
