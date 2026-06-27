---
type: reference
title: "Feed Handler"
description: "Incremental vs snapshot feeds: incremental = sequence of changes. Sequence number tracking: every message has a monotonically"
tags: ["exchange-protocols"]
difficulty: advanced
timestamp: "2026-06-27T03:06:09.434Z"
phase: 9
phaseName: "Order Book & Microstructure"
category: "Phase 9 - Order Book & Microstructure"
subcategory: "order-book"
language: "cpp"
artifact-id: "ZHFT_FEED_HANDLER"
---
## Key Learning Points

- Incremental vs snapshot feeds: incremental = sequence of changes
- Sequence number tracking: every message has a monotonically
- Gap detection: if received_seq > expected_seq + 1, gap exists.
- Retransmission request: send request to exchange for specific seq
- Feed A/B failover: two independent feeds (A primary, B backup).
- Wire-up reconnection sequencing: on disconnect, close socket immediately (don't wait for timeout), reopen connection, logon with next expected seqno; exchange may reject if seqno is too old (CME: within 1000 messages); if rejected, request a gap-fill for missed range; if gap-fill empty, request full snapshot
- Gap-fill vs snapshot recovery: gap-fill is a burst of missed messages (replayed by exchange), processed as normal increments; snapshot is a full book image at a point in time; choose gap-fill if missed range < 1000 messages (fast recovery, no book rebuild); choose snapshot if missed range is large (avoids processing thousands of increments)
- Seqno gap detection with out-of-order delivery: multicast can deliver messages out of order (network reordering, duplicate suppression); maintain a sliding window of received seqnos; if seqno > expected, buffer it and set a timer (100µs); if seqno < expected, check for duplicate (ignore) or historic replay (process)
- Stale feed detection: if no messages received for 10ms on feed A, fail over to feed B; if feed A resumes within 50ms, switch back (or stay on B for the remainder of the session depending on exchange rules); CME recommends staying on backup for the rest of the trading day

## Usage

// FeedHandler fh("ES", FeedType::MDP);
// fh.onIncremental(seq, msg);
// fh.onSnapshot(snap);
// fh.onTimeout(); // detect freeze

## Staff+ Perspective

> **Staff+ Perspective**: Feed handler reliability is the most underestimated component at most firms. At Tower Research, we counted ~20 missed market data events per day during normal conditions due to NIC buffer overflows (despite kernel bypass). The root cause: the DPDK RX ring size was too small (default 128 entries) for the burstiness of CME's MDP feed — a BBO update for ES, NQ, YM, and CL can arrive within the same microsecond. We increased `nb_rx_desc` to 2048 per queue and never saw drops again. For failover, the golden rule: A/B feeds must use physically separate NIC ports and separate OS-level receive queues. We found a bug where feed A's RX ring exhausted, which caused the kernel to drop B's packets too (shared ring). Never share.

## Source Code

```cpp
#include <algorithm>
#include <array>
#include <bit>
#include <chrono>
#include <cstdint>
#include <cstring>
#include <functional>
#include <map>
#include <string_view>
#include <unordered_map>
#include <vector>

// ---------------------------------------------------------------------------
// Feed types
// ---------------------------------------------------------------------------
enum class FeedType : uint8_t {
  MDP = 0,       // CME MDP 3.0
  EBS = 1,       // Eurex EBS
  ICE_MD = 2,    // ICE Market Data
  MILLENNIUM = 3,// LSE Millennium MD
};

enum class FeedMessageType : uint8_t {
  Incremental,
  Snapshot,
  GapFill,
  Heartbeat,
};

// ---------------------------------------------------------------------------
// Feed handler
// ---------------------------------------------------------------------------
class FeedHandler {
public:
  using BookUpdateFn = std::function<void(uint64_t seq, std::string_view msg)>;

  FeedHandler(std::string_view instrument, FeedType type,
              BookUpdateFn on_update)
      : instrument_(instrument), type_(type),
        on_update_(std::move(on_update)) {}

  // Process incoming incremental message
  void onIncremental(uint64_t seq, std::string_view data) {
    // Sequence gap detection
    if (seq != expected_seq_) {
      if (seq > expected_seq_) {
        // Gap detected
        gaps_.push_back({expected_seq_, seq - 1});
        handleGap(expected_seq_, seq - 1);
      } else {
        // Duplicate or late message — check PossDupFlag or ignore
        // TRADEOFF: allow up to 100ms window for out-of-order messages
        // before treating as gap
        auto now = std::chrono::steady_clock::now();
        if (now - last_gap_request_ > std::chrono::milliseconds(100)) {
          return; // stale duplicate
        }
      }
      return;
    }

    expected_seq_ = seq + 1;
    last_received_seq_ = seq;
    last_update_time_ = std::chrono::steady_clock::now();
    on_update_(seq, data);
  }

  // Process snapshot (full book rebuild)
  void onSnapshot(uint64_t seq, std::string_view data) {
    snapshot_seq_ = seq;
    expected_seq_ = seq + 1;
    gaps_.clear();
    // Rebuild the order book from snapshot
    // Then apply any stored gap messages
    applyStoredGapMessages();
  }

  // Feed A/B failover
  void setBackupFeed(FeedHandler *backup) {
    backup_ = backup;
  }

  bool checkFeedHealth() const {
    // Check if feed is healthy: recent update within 50ms
    auto now = std::chrono::steady_clock::now();
    auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
        now - last_update_time_).count();
    return elapsed < 50;
  }

  void failoverToBackup() {
    if (backup_) {
      // Switch primary to backup
      primary_active_ = false;
      backup_->primary_active_ = true;
      // Resync from backup's current state
      backup_->requestSnapshot();
    }
  }

  // Request retransmission for gap
  void requestRetransmit(uint64_t from, uint64_t to) {
    // Send RetransmitRequest to exchange
    last_gap_request_ = std::chrono::steady_clock::now();
    gap_attempts_++;
    // TRADEOFF: after 3 failed attempts, request full snapshot
    if (gap_attempts_ > 3) {
      requestSnapshot();
      gap_attempts_ = 0;
    }
  }

  void requestSnapshot() {
    // Request full book snapshot from exchange
    snapshot_requested_ = true;
  }

private:
  std::string instrument_;
  FeedType type_;
  BookUpdateFn on_update_;

  // Sequence tracking
  uint64_t expected_seq_ = 1;
  uint64_t last_received_seq_ = 0;
  uint64_t snapshot_seq_ = 0;

  // Gap tracking
  struct GapRange { uint64_t from; uint64_t to; };
  std::vector<GapRange> gaps_;
  std::map<uint64_t, std::string> gap_buffer_; // Stored gap messages
  int gap_attempts_ = 0;
  std::chrono::steady_clock::time_point last_gap_request_;

  // Feed health
  std::chrono::steady_clock::time_point last_update_time_;
  bool primary_active_ = true;

  // Backup
  FeedHandler *backup_ = nullptr;
  bool snapshot_requested_ = false;

  void handleGap(uint64_t from, uint64_t to) {
    // Check if backup has messages
    if (backup_ && primary_active_) {
      // Try backup first — may have the missing messages
      backup_->requestRetransmit(from, to);
    } else {
      requestRetransmit(from, to);
    }
  }

  void applyStoredGapMessages() {
    for (auto &[seq, msg] : gap_buffer_) {
      on_update_(seq, msg);
    }
    gap_buffer_.clear();
  }
};
```
