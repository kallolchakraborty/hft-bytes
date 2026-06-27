---
type: reference
title: "Gap Recovery"
description: "Sequence gap detection algorithm: maintain expected_seq counter. Retransmission request timing: request immediately for single"
tags: ["recovery"]
timestamp: "2026-06-27T03:06:09.435Z"
phase: 9
phaseName: "Order Book & Microstructure"
category: "Phase 9 - Order Book & Microstructure"
subcategory: "order-book"
language: "cpp"
artifact-id: "ZHFT_GAP_RECOVERY"
---
## Key Learning Points

- Sequence gap detection algorithm: maintain expected_seq counter
- Retransmission request timing: request immediately for single
- Snapshot vs incremental recovery: for small gaps (< 100 msgs),
- Gap fill validation: after receiving gap-fill messages, verify
- Duplicate detection: use sequence number deduplication set.

## Usage

// GapDetectionEngine gde;
// gde.setExpectedSeq(100);
// if (gde.checkGap(105)) {
//     gde.requestRetransmit(100, 104);
// }
// gde.onGapFill(100, "msg100", false);

## Source Code

```cpp
#include <algorithm>
#include <array>
#include <bit>
#include <chrono>
#include <cstdint>
#include <cstring>
#include <map>
#include <set>
#include <string_view>
#include <unordered_set>
#include <vector>

// ---------------------------------------------------------------------------
// Gap detection engine
// ---------------------------------------------------------------------------
class GapDetectionEngine {
public:
  void setExpectedSeq(uint64_t seq) { expected_seq_ = seq; }
  uint64_t expectedSeq() const { return expected_seq_; }

  // Check if received seq creates a gap. Returns gap size (0 = no gap).
  uint64_t checkGap(uint64_t received_seq) {
    if (received_seq == expected_seq_) {
      expected_seq_++;
      return 0; // normal
    }

    if (received_seq > expected_seq_) {
      // Gap detected
      uint64_t gap_size = received_seq - expected_seq_;
      gaps_.emplace_back(expected_seq_, received_seq - 1);
      expected_seq_ = received_seq + 1;
      return gap_size;
    }

    // received_seq < expected_seq_ — duplicate
    duplicates_++;
    return 0;
  }

  // Request retransmission for a gap range
  void requestRetransmit(uint64_t from, uint64_t to) {
    if (from > to) return;

    // TRADEOFF: rate limiting — max 5 retransmit requests per second
    auto now = std::chrono::steady_clock::now();
    auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
        now - last_request_time_).count();
    if (elapsed < 200) {
      // Too soon — add to pending
      pending_requests_.emplace_back(from, to);
      return;
    }
    last_request_time_ = now;

    // Send retransmission request for this range
    actualRequest(from, to);
  }

  // Prioritize recovery strategy based on gap size
  enum class RecoveryStrategy : uint8_t {
    Incremental,  // Small gap — request retransmit
    Snapshot,     // Large gap — request full snapshot
  };

  RecoveryStrategy prioritize(const GapRange &gap) const {
    uint64_t size = gap.to - gap.from + 1;
    // CRITICAL: threshold of 100 msgs balances recovery speed vs bandwidth.
    // Under 100 msgs, incremental retransmit is faster (single round trip).
    // Over 100 msgs, snapshot + catch-up avoids many round trips.
    if (size <= 100) return RecoveryStrategy::Incremental;
    return RecoveryStrategy::Snapshot;
  }

  // Process a gap-fill message
  void onGapFill(uint64_t seq, bool poss_dup) {
    // Check duplicate
    if (processed_.count(seq)) return;
    processed_.insert(seq);

    if (!poss_dup) {
      // Fresh message — process as book update
      received_.insert(seq);
    }

    // Check if this fills a gap
    for (auto it = gaps_.begin(); it != gaps_.end(); ) {
      if (seq >= it->from && seq <= it->to) {
        filled_in_gap_[seq] = true;
        // Check if whole gap is filled
        bool full = true;
        for (uint64_t s = it->from; s <= it->to; s++) {
          if (!filled_in_gap_.count(s)) { full = false; break; }
        }
        if (full) {
          gaps_.erase(it);
          return;
        }
        break;
      }
      ++it;
    }
  }

  // Remaining gaps after recovery attempt
  std::vector<GapRange> remainingGaps() const {
    std::vector<GapRange> rem;
    for (auto &g : gaps_) {
      for (uint64_t s = g.from; s <= g.to; s++) {
        if (!filled_in_gap_.count(s)) {
          rem.push_back({s, s}); // individual missing seqs
        }
      }
    }
    return rem;
  }

  void reset() {
    gaps_.clear();
    pending_requests_.clear();
    processed_.clear();
    received_.clear();
    filled_in_gap_.clear();
    duplicates_ = 0;
  }

private:
  uint64_t expected_seq_ = 1;
  uint64_t duplicates_ = 0;

  struct GapRange { uint64_t from; uint64_t to; };
  std::vector<GapRange> gaps_;
  std::vector<GapRange> pending_requests_;
  std::unordered_set<uint64_t> processed_;
  std::set<uint64_t> received_;
  std::map<uint64_t, bool> filled_in_gap_;

  std::chrono::steady_clock::time_point last_request_time_;

  void actualRequest(uint64_t from, uint64_t to) {
    // Build and send protocol-specific retransmission request
    // For MDP: RetransmitRequest message
    // For EBS: RetransmitRequest message
    // Rate limit: max 5/sec
  }
};
```
