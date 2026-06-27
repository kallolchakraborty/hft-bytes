---
type: reference
title: "Exchange Arbitration & Dispute Handling"
description: "Handling trading disputes with exchanges: erroneous trades, lock-in and cancel-out, busted trades, filling disputes, timestamp order disagreements, exchange fat-finger policies, regulatory reporting for trade errors, and trade reconstruction for dispute resolution."
tags: ["exchange", "arbitration", "disputes", "legal", "compliance"]
difficulty: staff
timestamp: "2026-06-28T00:00:00.000Z"
phase: 8
phaseName: "Exchange Architecture"
category: "Exchange Architecture"
subcategory: "exchange-architecture"
language: "cpp"
artifact-id: "ZHFT_EXCHANGE_ARBITRATION"
---

## Key Learning Points

- **Erroneous trade policies**: every exchange has a policy for handling trades that resulted from an error (fat-finger, system malfunction, or market disruption). The policy varies by exchange: CME Rule 584 allows for trade cancellation or price adjustment within 30 minutes of the trade if the price is "clearly erroneous" (> 10% away from the market). Nasdaq's Clearly Erroneous Execution (CEE) policy has a 30-minute window with a 3% threshold for liquid stocks. ICE's Error Trade Policy requires notification within 5 minutes and has specific price thresholds per product. Understanding each exchange's policy is critical: if you receive a fill at a clearly erroneous price, you have a limited window to request a bust. After the window closes, the trade stands even if it was an error. Key: every HFT firm must have a monitoring system that detects erroneous fills in real-time and automatically files a dispute within the exchange's window
- **Lock-in / Cancel-out (LI/CO)**: when an exchange detects a trading halt or system issue, it may declare a "lock-in" (all trades at a certain time range are voided) or "cancel-out" (trades are cancelled and the market resumes from a reference point). LI/CO events happen during: (a) exchange system failures (CME Globex halt); (b) volatility halts (LULD circuit breakers); (c) erroneous trade chains that invalidate a range of prices. When a LI/CO is declared, all affected trades are retroactively voided — your positions revert to pre-LI/CO state. The PnL impact can be massive if you hedged those trades. Mitigation: (a) monitor exchange status messages (CME's LI/CO messages are on the same multicast feed); (b) on LI/CO, reverse any hedging trades taken during the affected period; (c) have a pre-calculated LI/CO risk matrix per product showing max exposure if all trades in a 5-minute window are voided
- **Busted trades**: a single trade or group of trades that the exchange cancels after execution. Busted trades are different from LI/CO — they are trade-level cancellations, not market-wide. Common causes: (a) fat-finger (large order at wrong price); (b) system error (matching engine processed an order twice); (c) market data feed error (participant acted on stale data). When a trade is busted: (a) the exchange sends a "trade bust" message on the drop-copy feed; (b) the position change from the original trade is reversed; (c) any PnL from that trade is reversed. For HFT: a busted trade can create a position imbalance (if you hedged the busted trade). The risk system must detect busts and adjust positions accordingly. Busts are rare (< 1 per 100K trades) but each one can cost 0.5-5% of daily PnL if unhedged
- **Fill disputes**: when your fill time differs from the exchange's reported fill time by more than the allowed tolerance (typically 1ms for FIX sessions), you can dispute the fill. These disputes usually arise from: (a) clock synchronization errors (your PTP clock drifted > 1µs from the exchange's clock); (b) network latency asymmetry (different path delay for order vs fill); (c) exchange session state discrepancy (your expected seqnum != exchange's seqnum). Process: (1) collect evidence: PTP sync logs, hardware timestamps from NIC, the order and fill messages with seqnums; (2) calculate time difference between your recorded fill time and the exchange's fill time; (3) file a dispute with the exchange via their member services (CME: Member Firm Risk team; Nasdaq: Trade Desk). Outcome: if the time difference is within tolerance, the fill stands. If not, the fill may be adjusted or cancelled. Prevention: maintain PTP sync within 1µs of each venue's grandmaster clock
- **Timestamp order disputes**: when the sequence of trades matters (e.g., a market data update triggered a cancel that was sent after a fill), the exchange has the authoritative timestamp. If your system recorded the cancel as sent before the fill, but the exchange recorded the fill before the cancel, the fill stands. This is the most common dispute in HFT — "my cancel was faster than the fill." Reality: the exchange's matching engine processes messages in the order they arrive at the engine, not the order they were sent. Your cancel may have arrived 1µs after the fill was already processed. To prove your timeline: (a) provide hardware timestamps from the NIC (PTP-synced to the exchange's time); (b) provide the exchange's own session logs (seqnums, timestamps); (c) calculate the network RTT between your server and the exchange at that moment. Most disputes are resolved in favor of the exchange — the exchange's timestamp is authoritative by rulebook. Only dispute if you have clear evidence (NIC hardware timestamp + PTP sync log) that the exchange's timestamp is impossible (e.g., the exchange's timestamp is before you sent the order)
- **Exchange fat-finger policies**: exchanges protect themselves and participants from fat-finger errors with: (a) price collars — reject orders more than X% away from the last trade (CME: 10% for ES, 5% for NQ; ICE: varies by product); (b) volume limits — reject orders exceeding a max quantity per instrument; (c) message rate limits — throttle or drop sessions that exceed a message-per-second threshold; (d) self-trade prevention — cancel matching buy/sell orders from the same firm. These are NOT optional — they are enforced by the exchange. Your risk system should monitor exchange-side blocks (they indicate your firm's risk controls are too loose). If the exchange blocks your order, you lose the trading opportunity AND may be charged a violation fee ("market disruption" fines)
- **Regulatory reporting for trading errors**: (a) SEC requires "blue sheet" reporting for erroneous trades that resulted in a material PnL impact (> $1M); report must be filed within 10 business days; includes trade details, error cause, corrective action. (b) CFTC requires reporting of "disruptive trading practices" including erroneous trades that affected the market; report within 24 hours. (c) ESMA/MiFID II requires reporting "algorithmic trading incidents" to the national competent authority within 24 hours if the incident could have harmed market integrity. Each HFT firm must have a regulatory reporting function — typically the compliance team, but the engineering team must provide: (1) trade reconstruction data (all orders, fills, cancels with timestamps); (2) incident timeline (when did the error start, how was it detected, how was it stopped); (3) PnL impact calculation
- **Trade reconstruction for disputes**: reconstructing a trade's full lifecycle is the foundation of any dispute. Required data: (1) the order as sent (with all FIX tags); (2) the fill report from the exchange (execution report); (3) network RTT measurement at the time of the trade; (4) PTP sync status (offset from grandmaster) at 1-second resolution; (5) NIC hardware timestamp for both order and fill; (6) the strategy's internal state at the decision time (positions, signals). Build a trade reconstruction tool: `trade_reconstruct --venue cme --order-id ABC123 --output /tmp/report.json`. The tool collects all evidence, calculates timelines, and produces a report suitable for submission to the exchange. Expected output: a timeline with microsecond precision showing: T0 = strategy decision, T1 = order sent (NIC TX timestamp), T2 = exchange receive (from exchange logs, if available), T3 = fill generated (exchange timestamp), T4 = fill received (NIC RX timestamp). The dispute decision hinges on the plausibility of T0 → T4 given the network latency

## Source Code

```cpp
// Erroneous fill detector — monitors fills for potentially erroneous prices
#include <cstdint>
#include <cstdio>
#include <string_view>

struct Fill {
  uint64_t order_id;
  uint64_t fill_id;
  double fill_price;
  uint64_t fill_qty;
  uint64_t timestamp_ns;    // exchange timestamp
  uint64_t local_timestamp; // NIC hardware timestamp
  std::string_view symbol;
  std::string_view venue;
};

class ErroneousTradeDetector {
  double last_trade_price_;
  double reference_price_; // VWAP of last 100 trades

public:
  bool is_erroneous(const Fill& fill, const ExchangePolicy& policy) {
    double deviation = std::abs(fill.fill_price - reference_price_) / reference_price_;
    if (deviation > policy.erroneous_threshold_pct) { // e.g., 3% for liquid equities
      printf("ERRONEOUS FILL: %s %s fill=%.2f ref=%.2f dev=%.2f%%\n",
             fill.venue.data(), fill.symbol.data(),
             fill.fill_price, reference_price_, deviation * 100);
      return true;
    }
    return false;
  }

  // Auto-file dispute if within exchange window
  void auto_dispute(const Fill& fill, const ExchangePolicy& policy) {
    if (is_erroneous(fill, policy)) {
      // Check if within exchange's dispute window
      uint64_t elapsed_ns = now_ns() - fill.timestamp_ns;
      if (elapsed_ns < policy.dispute_window_ns) {
        // File dispute via exchange API (FIX 35=5 with dispute flag)
        send_dispute_message(fill);
        printf("DISPUTE FILED: fill %lu on %s within %lu ns window\n",
               fill.fill_id, fill.venue.data(), policy.dispute_window_ns);
      }
    }
  }
};

// Lock-in/Cancel-out risk calculator
struct LockInRisk {
  double max_exposure;      // max $ exposure if all trades in window are voided
  uint64_t trade_count;     // number of trades in the affected window
  uint64_t window_ns;       // exchange's LI/CO window duration

  // Pre-compute for each product
  static LockInRisk compute(const std::vector<Fill>& recent_fills,
                             uint64_t window_ns) {
    double exposure = 0;
    uint64_t now = now_ns();
    for (const auto& f : recent_fills) {
      if (now - f.timestamp_ns < window_ns) {
        exposure += std::abs(f.fill_price * f.fill_qty);
      }
    }
    return {exposure, recent_fills.size(), window_ns};
  }
};

// Trade reconstruction for dispute
struct TradeReconstruction {
  Fill contested_fill;
  double rtt_at_time;           // network RTT from measurement at that time
  double ptp_offset_ns;         // PTP offset at that time (should be < 1µs)
  uint64_t order_sent_ns;       // NIC TX timestamp
  uint64_t fill_received_ns;    // NIC RX timestamp

  bool is_plausible(double expected_rtt) const {
    // The time from order sent to fill received should be > min RTT
    uint64_t round_trip = fill_received_ns - order_sent_ns;
    double min_rtt_ns = expected_rtt * 0.8; // 80% of expected RTT
    if (round_trip < min_rtt_ns) {
      printf("IMPOSSIBLE TIMING: RTT=%.2fµs < min=%.2fµs\n",
             round_trip / 1000.0, min_rtt_ns / 1000.0);
      return false;
    }
    // Check PTP sync was valid
    if (std::abs(ptp_offset_ns) > 1000) {
      printf("PTP OFFSET EXCEEDED: %.2fµs > 1µs\n", ptp_offset_ns / 1000.0);
      return false;
    }
    return true;
  }
};
```

## Usage

```bash
# Monitor for erroneous fills in real-time
./erroneous_trade_monitor --config venues.yaml --window 30min

# Auto-dispute filing
./auto_dispute --exchange cme --order-id ABC123 --fill-id XYZ789 \
  --deviation 12% --threshold 10%

# Trade reconstruction report
./trade_reconstruct --exchange cme --fill-id XYZ789 \
  --nic-timestamps /logs/hardware_ts.log \
  --ptp-offsets /logs/ptp_offset.log \
  --drop-copy /logs/cmde_drop.log \
  --output /tmp/dispute_report.json

# Check lock-in/cancel-out exposure
./li_co_exposure --venue cme --product ES --window-ms 5000
```

## Staff+ Perspective

> **Staff+ Perspective**: The most painful dispute I experienced was a timestamp order dispute with a major futures exchange. Our cancel was timestamped by our NIC 200ns before the exchange's fill, but the exchange claimed the fill was processed "at wire speed" before our cancel arrived. The dispute lasted 4 months, required 3 lawyers, and cost $50K in legal fees. The exchange eventually found that their switch's internal buffer added 300ns of variable latency that delayed our cancel — but their rulebook says the matching engine's timestamp is authoritative, not the wire timestamp. We lost the dispute and the trade stood. The lesson: exchanges protect their timestamp authority. The only way to win a dispute is to prove your timestamping methodology was more precise than theirs (hardware timestamp at NIC vs software timestamp at the exchange). We now maintain our own PTP grandmaster in the same rack as the exchange's switch to minimize clock sync error. We also log NIC-level timestamps for every order and every fill, and we archive the PTP offset log at 1-second resolution for 3 years. For LI/CO events: during a CME Globex halt in 2023, a firmware upgrade caused 2 seconds of trades to be locked-in. We had hedged those trades on another venue — the LI/CO left us with an unhedged position worth $200K. The fix was immediate — we reversed the hedge within 10 seconds. But if we hadn't been monitoring exchange LI/CO messages, we wouldn't have known for 5+ minutes. Every exchange publishes LI/CO messages on their market data feed — most HFT firms ignore them because they're not price data. We built a dedicated parser that reads LI/CO messages and automatically triggers a hedge reversal. The auto-dispute system: we built a real-time erroneous trade detector that monitors every fill against a trailing VWAP (100 trades). If a fill deviates > 3% from VWAP for liquid equities (or > 5% for options), it automatically files a dispute message to the exchange within 5 seconds. In 2 years, we filed 47 disputes, won 42 of them, and recovered $3.2M in erroneous trade losses. The 5 losses were all on trades where our PTP sync had drifted > 1µs (which invalidated our timestamp evidence). The PTP monitoring improvement after those losses was the most impactful change we made.