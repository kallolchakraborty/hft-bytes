---
type: reference
title: "Multi-Venue Architecture for HFT"
description: "System architecture for connecting to 20+ trading venues simultaneously: consolidated vs per-venue books, symbol normalization, FIX session management at scale, cross-venue order routing, market data fan-out, and failover topology."
tags: ["architecture", "multi-venue", "exchange", "scalability"]
difficulty: staff
timestamp: "2026-06-27T18:00:00.000Z"
phase: 6
phaseName: "System Architecture"
category: "Exchange Architecture"
subcategory: "exchange-architecture"
language: "cpp"
artifact-id: "ZHFT_MULTI_VENUE"
---

## Key Learning Points

- **Consolidated vs per-venue order book**: a consolidated book merges all venues' top-of-book into a single view (best bid/offer across venues). A per-venue book maintains separate order books for each venue. Tradeoff: consolidated is simpler for strategy logic (one book to read) but loses venue-specific depth information. Per-venue is essential for smart-order-routing (SOR) that considers venue-specific queue position and fee structure. Many HFT firms maintain both: a consolidated book for strategy signals and per-venue books for execution logic
- **Symbol normalization at scale**: different venues encode the same instrument differently — `"AAPL"` on Nasdaq vs `"Z"` on IEX vs `"037833100"` CUSIP vs `"US0378331005"` ISIN vs `"B0Y1"` options OCC symbol. A symbol mapping service must resolve all identifiers to a canonical internal ID (e.g., uint32). Every market data message and order event hits this mapping — must be O(1) lock-free lookup. Use bidirectional hash maps (venue symbol ↔ internal ID) with 100K+ entries. Handle symbol lifecycle: listing, delisting, symbol change (e.g., `"GOOG"` → `"GOOGL"`)
- **FIX session management at 20+ venues**: each venue requires 1-3 FIX sessions (market data, order entry, drop copy). For 20 venues, that's 40-60 concurrent FIX sessions. Each session has: heartbeat monitoring, seqnum gap detection, resend request handling, logon/logout state machine, and reconnection backoff. Architecture pattern: one FIX session manager per venue (goroutine/thread) with a shared session state database (Redis or in-memory). Failover: if session X drops, the backup session manager takes over within 50ms. Use a session-level watchdog timer (3× heartbeat interval) with automatic restart
- **Market data fan-out**: one feed connection per venue delivers messages; fan them out to multiple strategy processes on the same server. Use shared memory (SHM) or multicast to avoid serializing through a central process. Architecture: feed handler writes to a shared memory ring buffer (lock-free SPSC); strategy processes read from the ring buffer. This avoids copying market data through TCP/IP between processes. Use `mmap` with MAP_SHARED and seqno-based sync. Each venue's data gets its own ring buffer or partition
- **Cross-venue order routing (SOR)**: a smart order router receives a parent order and slices it across venues based on: (a) available liquidity at each venue; (b) fee structure (taker vs maker); (c) queue position estimation; (d) latency to each venue; (e) fill probability model. The SOR must be non-blocking and decisions must complete within <1µs to avoid latency tier slippage. Implementation: pre-compute routing table (venue priority list per symbol) and update every 100ms (during the "quiet" period between auction and continuous trading). Use a read-copy-update (RCU) pattern for routing table updates
- **Failover topology for multi-venue trading**: each venue should have two independent network paths (A and B). The trading server connects to both and uses BGP anycast or a redundant switch fabric. If path A fails, traffic switches to path B within 1ms (hardware failover). For market data, run dual feed handlers per venue — primary and backup — in separate processes on separate CPU cores. The backup subscribes to the same multicast stream but doesn't process; on primary failure, the backup takes over within one gap-fill (<100ms)
- **Venue connectivity latency budget**: total round-trip from strategy decision to fill acknowledgment = (network RTT to venue) + (exchange matching engine latency) + (network RTT back). For a venue 500km away (5µs/km fiber = 2.5ms RTT), allow 20µs for the local system processing. Total: ~2.52ms. Budget breakdown: symbol lookup 100ns, order book update 200ns, SOR decision 500ns, session serialization 300ns, NIC DMA 500ns, kernel stack 2µs. Design the system to fit within <5µs local processing regardless of venue RTT. Use `perf stat --topdown` to profile each pipeline stage
- **Risk checks across venues**: a cross-venue risk check ensures a strategy doesn't exceed position limits across all venues combined. Checks: (a) gross notional exposure (sum of all positions × price); (b) net position per instrument (buy - sell across all venues); (c) order rate limit (across all venues, max 1000 orders/sec); (d) fat-finger check (any single order > 10% of ADV). The risk check must be in the critical path of order submission (<1µs). Architecture: shared-memory risk counters updated atomically; each venue's order entry thread checks before sending

