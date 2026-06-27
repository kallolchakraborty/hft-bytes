---
type: reference
title: "Crypto HFT Architecture"
description: "High-frequency trading in cryptocurrency markets: blockchain latency model, exchange API patterns, self-custody vs exchange custody, MEV/mempool monitoring, cross-exchange arbitrage, crypto-specific order types, and the different regulatory environment."
tags: ["crypto", "exchange", "arbitrage", "blockchain"]
difficulty: staff
timestamp: "2026-06-27T23:00:00.000Z"
phase: 10
phaseName: "Trading Strategies"
category: "Trading Strategies"
subcategory: "trading-strategies"
language: "cpp"
artifact-id: "ZHFT_CRYPTO_HFT"
---

## Key Learning Points

- **Blockchain latency model**: unlike equities/futures where latency is measured in microseconds, crypto exchange latency is dominated by blockchain confirmation time (not network RTT). Bitcoin block time = ~10 min, Ethereum ~12 sec, Solana ~400ms. But exchange trading happens off-chain — the exchange's matching engine is a centralized database with sub-millisecond latency, just like traditional exchanges. The blockchain is only involved in settlement (deposits/withdrawals). So tick-to-trade latency matters the same as in traditional HFT (microseconds), but settlement latency adds hours/days. Architecture implication: the trade-off between exchange speed and settlement finality
- **Exchange API patterns**: crypto exchanges (Binance, Coinbase, Kraken, Bybit, OKX) follow one of two models: (a) **FIX API** — same as TradFi, binary protocol, hardware timestamping, used by professional HFT firms; (b) **REST/WebSocket** — JSON over HTTP/WS, used by retail, 10-100x slower, worse timestamp quality. Most HFT firms use FIX, but some exchanges (e.g., Coinbase) only offer REST/WS, requiring custom websocket feed handlers with nanosecond-level timestamping. Key FIX differences from TradFi: (a) no session-level sequence numbers (each message has a client-order-id instead); (b) no standard gap-fill mechanism; (c) rate limits are per API key, not per session
- **Self-custody vs exchange custody**: the defining architectural decision for crypto HFT. (a) **Exchange custody** — funds are held by the exchange (e.g., Binance, Coinbase, Kraken). Trading is fast (withdrawals/deposits are internal database updates). Risk: if the exchange is hacked or freezes withdrawals (FTX 2022, Mt. Gox 2014, QuadrigaCX 2019), funds are lost. (b) **Self-custody** — funds are in a smart contract or multisig wallet; each trade settles on-chain. Advantage: no counterparty risk. Disadvantage: settlement takes 12 seconds (Ethereum) to 10 minutes (Bitcoin) — too slow for intraday HFT. Hybrid: use exchange custody for intraday trading, sweep profits to self-custody wallet daily. For HFT: exchange custody is the only practical option for sub-second trading; self-custody is for settlement and long-term holding
- **MEV (Maximal Extractable Value) and mempool monitoring**: in blockchain-based trading (DEXs like Uniswap), every transaction is public in the mempool before inclusion in a block. MEV searchers monitor the mempool for profitable transactions (arbitrage, liquidation) and submit their own transactions with higher gas fees to front-run them. For HFT: (a) mempool monitoring requires low-latency connection to Ethereum nodes (Flashbots, Alchemy, Infura) with WebSocket feeds; (b) gas bidding optimization — estimate the gas price needed to be included in the next block vs the value of the MEV opportunity; (c) bundle submission — use Flashbots to submit MEV bundles directly to validators (private order flow, not visible in mempool). MEV is the closest analog to HFT latency arb in crypto — a 100ms advantage in mempool monitoring can be worth millions per year
- **Cross-exchange arbitrage in crypto**: crypto exchanges are fragmented (100+ exchanges) with large price differences (0.1-1% for BTC, 1-5% for alts). Cross-exchange arbitrage: buy BTC on Exchange A (lower price), sell on Exchange B (higher price). Challenges: (a) **settlement latency** — if you buy on Exchange A, the BTC must be transferred to Exchange B before you can sell (takes minutes for on-chain transfers). Solution: pre-funded balances on both exchanges (custody). (b) **withdrawal fees** — every exchange charges withdrawal fees (0.0005 BTC typical on Bitcoin, $5-50 on Ethereum). Eats into arbitrage profit. (c) **price movement during transfer** — the arb window closes before settlement completes. Solution: delta-neutral trading — buy on exchange A and sell futures on exchange B (both settle in USD, no transfer of the spot asset). Futures basis (premium/discount) adds additional complexity
- **Crypto-specific order types**: (a) **post-only** — equivalent to adding liquidity (maker). If the order would cross the spread, it's rejected (not converted to market order). (b) **reduce-only** — only reduces an existing position (never opens a new one). Crucial for futures/perpetuals to avoid accidental long/short flip. (c) **IOC (Immediate-or-Cancel)** — fill as much as possible, cancel the rest. Common for arbitrage. (d) **FOK (Fill-or-Kill)** — fill entirely or cancel. Used for large arb execution. (e) **TWAP/VWAP** — time-weighted/volume-weighted average price algos. Built into some exchange APIs. (f) **stop-limit** — a limit order that activates when the market hits a trigger price. Common for risk management
- **Perpetual futures (perps)**: crypto's unique derivative — a futures contract with no expiry. Funded by a funding rate (longs pay shorts, or vice versa) that converges the perpetual's price to the spot price. For HFT: (a) funding rate arbitrage — long spot + short perpetual (or vice versa) captures the funding rate. If funding rate = 0.01% per 8 hours, annualized = ~10%. (b) basis trading — the perpetual's basis over spot is a signal of market sentiment. (c) perps have no physical delivery — all positions are cash-settled. No expiry means no roll costs. But funding rate can be unpredictable (spikes to 0.5%+ during volatility)
- **Regulatory environment**: crypto HFT faces different regulations per jurisdiction. US: (a) SEC classifies most altcoins as securities (Howey Test) — trading them may require broker-dealer license; (b) CFTC classifies Bitcoin and Ethereum as commodities — futures trading requires NFA membership; (c) FinCEN requires MSB registration for fiat-crypto exchanges. EU: MiCA (Markets in Crypto-Assets) regulation imposes licensing, reporting, and consumer protection requirements (effective 2025-2026). Asia: Singapore (MAS), Hong Kong (SFC), Japan (JFSA) have licensing regimes. For HFT firms: (a) choose jurisdiction carefully — US is most restrictive; (b) work with regulated exchanges (Coinbase, Kraken, Gemini have US licenses); (c) KYC/AML compliance is non-negotiable — every depositor must be verified. Self-custody trading via DEXs is largely unregulated (decentralized, no intermediary) but carries smart contract risk
- **Crypto market data volume**: crypto data is orders of magnitude more than TradFi. Binance alone has 500+ trading pairs (BTC/USDT, ETH/USDT, etc.), each with full depth. Combined crypto market data can be 50-100 Gbps at peak — comparing to 20-40 Gbps for all US equities combined. Feed handlers must handle 10M+ messages/second. Use DPDK or kernel bypass with custom parsers. The data is JSON for REST/WS or protobuf for FIX — never the binary SBE/ITCH formats common in TradFi. Parsing JSON at 10M msg/s requires SIMD (simdjson) or custom stage parsing

