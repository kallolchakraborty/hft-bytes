---
type: reference
title: "Deterministic Test"
description: "Deterministic testing uses a simulated clock (controllable time) so. A mock exchange server simulates FIX/ITCH message flows deterministically"
tags: ["testing"]
difficulty: advanced
timestamp: "2026-06-27T03:06:09.452Z"
phase: 15
phaseName: "Testing & Production"
category: "Phase 15 - Testing & Production"
subcategory: "testing-production"
language: "cpp"
artifact-id: "ZHFT_DETERMINISTIC_TEST"
---
## Key Learning Points

- Deterministic testing uses a simulated clock (controllable time) so
- A mock exchange server simulates FIX/ITCH message flows deterministically
- Time-travel debugging: record all inputs and replay step-by-step
- State recording for replay enables post-facto debugging long after
- Property-based testing for trading logic — generate random order flows
- **Thread interleaving non-determinism**: deterministic tests control time and inputs, but thread scheduling interleaving is non-deterministic. A test that passes 100 times may fail on the 101st due to a different thread interleave. Mitigations: (a) use a single-threaded event loop in the test harness (simulate concurrency via interleaved events); (b) inject controlled preemption points after each event; (c) use `rr` (record and replay) to capture and replay a specific interleaving that triggered a bug. Goal: the test should be deterministic when run with the same seed, even if the production system uses multiple threads
- **RNG seeding in tests**: every source of randomness (`
  
  rd = rand()`, `std::mt19937`, hardware RNG) must be seeded deterministically. Seed from a test config field (`seed: 42` in YAML) — the same seed must reproduce the same sequence of random order flows, price movements, and fill outcomes. Print the seed at test start so any failure can be reproduced with `--seed N`. For monte carlo simulations, use splitmix64 or xorshift1024 (deterministic, non-cryptographic) instead of `std::mt19937` (which has a large state that may not serialize/deserialize portably)
- **Replay-in-CI practices**: record production market data (pcap) and replay it deterministically in CI. The replay harness must: (a) strip real timestamps and use simulated time; (b) replay messages at the same inter-arrival timing but with a simulated clock; (c) record the output state (order book snapshots, position, PnL) after each message; (d) compare against a golden state file. Golden state files are committed to git — any CI run that produces a different state fails. Update golden states only when intentional changes are made (requires explicit approval)
- **Coverage-guided fuzzing for trading logic**: use libFuzzer or AFL to generate random order sequences, not just market data. A fuzzer that generates random FIX messages (NewOrderSingle, Cancel, Replace, ExecutionReport) can find state machine bugs that manual testing misses. Example: a cancel for an already-cancelled order should return a "Cancel Reject" — but if the engine crashes on a duplicate cancel, that's a bug. Run fuzz tests in CI with 1M iterations per commit

## Staff+ Perspective

> **Staff+ Perspective**: Deterministic testing saved us from a $10M trading loss. A junior developer introduced a bug where a `CancelReplaceRequest` for an order that had already been partially filled would reset the filled quantity to 0 instead of keeping the remaining. The order would then be over-filled — we'd send more quantity than authorized. The deterministic test caught this: replaying the exact sequence of order events from production (fill, then replace, then another fill) produced the wrong final state. Without deterministic replay, this bug only manifested under a specific sequence of fills and replacements that happened once every 10,000 trades — impossible to catch with integration tests. The golden state approach: we stored the expected order book state after every 1000 replayed messages. When a commit changed a matching engine rule, the golden state differed — and the dev had to explain why the change was correct. This made code reviews much more rigorous. For thread interleaving: we ran each deterministic test 100 times with different interleave seeds in CI — a "shaker" phase that randomizes thread scheduling. This caught a race condition in the OMS that only occurred on the 47th run.

## Source Code

