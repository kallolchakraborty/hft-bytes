---
type: reference
title: "System Architecture Blueprint"
description: "End-to-end HFT system architecture: market data ingestion, feed processing, order-book reconstruction, strategy execution, order management, and exchange gateway. Thread-per-stage pipeline model."
tags: ["performance"]
timestamp: "2026-06-27T03:06:09.405Z"
phase: 1
phaseName: "Foundations"
category: "Foundations"
subcategory: "foundations"
language: "cpp"
artifact-id: "ZHFT_SYSTEM_ARCHITECTURE"
---
## Key Learning Points

- HFT systems decompose into pipelined stages: market data feed -> parser -> order book -> strategy -> OMS -> SOR -> FIX engine -> exchange gateway
- Each stage runs on a dedicated core with its own thread and lock-free queues between them
- Market data stage: one thread per exchange feed (e.g., CME A, CME B, Eurex); pinned to NUMA node nearest the NIC
- Parser stage: SIMD-accelerated protocol parsing (FIX/ITCH/SBE); produces normalised internal order-book events
- Order-book stage: maintains per-symbol LOB; produces top-of-book, imbalance, and quote events for strategies
- Strategy stage: runs trading logic; subscribes to relevant symbols; produces order requests to OMS
- OMS/SOR stage: manages order lifecycle; routes orders to appropriate venues; tracks fill/partial/reject status
- Gateway stage: implements exchange-specific session logic; handles sequence numbers, resend requests, heartbeats
- Thread isolation: no shared mutable state between pipeline stages; data flows through SPSC queues
- Heartbeat/watchdog: each stage sends periodic liveness signals; monitoring alerts on missed heartbeats

```mermaid
graph LR
    NIC["NIC 100GbE"] --> Parser["Parser Stage<br/>Core 0<br/>SIMD Decode"]
    Parser --> OB["Order-Book Stage<br/>Core 1<br/>LOB Rebuild"]
    OB --> Strat["Strategy Stage<br/>Core 2<br/>MM Logic"]
    Strat --> OMS["OMS/SOR Stage<br/>Core 3<br/>Order Mgmt"]
    OMS --> GW["Gateway Stage<br/>Core 4<br/>FIX Session"]
    GW --> Exch["Exchange<br/>Matching Engine"]

    subgraph Legend[" "]
        direction LR
        Q["SPSC Queue"] -.- P
    end

    style NIC fill:#1e40af,color:#fff
    style Exch fill:#047857,color:#fff
    style Parser fill:#1e3a5f,color:#93c5fd
    style OB fill:#2e1f6e,color:#a5b4fc
    style Strat fill:#3b1f6e,color:#c4b5fd
    style OMS fill:#5b1f3e,color:#f9a8d4
    style GW fill:#5b2a1f,color:#fdba74
```

## Usage

```cpp
// Pipeline architecture sketch
struct PipelineStage {
    virtual ~PipelineStage() = default;
    virtual const char* name() = 0;
    virtual void start() {
        thread_ = std::jthread([this](std::stop_token st) { run(st); });
        // Pin to dedicated core
        cpu_set_t cpuset;
        CPU_ZERO(&cpuset);
        CPU_SET(core_, &cpuset);
        pthread_setaffinity_np(thread_.native_handle(), sizeof(cpuset), &cpuset);
    }
    virtual void run(std::stop_token st) = 0;
    int core_ = -1;
    std::jthread thread_;
    SPSCQueue<Event, 65536>* input_{nullptr};
    SPSCQueue<Event, 65536>* output_{nullptr};
};

// Example: five-stage pipeline
// NIC -> Parser -> OrderBook -> Strategy -> OMS -> Gateway -> Exchange
// Each arrow is a lock-free SPSC queue
// Core assignment: 0=Parser, 1=OrderBook, 2=Strategy, 3=OMS, 4=Gateway
```

## Source Code

```cpp
// Parser stage skeleton
class ParserStage : public PipelineStage {
    const char* name() override { return "parser"; }
    void run(std::stop_token st) override {
        while (!st.stop_requested()) {
            Event evt;
            while (input_->pop(evt)) {
                // Parse raw packet, produce normalised event
                MktDataEvent mde = parseITCH(evt.raw_data, evt.len);
                output_->push(Event::fromMktData(mde));
            }
        }
    }
};

// Strategy stage subscribes to symbols
class StrategyStage : public PipelineStage {
    const char* name() override { return "strategy"; }
    void run(std::stop_token st) override {
        MarketMakingStrategy mm;
        while (!st.stop_requested()) {
            Event evt;
            while (input_->pop(evt)) {
                if (evt.type == EventType::TOP_OF_BOOK) {
                    auto signal = mm.onTopOfBook(evt.tob);
                    if (signal.action != Action::NONE) {
                        output_->push(Event::fromOrderRequest(signal.order));
                    }
                }
            }
        }
    }
};
```
