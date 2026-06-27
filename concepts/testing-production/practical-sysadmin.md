---
type: reference
title: "Practical Sysadmin"
description: "OS updates without latency spikes: live patching (Ksplice, KernelCare) for. Log rotation without lock contention: use copytruncate mode (logrotate) and"
tags: ["phase-15"]
timestamp: "2026-06-27T03:06:09.454Z"
phase: 15
phaseName: "Testing & Production"
category: "Phase 15 - Testing & Production"
subcategory: "testing-production"
language: "cpp"
artifact-id: "ZHFT_PRACTICAL_SYSADMIN"
---
## Key Learning Points

- OS updates without latency spikes: live patching (Ksplice, KernelCare) for
- Log rotation without lock contention: use copytruncate mode (logrotate) and
- Monitoring agent CPU/noise avoidance: pin monitoring agents to isolated
- Backup strategy: hourly WAL archiving, daily full backup to S3, off-site
- Switch/firewall config backup: push config to Git on every change; monitor

## Source Code

```cpp
#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <functional>
#include <map>
#include <optional>
#include <set>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

// ---------------------------------------------------------------------------
// No-impact update scheduler — runs updates during maintenance windows.
// ---------------------------------------------------------------------------
struct UpdateWindow {
  // E.g., Sunday 02:00–04:00 UTC.
  uint8_t  day_of_week;   // 0=Sunday, 6=Saturday
  uint8_t  hour_start;    // 0-23
  uint8_t  hour_end;
};

class UpdateScheduler {
  std::vector<UpdateWindow> windows_;
  bool trading_hours_ = false;

public:
  void set_trading_hours(bool trading) { trading_hours_ = trading; }

  bool is_update_allowed() const {
    if (trading_hours_) return false; // Never update during market hours.

    auto now = std::chrono::system_clock::to_time_t(
        std::chrono::system_clock::now());
    struct tm *utc = gmtime(&now);

    for (const auto &w : windows_) {
      if (utc->tm_wday == w.day_of_week &&
          utc->tm_hour >= w.hour_start &&
          utc->tm_hour < w.hour_end) {
        return true;
      }
    }
    return false;
  }

  // Check if a specific process can be patched without latency impact.
  bool can_patch(const std::string &process_name) const {
    if (!is_update_allowed()) return false;
    // In production: check if the process is currently handling orders.
    return true;
  }
};

// ---------------------------------------------------------------------------
// Log rotation with zero-allocation — thread-local buffers + async writer.
// ---------------------------------------------------------------------------
struct PerThreadLogBuffer {
  static thread_local std::array<char, 4096> buffer;
  static thread_local size_t pos;

  static void append(const char *data, size_t len) {
    size_t to_write = std::min(len, buffer.size() - pos);
    std::memcpy(buffer.data() + pos, data, to_write);
    pos += to_write;
  }
};

thread_local std::array<char, 4096> PerThreadLogBuffer::buffer;
thread_local size_t                PerThreadLogBuffer::pos = 0;

class AsyncLogWriter {
  // Lock-free MPSC queue of full buffers.
  // Background thread dequeues and writes to disk without touching trading threads.
  // Implementation uses DPDK ring buffer or similar; omitted for brevity.

public:
  void flush() {
    // Called by background thread every 100ms.
    // Write all full buffers to rotating log files.
  }

  // Copytruncate-safe rotation signal.
  void rotate() {
    // Close current file, open new one, signal background thread.
  }
};

// ---------------------------------------------------------------------------
// SysAdmin automation toolkit.
// ---------------------------------------------------------------------------
class SysAdminToolkit {
public:
  // Generate a server baseline report for drift detection.
  struct BaselineReport {
    std::string hostname;
    std::string kernel_version;
    std::string os_version;
    std::map<std::string, std::string> config_hashes; // File -> SHA256
  };

  BaselineReport generate_baseline() {
    BaselineReport report;
    report.hostname = "trading-server-01";
    report.kernel_version = "6.8.0-1010-aws";
    report.os_version = "Ubuntu 24.04 LTS";

    // Hash critical config files.
    for (const auto &path : {
        "/etc/chrony/chrony.conf",
        "/etc/ntp.conf",
        "/etc/security/limits.conf",
        "/etc/ssh/sshd_config",
    }) {
      report.config_hashes[path] = sha256_file(path);
    }

    return report;
  }

  // Verify current state against a previous baseline.
  std::vector<std::string> check_drift(const BaselineReport &baseline) {
    std::vector<std::string> drifts;
    auto current = generate_baseline();

    if (current.kernel_version != baseline.kernel_version) {
      drifts.push_back("Kernel changed: " + baseline.kernel_version +
                       " -> " + current.kernel_version);
    }

    for (const auto &[path, hash] : baseline.config_hashes) {
      auto cur_hash = sha256_file(path);
      if (cur_hash != hash) {
        drifts.push_back("Config drift: " + path);
      }
    }

    return drifts;
  }

private:
  static std::string sha256_file(const std::string &path) {
    // Placeholder — use EVP_Digest in production.
    return "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
  }
};

// ---------------------------------------------------------------------------
// Noise-isolated monitoring agent: pin to isolated cores, use perf_event_open.
// ---------------------------------------------------------------------------
class NoiseIsolatedMonitor {
  // These CPUs are in /sys/devices/system/cpu/isolated — our agent threads
  // are pinned here to avoid interfering with trading threads.
  std::vector<int> isolated_cpus_ = {1, 3, 5, 7}; // Example.

public:
  void pin_current_thread() {
    if (isolated_cpus_.empty()) return;
    cpu_set_t cpuset;
    CPU_ZERO(&cpuset);
    CPU_SET(isolated_cpus_.front(), &cpuset);
    pthread_setaffinity_np(pthread_self(), sizeof(cpu_set_t), &cpuset);
  }

  // Collect hardware counters via perf_event_open (no interrupt storm).
  struct HwCounters {
    uint64_t cycles;
    uint64_t instructions;
    uint64_t cache_misses;
    uint64_t branch_misses;
  };

  HwCounters read_counters() const {
    // In production: ioctl(fd, PERF_EVENT_IOC_ENABLE) + read() from perf FD.
    return {};
  }
};
```