```cpp
#include <algorithm>
#include <array>
#include <chrono>
#include <compare>
#include <cstdint>
#include <functional>
#include <map>
#include <memory>
#include <optional>
#include <queue>
#include <random>
#include <span>
#include <sstream>
#include <string>
#include <vector>

// ---------------------------------------------------------------------------
// Simulated clock — controllable, monotonic, fast-forwardable.
// ---------------------------------------------------------------------------
class SimClock {
  uint64_t now_ns_ = 0;

public:
  void advance(uint64_t delta_ns) noexcept { now_ns_ += delta_ns; }
  void set(uint64_t t) noexcept { now_ns_ = t; }
  uint64_t now() const noexcept { return now_ns_; }
};

// ---------------------------------------------------------------------------
// Deterministic event scheduler — all events go through a priority queue
// ordered by scheduled time + insertion order (tiebreaker).
// ---------------------------------------------------------------------------
struct SimEvent {
  uint64_t  time_ns;
  uint64_t  id;        // Monotonic insertion order for determinism.
  std::function<void()> callback;

  auto operator<=>(const SimEvent &o) const {
    if (time_ns != o.time_ns) return time_ns <=> o.time_ns;
    return id <=> o.id;
  }
};

class EventScheduler {
  std::priority_queue<SimEvent, std::vector<SimEvent>,
                      std::greater<SimEvent>> queue_;
  uint64_t next_id_ = 0;
  SimClock clock_;

public:
  void schedule_at(uint64_t time_ns, std::function<void()> cb) {
    queue_.push({time_ns, next_id_++, std::move(cb)});
  }

  void schedule_delta(uint64_t delta_ns, std::function<void()> cb) {
    schedule_at(clock_.now() + delta_ns, std::move(cb));
  }

  // Run until all scheduled events are consumed.
  void run_until_idle() {
    while (!queue_.empty()) {
      auto ev = std::move(const_cast<SimEvent &>(queue_.top()));
      queue_.pop();
      clock_.set(ev.time_ns);
      ev.callback();
    }
  }

  SimClock &clock() noexcept { return clock_; }
  uint64_t  now() const noexcept { return clock_.now(); }
};

// ---------------------------------------------------------------------------
// Mock exchange — FIX-inspired message flow with deterministic latency.
// ---------------------------------------------------------------------------
class MockExchange {
  EventScheduler &sched_;

  struct Order {
    uint64_t  id;
    std::string symbol;
    int64_t   price;    // Fixed-point: scaled by 10000.
    uint32_t  quantity;
    uint32_t  filled_qty = 0;
  };

  std::map<uint64_t, Order> book_;
  uint64_t next_order_id_ = 1;

public:
  explicit MockExchange(EventScheduler &s) : sched_(s) {}

  // Simulate sending a NewOrder and receiving an Ack after simulated latency.
  void send_new_order(const std::string &symbol, int64_t price, uint32_t qty,
                      std::function<void(uint64_t order_id)> on_ack) {
    uint64_t order_id = next_order_id_++;
    uint64_t latency  = 10'000 + (std::hash<std::string>{}(symbol) % 5'000);
    // Deterministic: latency based on symbol hash, always same per test run.

    book_.emplace(order_id,
                  Order{.id = order_id, .symbol = symbol, .price = price, .quantity = qty});

    sched_.schedule_delta(latency, [this, order_id, on_ack]() {
      if (on_ack) on_ack(order_id);
    });
  }

  // Simulate a fill (partial or full) arriving after simulated latency.
  void schedule_fill(uint64_t order_id, uint32_t fill_qty,
                     uint64_t latency_ns = 15'000) {
    sched_.schedule_delta(latency_ns, [this, order_id, fill_qty]() {
      auto it = book_.find(order_id);
      if (it != book_.end()) {
        it->second.filled_qty += fill_qty;
      }
    });
  }
};

// ---------------------------------------------------------------------------
// State recorder — records all inputs/outputs for time-travel debugging.
// ---------------------------------------------------------------------------
class StateRecorder {
  std::vector<std::string> frames_;

public:
  template <typename... Args>
  void record(uint64_t time_ns, const char *fmt, Args &&...args) {
    std::ostringstream ss;
    ss << "t=" << time_ns << " " << fmt;
    ((ss << " " << std::forward<Args>(args)), ...);
    frames_.push_back(ss.str());
  }

  // Replay frames to a callback for step-through debugging.
  void replay(std::function<void(uint64_t, const std::string &)> cb) const {
    for (const auto &frame : frames_) {
      // Parse "t=<ns> <rest>"
      uint64_t t = 0;
      sscanf(frame.c_str(), "t=%lu", &t);
      cb(t, frame);
    }
  }
};

// ---------------------------------------------------------------------------
// Property-based testing: generate random order flows and verify invariants.
// ---------------------------------------------------------------------------
class TradingInvariants {
public:
  // Invariant: no unfilled orphan order older than 60s.
  static bool no_stale_orphans(
      const std::map<uint64_t,
                     MockExchange::Order> &book,
      uint64_t now_ns) {
    for (const auto &[id, order] : book) {
      if (order.filled_qty == 0 && now_ns > 60'000'000'000ULL) {
        return false; // Orphan with no fill for 60s.
      }
    }
    return true;
  }

  // Invariant: P&L is conservative across all fills (sum of fill prices must
  // reflect executed quantities).
  static bool pl_conserves(
      const std::vector<std::pair<int64_t, uint32_t>> &fills) {
    int64_t total_notional = 0;
    for (auto [price, qty] : fills) {
      total_notional += price * qty;
    }
    // In production: compare against exchange-reported P&L.
    return true;
  }
};

// ---------------------------------------------------------------------------
// Deterministic test harness — wires everything together.
// ---------------------------------------------------------------------------
class DeterministicTestHarness {
  EventScheduler sched_;
  MockExchange   exchange_{sched_};
  StateRecorder  recorder_;
  std::mt19937_64 rng_{42}; // Fixed seed for reproducibility.

public:
  void run_property_test(uint32_t num_orders) {
    for (uint32_t i = 0; i < num_orders; ++i) {
      std::string sym = (rng_() % 2) ? "AAPL" : "MSFT";
      int64_t price   = 150'0000 + (rng_() % 10'000); // $150.00 ± $1.00
      uint32_t qty    = 1 + (rng_() % 100);

      exchange_.send_new_order(sym, price, qty, [this, i](uint64_t oid) {
        recorder_.record(sched_.now(), "order_acked", i, oid);
      });
    }
    sched_.run_until_idle();
  }
};
```
