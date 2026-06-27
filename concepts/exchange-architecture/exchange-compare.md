---
type: decision-matrix
title: "Exchange Compare"
description: "CME Globex: iLink 3 (SBE binary) for orders, MDP 3.0 for market. Eurex T7: EBS (Enhanced Broadcast Solution) for market data,"
tags: ["exchange-protocols"]
difficulty: advanced
timestamp: "2026-06-27T03:06:09.430Z"
phase: 8
phaseName: "Exchange Architecture"
category: "Phase 8 - Exchange Architecture"
subcategory: "exchange-architecture"
language: "cpp"
artifact-id: "ZHFT_EXCHANGE_COMPARE"
---
## Key Learning Points

- CME Globex: iLink 3 (SBE binary) for orders, MDP 3.0 for market
- Eurex T7: EBS (Enhanced Broadcast Solution) for market data,
- ICE: Binary protocol (not FIX, not SBE — proprietary fixed-length).
- LSE Millennium: Millennium Exchange, ~8μs RTT. Price-time priority.
- Matching engine types: price-time (fair, standard), pro-rata (large

## Usage

// ExchangeCompare cmp;
// cmp.compare(startum);

## Source Code

```cpp
/* MATRIX: Exchange Architecture Comparison
 *
 * +------------------+------------+------------+-------------+---------------+
 * | Attribute        | CME Globex | Eurex T7   | ICE         | LSE Mill.     |
 * +------------------+------------+------------+-------------+---------------+
 * | Order Protocol   | iLink 3    | T7 SBE     | ICE Binary  | Millennium    |
 * |                  | (SBE 6.2)  | (SBE 5.0)  | (proprietary)| (FIX 4.4+)   |
 * | Market Data      | MDP 3.0    | EBS        | ICE MD      | Millennium MD |
 * | Typical RTT (co-lo)| 5 μs     | 5 μs       | 10 μs       | 8 μs         |
 * | Matching         | Price-time | Price-time | Price-time  | Price-time   |
 * | Seq Mgmt         | Session    | Session    | Per-session | Per-session  |
 * |                   | + MsgSeqNum| + MsgSeqNum| + MsgSeqNum | + MsgSeqNum  |
 * | Encryption       | RSA opt.   | Optional   | No          | No           |
 * | Mass Quote       | Yes (5-10) | Yes (50)   | Yes         | Limited      |
 * | Auction Types    | Open/Close | Open/Close | Open/Close  | Open/Close   |
 * |                   | /Volatility| /Volatility|             | /Volatility  |
 * | Cert Program     | CME Cert   | T7 Conform | ICE Cert    | LSE Cert     |
 * | Fee Model        | Maker-Taker| Maker-Taker| Maker-Taker | Maker-Taker  |
 * | Co-lo Available  | Yes        | Yes        | Yes         | Yes          |
 * | Market Makers    | DMM, SLP   | DMM        | DPM         | DMM          |
 * +------------------+------------+------------+-------------+---------------+
 *
 * Decision factors for venue selection:
 *   - Lowest RTT: CME/Eurex tie (5 μs) — both suitable for HFT.
 *   - Protocol complexity: ICE binary is simplest to implement;
 *     SBE requires schema compilation.
 *   - Fee structure: CME offers aggressive maker rebate tiers;
 *     ICE has volume-based discounts.
 *   - Product coverage: CME dominates futures (ES, NQ, CL, ZN);
 *     Eurex dominates European rates (FGBL, FGBM).
 *   - Reliability: All four have >99.99% uptime SLAs with known
 *     outage patterns (see ZHFT_EXCHANGE_OUTAGES).
 */

#include <array>
#include <bit>
#include <cstdint>
#include <cstring>
#include <string_view>

// ---------------------------------------------------------------------------
// Exchange descriptor
// ---------------------------------------------------------------------------
struct ExchangeDescriptor {
  char     name[8];
  uint32_t mic;                     // e.g., "XCME" packed
  double   rtt_us;                  // Typical co-lo RTT in microseconds
  uint32_t throughput_ops_per_sec;  // Sustained order rate
  uint8_t  protocol_id;             // 0=ILink3, 1=T7, 2=ICE, 3=Millennium
  bool     supports_mass_quote;
  bool     supports_iceberg;
  double   maker_rebate_max;        // Best maker rebate per share
  double   taker_fee_max;           // Worst taker fee per share
};

static constexpr std::array<ExchangeDescriptor, 4> kExchanges = {{
  {"CME",   0x58434D45, 5.0,  750000, 0, true,  true,  -0.0010, 0.0015},
  {"EUREX", 0x58455552, 5.0,  500000, 1, true,  true,  -0.0008, 0.0012},
  {"ICE",   0x49434500, 10.0, 200000, 2, true,  false, -0.0005, 0.0008},
  {"LSE",   0x4C534500, 8.0,  300000, 3, false, true,  -0.0006, 0.0010},
}};

// ---------------------------------------------------------------------------
// Comparison query
// ---------------------------------------------------------------------------
class ExchangeCompare {
public:
  static const ExchangeDescriptor *find(std::string_view name) {
    for (auto &e : kExchanges) {
      if (name == e.name) return &e;
    }
    return nullptr;
  }

  static void compare() {
    // In production: output comparison table
    // Identify best venue per criterion
  }
};
```
## Decision Matrix

| : Exchange Architecture Comparison |
| --- |
| +------------------+------------+------------+-------------+---------------+ |
| Attribute | CME Globex | Eurex T7 | ICE | LSE Mill. |
| +------------------+------------+------------+-------------+---------------+ |
| Order Protocol | iLink 3 | T7 SBE | ICE Binary | Millennium |
| (SBE 6.2) | (SBE 5.0) | (proprietary) | (FIX 4.4+) |
| Market Data | MDP 3.0 | EBS | ICE MD | Millennium MD |
| Typical RTT (co-lo) | 5 μs | 5 μs | 10 μs | 8 μs |
| Matching | Price-time | Price-time | Price-time | Price-time |
| Seq Mgmt | Session | Session | Per-session | Per-session |
| + MsgSeqNum | + MsgSeqNum | + MsgSeqNum | + MsgSeqNum |
| Encryption | RSA opt. | Optional | No | No |
| Mass Quote | Yes (5-10) | Yes (50) | Yes | Limited |
| Auction Types | Open/Close | Open/Close | Open/Close | Open/Close |
| /Volatility | /Volatility | /Volatility |
| Cert Program | CME Cert | T7 Conform | ICE Cert | LSE Cert |
| Fee Model | Maker-Taker | Maker-Taker | Maker-Taker | Maker-Taker |
| Co-lo Available | Yes | Yes | Yes | Yes |
| Market Makers | DMM, SLP | DMM | DPM | DMM |
| +------------------+------------+------------+-------------+---------------+ |
| Decision factors for venue selection: |
| - Lowest RTT: CME/Eurex tie (5 μs) — both suitable for HFT. |
| - Protocol complexity: ICE binary is simplest to implement; |
| SBE requires schema compilation. |
| - Fee structure: CME offers aggressive maker rebate tiers; |
| ICE has volume-based discounts. |
| - Product coverage: CME dominates futures (ES, NQ, CL, ZN); |
| Eurex dominates European rates (FGBL, FGBM). |
| - Reliability: All four have >99.99% uptime SLAs with known |
| outage patterns (see ZHFT_EXCHANGE_OUTAGES). |

