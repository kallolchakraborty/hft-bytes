---
type: playbook
title: "Seq Resets"
description: "Some exchanges may reset sequence numbers mid-session — after a. False gap detection: a sequence going from, say, 1,000,000 to 1 does"
tags: ["phase-17"]
timestamp: "2026-06-27T03:06:09.461Z"
phase: 17
phaseName: "Production Failure Modes"
category: "Phase 17 - Production Failure Modes"
subcategory: "failure-modes"
language: "cpp"
artifact-id: "ZHFT_SEQ_RESETS"
---
## Key Learning Points

- Some exchanges may reset sequence numbers mid-session — after a
- False gap detection: a sequence going from, say, 1,000,000 to 1 does
- Logon sequence handling: during session login, exchange may indicate
- Sequence number validation before gap detection: check for known reset

## Source Code

```cpp
#include <algorithm>
#include <array>
#include <atomic>
#include <cstdint>
#include <map>
#include <optional>
#include <set>
#include <sstream>
#include <string>
#include <vector>

// ---------------------------------------------------------------------------
// Exchange sequence monitor — detects resets vs true gaps.
// ---------------------------------------------------------------------------
class ExchangeSequenceMonitor {
  // The highest sequence number we have ever seen for this session.
  uint64_t highest_seq_ = 0;
  // The last sequence number we received.
  uint64_t last_seq_    = 0;
  // If the exchange indicated "reset" at logon.
  bool session_reset_   = false;

  // Gap tracking.
  uint64_t total_gaps_    = 0;
  uint64_t false_gaps_    = 0; // Gaps that turned out to be resets.

  // Known exchange-specific reset sequences.
  struct ExchangeResetPattern {
    uint64_t reset_threshold;  // If new seq < last_seq * X, it's a reset.
    uint64_t min_seq_before_reset; // Minimum seq before a "reset to 1".
  };

  // Different exchanges have different reset patterns.
  std::map<std::string, ExchangeResetPattern> patterns_ = {
      {"NASDAQ",  {.reset_threshold = 100, .min_seq_before_reset = 1000}},
      {"NYSE",    {.reset_threshold = 50,  .min_seq_before_reset = 500}},
      {"CME",     {.reset_threshold = 0,   .min_seq_before_reset = 0}}, // CME never resets
      {"EUREX",   {.reset_threshold = 200, .min_seq_before_reset = 2000}},
  };

  std::string venue_;

public:
  explicit ExchangeSequenceMonitor(const std::string &venue) : venue_(venue) {}

  enum class SeqResult {
    Ok,
    Gap,
    FalseGap,          // False positive — gap detected but it was a reset.
    SequenceReset,     // Exchange reset sequences.
    Duplicate,
    Late,
  };

  SeqResult check(uint64_t seq, uint64_t timestamp_ns) {
    if (seq <= last_seq_) {
      return SeqResult::Duplicate;
    }

    bool is_reset = false;
    auto it = patterns_.find(venue_);
    if (it != patterns_.end()) {
      auto &p = it->second;
      // Reset pattern: new seq is much lower than expected continuation,
      // AND we have seen enough messages to justify a reset.
      if (seq < last_seq_ &&
          (last_seq_ - seq) > p.reset_threshold &&
          last_seq_ >= p.min_seq_before_reset) {
        is_reset = true;
      } else if (last_seq_ > 0 && seq > last_seq_ + 1) {
        // Real gap.
        total_gaps_ += (seq - last_seq_ - 1);
        last_seq_ = seq;
        return SeqResult::Gap;
      }
    }

    if (is_reset) {
      // It was not a gap — it was a reset.
      false_gaps_++;
      highest_seq_ = std::max(highest_seq_, last_seq_);
      last_seq_    = seq;
      return SeqResult::SequenceReset;
    }

    // Normal case: seq == last_seq + 1.
    highest_seq_ = std::max(highest_seq_, seq);
    last_seq_    = seq;
    return SeqResult::Ok;
  }

  // After detecting a reset, we may need to re-request state from the exchange.
  void handle_reset() {
    // In production: request a snapshot from the exchange (full order book refresh).
    // For ITCH: send a "Retransmission Request" for the last N sequences.
  }

  uint64_t false_gap_count() const { return false_gaps_; }
  uint64_t gap_count() const { return total_gaps_; }
};

// ---------------------------------------------------------------------------
// False-positive gap filter — suppresses alerts when pattern matches a reset.
// ---------------------------------------------------------------------------
class FalsePositiveGapFilter {
  // Maintains a window of recent sequences to detect reset patterns.
  std::array<uint64_t, 8> recent_seqs_;
  size_t pos_ = 0;

public:
  bool is_probably_reset(uint64_t new_seq, uint64_t last_seq) {
    // If the gap is > 1000 and all recent sequences were contiguous, it's a
    // real gap, not a reset.
    uint64_t gap = new_seq - last_seq;
    if (gap > 1000) return false; // Too large for a reset.

    // Check if we've seen a monotonic increase recently.
    bool contiguous = true;
    for (size_t i = 1; i < recent_seqs_.size(); ++i) {
      if (recent_seqs_[i] > 0 &&
          recent_seqs_[i] != recent_seqs_[i - 1] + 1) {
        contiguous = false;
        break;
      }
    }

    // If recent seqs were contiguous but we just got a drop, it's a reset.
    return contiguous;
  }

  void record(uint64_t seq) {
    recent_seqs_[pos_++ & 7] = seq;
  }
};

// ---------------------------------------------------------------------------
// Logon sequence handler — decides reset vs recovery at session start.
// ---------------------------------------------------------------------------
enum class LogonMode {
  Reset,     // Start from seq 1.
  Recovery,  // Continue from where we left off.
};

class LogonSequenceHandler {
  uint64_t persisted_last_seq_ = 0;

public:
  struct LogonDecision {
    LogonMode mode;
    uint64_t  expected_seq;
    uint64_t  persisted_seq;
  };

  LogonDecision decide(bool exchange_indicates_reset,
                        uint64_t exchange_expected_seq) {
    // Persisted last sequence (from prior session).
    if (exchange_indicates_reset) {
      return {LogonMode::Reset, 1, persisted_last_seq_};
    }

    // Recovery mode: use exchange's expected sequence or our persisted seq + 1.
    uint64_t expected = std::max(exchange_expected_seq, persisted_last_seq_ + 1);
    return {LogonMode::Recovery, expected, persisted_last_seq_};
  }
};
```
