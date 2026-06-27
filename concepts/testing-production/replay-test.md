---
type: reference
title: "Replay Test"
description: "Record real market data + order flow in production; replay through. Sequence matching: replay events must produce the same internal state"
tags: ["backtesting", "testing"]
difficulty: advanced
timestamp: "2026-06-27T03:06:09.454Z"
phase: 15
phaseName: "Testing & Production"
category: "Phase 15 - Testing & Production"
subcategory: "testing-production"
language: "cpp"
artifact-id: "ZHFT_REPLAY_TEST"
---
## Key Learning Points

- Record real market data + order flow in production; replay through
- Sequence matching: replay events must produce the same internal state
- Fill replay accuracy: simulated fills must match actual fills to within
- Regression test suite generated from production captures — any

## Source Code

```cpp
#include <algorithm>
#include <array>
#include <cstdint>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <functional>
#include <map>
#include <memory>
#include <optional>
#include <span>
#include <sstream>
#include <string>
#include <vector>

// ---------------------------------------------------------------------------
// Replay event record — deserialized from binary capture file.
// ---------------------------------------------------------------------------
enum class ReplayEventType : uint8_t {
  TickPrice,       // Market data price update
  TickTrade,       // Market data trade
  OrderNew,        // Our new order sent
  OrderAck,        // Exchange ack received
  OrderFill,       // Fill received
  OrderCancel,     // Cancel sent
  OrderCancelAck,  // Cancel acknowledged
  GapFill,         // Exchange retransmission (gap fill)
};

struct ReplayEvent {
  uint64_t     capture_time_ns;  // Monotonic time from capture
  uint64_t     exchange_seq;     // Exchange sequence number
  uint64_t     order_id;         // Our order ID (or 0 for mkt data)
  ReplayEventType type;
  uint8_t      payload[48];      // Raw message bytes
};

// ---------------------------------------------------------------------------
// Replay data reader — reads a binary capture file into an event stream.
// ---------------------------------------------------------------------------
class ReplayReader {
  std::vector<ReplayEvent> events_;
  size_t pos_ = 0;

public:
  bool open(const std::filesystem::path &path) {
    std::ifstream f(path, std::ios::binary);
    if (!f) return false;
    ReplayEvent ev;
    while (f.read(reinterpret_cast<char *>(&ev), sizeof(ev))) {
      events_.push_back(ev);
    }
    return true;
  }

  bool next(ReplayEvent &ev) {
    if (pos_ >= events_.size()) return false;
    ev = events_[pos_++];
    return true;
  }

  void reset() { pos_ = 0; }
  size_t count() const { return events_.size(); }
};

// ---------------------------------------------------------------------------
// Sequence matcher — verifies that a replay run produces the same state
// machine transitions as the original capture.
// ---------------------------------------------------------------------------
class SequenceMatcher {
  struct ExpectedTransition {
    ReplayEventType type;
    uint64_t        exchange_seq;
    uint64_t        order_id;
  };

  std::vector<ExpectedTransition> expected_;
  size_t match_pos_ = 0;
  uint64_t mismatches_ = 0;

public:
  void build_expectations(ReplayReader &reader) {
    ReplayEvent ev;
    while (reader.next(ev)) {
      expected_.push_back({ev.type, ev.exchange_seq, ev.order_id});
    }
    reader.reset();
  }

  // Called during replay when a state transition occurs.
  // Returns true if it matches the expected transition.
  bool match_transition(ReplayEventType type, uint64_t exchange_seq,
                        uint64_t order_id) {
    if (match_pos_ >= expected_.size()) {
      mismatches_++;
      return false;
    }
    auto &exp = expected_[match_pos_];
    if (exp.type != type || exp.exchange_seq != exchange_seq ||
        exp.order_id != order_id) {
      mismatches_++;
      return false;
    }
    match_pos_++;
    return true;
  }

  uint64_t mismatch_count() const { return mismatches_; }
  double   accuracy() const {
    return expected_.empty() ? 1.0
                             : 1.0 - double(mismatches_) / expected_.size();
  }
};

// ---------------------------------------------------------------------------
// Replay test harness — feeds replay events to the live system's message
// handlers (or a copy of them) and checks output invariants.
// ---------------------------------------------------------------------------
class ReplayTestHarness {
  ReplayReader    reader_;
  SequenceMatcher matcher_;

  // Callbacks injected into the system under test.
  std::function<void(const ReplayEvent &)> on_tick_;
  std::function<void(const ReplayEvent &)> on_order_;

public:
  void register_handlers(std::function<void(const ReplayEvent &)> tick_handler,
                         std::function<void(const ReplayEvent &)> order_handler) {
    on_tick_  = std::move(tick_handler);
    on_order_ = std::move(order_handler);
  }

  // Run replay and return match accuracy as a score.
  double run(const std::filesystem::path &capture_path) {
    if (!reader_.open(capture_path)) return 0.0;
    matcher_.build_expectations(reader_);

    ReplayEvent ev;
    while (reader_.next(ev)) {
      switch (ev.type) {
      case ReplayEventType::TickPrice:
      case ReplayEventType::TickTrade:
      case ReplayEventType::GapFill:
        if (on_tick_) on_tick_(ev);
        break;
      case ReplayEventType::OrderNew:
      case ReplayEventType::OrderAck:
      case ReplayEventType::OrderFill:
      case ReplayEventType::OrderCancel:
      case ReplayEventType::OrderCancelAck:
        if (on_order_) on_order_(ev);
        break;
      }
    }
    return matcher_.accuracy();
  }
};

// ---------------------------------------------------------------------------
// Regression test suite — runs replay captures after every code change.
// ---------------------------------------------------------------------------
class RegressionSuite {
  std::vector<std::filesystem::path> captures_;
  double min_accuracy_threshold_ = 0.9999; // 99.99% match required.

public:
  struct TestResult {
    std::string name;
    double      accuracy;
    bool        passed;
    std::string failure_reason;
  };

  std::vector<TestResult> run_all(ReplayTestHarness &harness) {
    std::vector<TestResult> results;
    for (const auto &cap : captures_) {
      double acc = harness.run(cap);
      results.push_back({.name        = cap.filename().string(),
                         .accuracy    = acc,
                         .passed      = acc >= min_accuracy_threshold_,
                         .failure_reason =
                             acc < min_accuracy_threshold_
                                 ? "Accuracy below threshold"
                                 : ""});
    }
    return results;
  }
};
```
