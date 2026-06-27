---
type: reference
title: "Grafana"
description: "Prometheus metrics exposition must be lock-free to avoid interfering. Latency SLIs (p99 entry→ack, p99 tick→book update) are the primary"
tags: ["monitoring"]
difficulty: intermediate
timestamp: "2026-06-27T03:06:09.447Z"
phase: 14
phaseName: "Monitoring & Security"
category: "Phase 14 - Monitoring & Security"
subcategory: "monitoring"
language: "cpp"
artifact-id: "ZHFT_GRAFANA"
---
## Key Learning Points

- Prometheus metrics exposition must be lock-free to avoid interfering
- Latency SLIs (p99 entry→ack, p99 tick→book update) are the primary
- Order rate / fill rate dashboards reveal market-making inventory drift
- Market data health dashboard tracks gap rate, late rate, cross-feed
- Alerting rules should use multi-window, multi-burn-rate approach to
- PromQL anomaly detection: z-score over a rolling window flags outliers

## Source Code

```cpp
#include <array>
#include <atomic>
#include <bit>
#include <chrono>
#include <cstdint>
#include <cstring>
#include <span>
#include <string_view>
#include <type_traits>

// ---------------------------------------------------------------------------
// Prometheus metric collector — lock-free, zero-allocation on record path.
// ---------------------------------------------------------------------------
// Each metric is a counter or histogram backed by atomics. The /metrics
// endpoint scans them on demand (called by Prometheus every ~15s).
// ---------------------------------------------------------------------------

// Tagged metric family — e.g., "latency_histogram{percentile="p99"}"
struct MetricFamily {
  const char *name;     // e.g., "order_ops_total"
  const char *help;     // e.g., "Total number of order operations by type"
  const char *type;     // "counter", "gauge", "histogram"
};

// Pre-defined metric families for a typical HFT system.
enum class MetricId : uint16_t {
  // Latency SLIs
  LastEntryToAckUs,      // Gauge: latest entry→ack latency in µs
  P99EntryToAckUs,       // Gauge: rolling p99 entry→ack latency in µs
  LastTickToBookUs,      // Gauge: latest tick→book update latency in µs

  // Order rates
  NewOrdersTotal,        // Counter: total new orders sent
  FillsTotal,            // Counter: total fills received
  CancelsTotal,          // Counter: total cancels sent
  RejectsTotal,          // Counter: total rejects received
  OrderRatePerSec,       // Gauge: instantaneous order rate

  // Market data health
  SeqGapsTotal,          // Counter: total sequence gaps detected
  LateTicksTotal,        // Counter: total late ticks detected
  DuplicateTicksTotal,   // Counter: total duplicate ticks detected
  CrossFeedMismatches,   // Counter: feed A != feed B count

  // System health
  UptimeSeconds,         // Counter: process uptime
  ConnectionsActive,     // Gauge: active exchange connections
  LastHeartbeatAgeUs,    // Gauge: age of last heartbeat from exchange

  // Error budget
  ErrorBudgetRemaining,  // Gauge: fraction [0,1] of error budget remaining
  BurnRate,              // Gauge: current error budget burn rate

  kCount
};

class PrometheusCollector {
  // Counter storage: 64-bit aligned, padded to avoid false sharing.
  struct alignas(64) Counter {
    std::atomic<int64_t> value{0};
  };
  struct alignas(64) Gauge {
    std::atomic<double> value{0.0};
  };

  std::array<Counter, static_cast<size_t>(MetricId::kCount)> counters_;
  std::array<Gauge, static_cast<size_t>(MetricId::kCount)>   gauges_;

public:
  // Record path — called from hot threads.
  void increment(MetricId id, int64_t delta = 1) noexcept {
    counters_[static_cast<size_t>(id)].value.fetch_add(delta,
                                                       std::memory_order_relaxed);
  }

  void set_gauge(MetricId id, double val) noexcept {
    gauges_[static_cast<size_t>(id)].value.store(val, std::memory_order_relaxed);
  }

  // Scrape path — called by the HTTP handler. Serializes Prometheus text format.
  // Must complete within 1ms on a busy system.
  std::string scrape() const {
    // In production, write directly to a pre-allocated buffer (iovec for writev).
    // Here we illustrate the format.
    std::string out;
    out.reserve(4096);

    auto append = [&](MetricId id, const char *name, const char *help,
                      const char *type, auto value) {
      out += "# HELP "; out += name; out += " "; out += help; out += "\n";
      out += "# TYPE "; out += name; out += " "; out += type; out += "\n";
      out += name; out += " "; out += std::to_string(value); out += "\n";
    };

    append(MetricId::NewOrdersTotal, "hft_new_orders_total",
           "Total new orders sent", "counter",
           counters_[0].value.load());
    append(MetricId::P99EntryToAckUs, "hft_p99_entry_to_ack_us",
           "Rolling p99 entry to ack latency", "gauge",
           gauges_[1].value.load());
    // ... remaining metrics omitted for brevity.

    return out;
  }
};

// ---------------------------------------------------------------------------
// Grafana dashboard JSON definitions (exported as constexpr strings).
// ---------------------------------------------------------------------------
// In a real system these JSON blobs are registered via the Grafana API or
// provisioned as JSON files. The C++ code just exposes them as compile-time
// strings for the deployment tool.
// ---------------------------------------------------------------------------
namespace Dashboards {

// Latency SLI dashboard — panels for p50/p90/p99/p99.9 entry→ack and tick→book.
constexpr const char kLatencyDashboard[] = R"JSON({
  "title": "HFT Latency SLIs",
  "panels": [
    {
      "title": "Entry → Ack Latency (µs)",
      "type": "timeseries",
      "targets": [
        {"expr": "hft_p99_entry_to_ack_us", "legendFormat": "p99"},
        {"expr": "hft_p50_entry_to_ack_us", "legendFormat": "p50"}
      ],
      "yaxis": {"unit": "µs", "scale": "log2"}
    },
    {
      "title": "Order Rate vs Fill Rate",
      "type": "timeseries",
      "targets": [
        {"expr": "rate(hft_new_orders_total[1m])", "legendFormat": "new"},
        {"expr": "rate(hft_fills_total[1m])", "legendFormat": "fills"}
      ]
    }
  ]
})JSON";

// Market data health dashboard.
constexpr const char kMarketDataDashboard[] = R"JSON({
  "title": "Market Data Health",
  "panels": [
    {
      "title": "Sequence Gaps (per symbol)",
      "type": "stat",
      "targets": [
        {"expr": "hft_seq_gaps_total", "legendFormat": "gaps"}
      ]
    },
    {
      "title": "Cross-Feed Mismatches",
      "type": "timeseries",
      "targets": [
        {"expr": "rate(hft_cross_feed_mismatches[5m])", "legendFormat": "mismatches"}
      ]
    }
  ]
})JSON";

} // namespace Dashboards

// ---------------------------------------------------------------------------
// Prometheus alerting rules — multi-window, multi-burn-rate.
// ---------------------------------------------------------------------------
/*
groups:
  - name: hft_latency
    rules:
      # Burn rate > 14.4x over 1m means SLO violation in ~1 hour.
      - alert: LatencyBurnRateCritical
        expr: |
          (
            rate(hft_errors_total[1m])
            /
            rate(hft_requests_total[1m])
          ) / (1 - 0.999) > 14.4
        for: 1m
        labels: { severity: critical }
*/
```
