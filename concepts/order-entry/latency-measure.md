---
type: reference
title: "Latency Measure"
description: "SO_TIMESTAMPING: Linux NIC hardware timestamps at the PHY level.. PTP (IEEE 1588) clock synchronization: grandmaster clock via GPS,"
tags: ["performance"]
difficulty: advanced
timestamp: "2026-06-27T03:06:09.426Z"
phase: 7
phaseName: "Order Entry & Execution"
category: "Phase 7 - Order Entry & Execution"
subcategory: "order-entry"
language: "cpp"
artifact-id: "ZHFT_LATENCY_MEASURE"
---
## Key Learning Points

- SO_TIMESTAMPING: Linux NIC hardware timestamps at the PHY level.
- PTP (IEEE 1588) clock synchronization: grandmaster clock via GPS,
- Coordinated omission: when measuring latency, exclude the time the
- HDR Histogram: records latency with configurable precision (e.g., 3
- Tick-to-trade waterfall: decompose latency into NIC -> kernel ->

## Usage

// LatencyHarness lh("eth0");
// lh.start();  // background measurement thread
// ... trade ...
// lh.recordTickToTrade(tick_ns, trade_ns);
// auto hdr = lh.histogram();
// printf("p50=%.3f p99=%.3f\n", hdr.percentile(50), hdr.percentile(99));

## Source Code

```cpp
#include <algorithm>
#include <array>
#include <atomic>
#include <bit>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <fstream>
#include <linux/ethtool.h>
#include <linux/net_tstamp.h>
#include <linux/sockios.h>
#include <net/if.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <unistd.h>
#include <vector>

// ---------------------------------------------------------------------------
// HDR Histogram (simplified — 2 significant figures, 1 ns to 1 s)
// ---------------------------------------------------------------------------
class HdrHistogram {
public:
  static constexpr uint64_t kLow  = 1;        // 1 ns
  static constexpr uint64_t kHigh = 1'000'000'000; // 1 s
  static constexpr int kSigFigs = 3;

  HdrHistogram() {
    // Compute bucket count based on sig figs
    // Simplified: linear-exponential hybrid
    buckets_.resize(numBuckets(), 0);
  }

  void record(uint64_t value) {
    if (value < kLow) value = kLow;
    if (value > kHigh) value = kHigh;
    size_t idx = bucketIndex(value);
    buckets_[idx].fetch_add(1, std::memory_order_relaxed);
    total_count_.fetch_add(1, std::memory_order_relaxed);
  }

  double percentile(double p) const {
    uint64_t target = static_cast<uint64_t>(total_count_.load() * p / 100.0);
    uint64_t cumulative = 0;
    for (size_t i = 0; i < buckets_.size(); i++) {
      cumulative += buckets_[i].load(std::memory_order_relaxed);
      if (cumulative >= target) {
        return valueFromIndex(i);
      }
    }
    return kHigh;
  }

  void reset() {
    for (auto &b : buckets_) b.store(0, std::memory_order_relaxed);
    total_count_.store(0, std::memory_order_relaxed);
  }

private:
  std::vector<std::atomic<uint64_t>> buckets_;
  std::atomic<uint64_t> total_count_{0};

  size_t numBuckets() const {
    // 3 sig figs over [1, 1e9] => ~3000 buckets (simplified)
    return 4096;
  }

  size_t bucketIndex(uint64_t v) const {
    // CRITICAL: use leading-zero count for log2
    int msb = 63 - __builtin_clzll(v);
    uint64_t sub = (v >> (msb - 3)) & 0x7; // 3-bit mantissa
    return (msb << 3) | sub;
  }

  double valueFromIndex(size_t idx) const {
    int msb = static_cast<int>(idx >> 3);
    uint64_t sub = idx & 0x7;
    return static_cast<double>((1ULL << msb) | (sub << (msb - 3)));
  }
};

// ---------------------------------------------------------------------------
// NIC hardware timestamping
// ---------------------------------------------------------------------------
class NicTimestamp {
public:
  explicit NicTimestamp(const char *iface) {
    fd_ = ::socket(PF_PACKET, SOCK_RAW, htons(ETH_P_ALL));
    if (fd_ < 0) return;

    // Enable HW timestamping
    struct ifreq ifr{};
    std::strncpy(ifr.ifr_name, iface, IFNAMSIZ - 1);

    struct hwtstamp_config hwc{};
    hwc.tx_type = HWTSTAMP_TX_ON;
    hwc.rx_filter = HWTSTAMP_FILTER_ALL;
    ifr.ifr_data = reinterpret_cast<char *>(&hwc);

    if (::ioctl(fd_, SIOCSHWTSTAMP, &ifr) < 0) {
      // Fall back to software timestamps
      hw_available_ = false;
    }

    int flags = (SOF_TIMESTAMPING_TX_HARDWARE |
                 SOF_TIMESTAMPING_RX_HARDWARE |
                 SOF_TIMESTAMPING_RAW_HARDWARE);
    if (!hw_available_) {
      flags = (SOF_TIMESTAMPING_TX_SOFTWARE |
               SOF_TIMESTAMPING_RX_SOFTWARE |
               SOF_TIMESTAMPING_SOFTWARE);
    }
    ::setsockopt(fd_, SOL_SOCKET, SO_TIMESTAMPING,
                 &flags, sizeof(flags));
  }

  struct Timestamps {
    uint64_t sw;  // Software timestamp (ns)
    uint64_t hw;  // Hardware timestamp (ns)
  };

  bool read(Timestamps *ts) {
    // On every recvmsg, the kernel adds ancillary data with timestamps.
    // This function would be called after recvmsg().
    // Simplified: read from control message (cmsg) with SOL_SOCKET/SCM_TIMESTAMPING.
    return hw_available_;
  }

  ~NicTimestamp() {
    if (fd_ >= 0) ::close(fd_);
  }

private:
  int fd_ = -1;
  bool hw_available_ = true;
};

// ---------------------------------------------------------------------------
// Tick-to-trade waterfall measurement
// ---------------------------------------------------------------------------
struct TickToTrade {
  uint64_t tick_arrival;    // HW timestamp when market data packet arrived
  uint64_t feed_decode;     // After feed handler parsing
  uint64_t risk_check;      // After pre-trade risk
  uint64_t sor_selection;   // After venue selection
  uint64_t order_encode;    // After FIX/SBE encoding
  uint64_t tx_timestamp;    // HW timestamp when packet left NIC

  double latency_us() const {
    return (tx_timestamp - tick_arrival) / 1000.0;
  }

  void decompose() const {
    // Show each hop
  }
};

// ---------------------------------------------------------------------------
// Latency measurement harness
// ---------------------------------------------------------------------------
class LatencyHarness {
public:
  LatencyHarness(const char *iface, size_t sample_interval_ms = 1000)
      : nic_(iface), interval_ms_(sample_interval_ms) {}

  void recordTickToTrade(uint64_t tick, uint64_t trade) {
    uint64_t lat = trade - tick;
    histogram_.record(lat);
    // TRADEOFF: every-record is expensive at 1M+ trades/sec.
    // Consider sampling 1:1000 for high-throughput strategies.
  }

  void printReport() {
    printf("Latency report (ns):\n");
    printf("  p50   = %.0f\n", histogram_.percentile(50));
    printf("  p90   = %.0f\n", histogram_.percentile(90));
    printf("  p99   = %.0f\n", histogram_.percentile(99));
    printf("  p99.9 = %.0f\n", histogram_.percentile(99.9));
    printf("  max   = %.0f\n", histogram_.percentile(100));
  }

  HdrHistogram &histogram() { return histogram_; }

private:
  NicTimestamp nic_;
  HdrHistogram histogram_;
  size_t interval_ms_;
};
```