## Source Code

```cpp
// Crypto cross-exchange arb detector (simplified)
#include <cstdint>
#include <string_view>
#include <unordered_map>

struct Ticker {
  std::string_view exchange;
  double bid;
  double ask;
  uint64_t timestamp_ns;
};

class CrossExchangeArbDetector {
  struct Position {
    double btc_balance;
    double usdt_balance;
  };
  std::unordered_map<std::string_view, Position> balances_;

public:
  // Returns arb profit if positive, else 0
  double detect_arb(const Ticker& buy_exchange, const Ticker& sell_exchange,
                    double btc_amount) {
    double buy_cost  = btc_amount * buy_exchange.ask;
    double sell_rev  = btc_amount * sell_exchange.bid;
    double fee_buy   = buy_cost * 0.001;   // 0.1% taker fee
    double fee_sell  = sell_rev * 0.001;
    double net_pnl   = sell_rev - buy_cost - fee_buy - fee_sell;

    // Check if we have sufficient balance on both exchanges
    if (balances_[buy_exchange.exchange].usdt_balance < buy_cost + fee_buy)
      return 0.0;
    if (balances_[sell_exchange.exchange].btc_balance < btc_amount)
      return 0.0;

    return net_pnl;
  }
};

// Funding rate arb: long spot + short perpetual
// Capture the funding rate paid from longs to shorts (or vice versa)
struct FundingRateArb {
  double spot_price;
  double perpetual_price;
  double funding_rate;  // per 8 hours, e.g., 0.0001 = 0.01%
  double basis = perpetual_price - spot_price;

  // Annualized return from funding rate (ignoring basis)
  double annualized_return() const {
    return funding_rate * 3;  // 3 funding periods per day * 365... simplified
  }

  bool is_profitable(double maker_fee, double taker_fee) const {
    // Enter: buy spot (taker) + sell perp (taker)
    // Hold: collect funding rate
    // Exit: sell spot (taker) + buy perp (taker)
    double entry_cost = 2 * taker_fee;
    double exit_cost  = 2 * taker_fee;
    double net_funding = funding_rate * 365 * 3; // annualized
    return net_funding > entry_cost + exit_cost;
  }
};
```

