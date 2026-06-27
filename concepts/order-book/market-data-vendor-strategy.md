---
type: reference
title: "Market Data Vendor Strategy"
description: "Direct-feed vs SIP comparison, feed redundancy and failover, gap detection and recovery, nanosecond timestamp provenance, vendor selection (Exegy, MayStreet, Redline, SFTI, QuantHouse), and co-located feed topology."
tags: ["market-data"]
timestamp: "2026-06-27T03:20:00.000Z"
phase: 9
phaseName: "Order Book & Microstructure"
category: "Order Book"
subcategory: "order-book"
language: "cpp"
artifact-id: "ZHFT_MKT_DATA_VENDOR_STRATEGY"
---
## Key Learning Points

- Direct feeds (CME MDP 3.0, Nasdaq ITCH, OPRA MultiCast) vs SIP feeds (CTA, UTP, OPRA SIP): direct feeds are 5-50 us faster but require full feed handler; SIPs are consolidated but slower by design
- Feed redundancy: primary (A feed) + backup (B feed) from exchange; primary + backup (diverse path) via colo; vendor feed as tertiary; failover via seqnum gap detection
- Gap detection strategy: monitor incoming seqno monotonicity; gap > 100ms triggers failover; gap > 1s triggers reconnect; always verify feed state before switching
- Nanosecond timestamp provenance: SG (NASDAQ), PTP timestamp (CME), RDTSC at NIC (bonded); know the timestamp source for each feed; hardware PPS reference for NTP-free operation
- Vendor evaluation criteria: feed coverage (Cboe, CME, Eurex, ICE, OPRA, etc.), protocol support (ITCH, MoldUDP64, SoupBinTCP, SBE), colo presence, nanosecond precision, SLA on gap/latency
- Feed handler topology: one handler per feed per exchange; each pinned to a dedicated core; shared-memory ring buffer for consolidated order-book stage
- Recovery: on gap, request retransmission from exchange (MoldUDP64 recovery channel); on vendor fail, replay from local capture archive

## Usage

```cpp
// Feed failover logic
struct FeedManager {
    enum Feed { PRIMARY, BACKUP, VENDOR };
    struct FeedState {
        uint64_t expected_seq_;
        uint64_t last_seq_;
        uint64_t last_ts_ns_;
        bool healthy_;
        int target_seq_gap() const {
            return static_cast<int>(last_seq_ - expected_seq_);
        }
    };

    FeedState primary_, backup_, vendor_;
    Feed active_feed_ = Feed::PRIMARY;

    void onSeqno(const char* source, uint64_t seqno) {
        FeedState* s = feedState(source);
        if (seqno < s->expected_seq_) return; // duplicate
        if (seqno > s->expected_seq_) {
            // Gap detected on this feed
            if (s->target_seq_gap() > MAX_ACCEPTABLE_GAP) {
                failoverToNext(source);
            }
        }
        s->expected_seq_ = seqno + 1;
    }

    void failoverToNext(const char* failed_source) {
        if (active_feed_ == Feed::PRIMARY && backup_.healthy_)
            active_feed_ = Feed::BACKUP;
        else if (vendor_.healthy_)
            active_feed_ = Feed::VENDOR;
        else
            trigger_alarm("ALL FEEDS DOWN");
        // Reset expected seqno from new feed
    }
};
```

## Source Code

```cpp
// Feed latency comparison (simplified vendor matrix)
// Vendor     | CME MDP | Nasdaq ITCH | OPRA | Colo | Nanosecond
// -----------+---------+-------------+------+------+-----------
// Exegy      |   Yes   |    Yes      | Yes  |  Yes |   PTP
// MayStreet  |   Yes   |    Yes      | Yes  |  Yes |   PTP
// Redline    |   Yes   |    Yes      | Yes  |  Yes |   PTP
// QuantHouse  |  Yes   |    Yes      | Yes  |  No  |   NTP
// SFTI       |   Yes   |    No       | Yes  |  Yes |   PTP
```