## Source Code

```cpp
// Multi-venue symbol normalization — lock-free bidirectional map
#include <atomic>
#include <cstdint>
#include <cstring>
#include <optional>
#include <string_view>

class SymbolMap {
  static constexpr size_t kBucketCount = 1 << 20; // 1M entries
  struct Entry {
    std::atomic<uint64_t> venue_sym; // packed: venue_id(16) + symbol_hash(48)
    std::atomic<uint32_t> internal_id;
    std::atomic<uint32_t> next; // index into entries
  };
  Entry entries_[kBucketCount];
  std::atomic<uint32_t> free_list_;

public:
  uint32_t lookup(uint16_t venue_id, const char* symbol, size_t len) noexcept {
    uint64_t key = (uint64_t(venue_id) << 48) | hash(symbol, len);
    size_t bucket = key % kBucketCount;
    uint32_t idx = 0;
    // Chase linked list — expected fast (<2 hops due to low load)
    while (true) {
      uint64_t ek = entries_[idx].venue_sym.load(std::memory_order_acquire);
      if (ek == key) return entries_[idx].internal_id.load(std::memory_order_relaxed);
      if (ek == 0) return UINT32_MAX; // not found
      idx = entries_[idx].next.load(std::memory_order_relaxed);
    }
  }

  static uint64_t hash(const char* s, size_t n) noexcept {
    uint64_t h = 14695981039346656037ULL;
    for (size_t i = 0; i < n; ++i) {
      h ^= static_cast<uint8_t>(s[i]);
      h *= 1099511628211ULL;
    }
    return h;
  }
};

// Per-venue session manager (one per venue)
class VenueSessionManager {
  struct Session {
    int fd;
    uint64_t last_heartbeat_ns;
    uint32_t expected_seqno;
    enum State { DISCONNECTED, LOGON_SENT, LOGGED_IN, GAP_FILLING } state_;
    void reconnect_backoff() {
      static const uint64_t backoffs[] = {1000000, 2000000, 4000000, 8000000, 16000000};
      static int attempt = 0;
      usleep(backoffs[attempt++ % 5]); // 1s, 2s, 4s, 8s, 16s
    }
  };
  Session sessions_[3]; // md, order, drop
public:
  void run() {
    while (true) {
      poll(sessions_, 3, 1000);
      for (auto& s : sessions_) {
        if (s.state_ == Session::LOGGED_IN && 
            (now_ns() - s.last_heartbeat_ns > 30'000'000'000)) {
          s.state_ = Session::DISCONNECTED;
          s.reconnect_backoff();
        }
      }
    }
  }
};
```

## Usage

```bash
# Start multi-venue system with 20 venue connections
./multi_venue --config venues.yaml --sor-config sor.yaml --symbol-map symbols.dat

# venues.yaml:
# venues:
#   - name: nasdaq
#     md: tcp://192.168.1.10:9001
#     order: tcp://192.168.1.10:9002
#     drop: tcp://192.168.1.10:9003
#     symbol_prefix: "NASDAQ:"
#   - name: iex
#     md: tcp://192.168.1.11:9001
#     ...

# SOR routing table dump
kill -USR1 $(pgrep multi_venue)  # writes /tmp/sor_routes.txt
```

## Staff+ Perspective

> **Staff+ Perspective**: The symbol normalization problem is far worse than most engineers expect — we had a case where NYSE listed "BRK.B" and Nasdaq listed "BRK-B" (dot vs hyphen) for the same instrument. Two different internal IDs, two order books, positions tracked separately — the strategy was hedging against itself. Fix: add a symbol equivalence table with manual curation. For FIX sessions: 40+ concurrent sessions means a connection storm on startup is a real risk — if all sessions logon simultaneously, the exchange may rate-limit you. Add jitter (0-5s random delay) to each session's initial logon. The market data fan-out through shared memory was a game-changer: before SHM, we serialized through a TCP publisher, which added 10µs latency per message. With SHM ring buffers, fan-out latency is <500ns per consumer process. For the SOR: the most complex part was queue position estimation. We built a model that predicts how many contracts will be filled for a given limit price based on current queue depth, historical fill rates, and participation — and updated it every 50ms. The pre-computed routing table with RCU updates was fast enough (<800ns per SOR decision), but the real bottleneck was the risk check — atomic counters in shared memory became contended when 20 venues' order threads all wrote to the same counter. We partitioned risk counters by asset class to reduce contention.