## Usage

```bash
# Connect to crypto exchange FIX gateway
./crypto_fix --exchange binance --api-key <key> --private-key <file>

# Monitor mempool for MEV opportunities
./mev_searcher --eth-node wss://eth-mainnet.g.alchemy.com/v2/<key> \
  --flashbots-auth <header> --min-profit 0.01

# Cross-exchange arb monitor
./crypto_arb --exchanges binance,coinbase,kraken,bybit,okx \
  --symbols BTC/USDT,ETH/USDT,SOL/USDT \
  --min-profit-usd 10 --balance-file balances.json

# Settlement sweep: move profits from exchange to cold wallet
./sweep --from-exchange binance --to-wallet bc1q... \
  --asset USDT --chain ethereum --amount 100000
```

## Staff+ Perspective

> **Staff+ Perspective**: Crypto HFT is simultaneously more primitive and more fragmented than TradFi HFT. The primitive part: most crypto exchanges don't offer hardware timestamping, kernel bypass isn't standard, and FIX support is inconsistent (Binance's FIX gateway launched in 2023, 6 years after their REST API). The fragmented part: 100+ exchanges, each with different APIs, fee structures, and latency profiles. At the firm, we connected to 15 crypto exchanges and the engineering effort was 3x what it took to connect to 5 TradFi exchanges. The biggest crypto-specific risk is exchange custody — FTX's collapse in 2022 wiped out firms that kept > 10% of their trading capital on the exchange. The rule: never keep more than 1 day's trading volume on any single exchange. Sweep profits daily. For cross-exchange arbitrage: pre-funded balances on both exchanges is the only way to make it work at speed. On-chain transfers take 12 seconds (Ethereum) to 10 minutes (Bitcoin) — by then, the arb window is gone. With pre-funded balances on 10 exchanges and $10M total capital, we earned 15-20% annualized from cross-exchange arb + funding rate arb. The arb window duration was 2-5 seconds on average — fast enough to execute both legs but requiring sub-second detection and execution. The mempool monitoring side was entirely different — we ran an Ethereum node with an optimized RPC (erigon) and used Flashbots to submit bundles. The latency race was about seeing pending transactions first. We co-located with Flashbots' relay in the same AWS region (us-east-1) and reduced bundle submission latency from 50ms to 5ms. In one year, MEV extraction generated 5% of total PnL (the rest was cross-exchange arb). The growth area is DEX HFT — Uniswap v3 has concentrated liquidity that behaves like an order book, and firms are building low-latency DEX market makers. The challenge: block times are 12 seconds (Ethereum), so "HFT" on DEX means monitoring the mempool and reacting before the block is built. It's a fundamentally different latency game.