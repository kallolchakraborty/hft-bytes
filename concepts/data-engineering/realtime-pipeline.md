---
type: reference
title: "Realtime Pipeline"
description: "Kafka vs Redpanda vs Aeron: latency/throughput/consistency tradeoffs. Exactly-once semantics: idempotent producer + transactional"
tags: ["data-engineering", "deployment", "ipc", "time-series"]
difficulty: intermediate
timestamp: "2026-06-27T03:06:09.444Z"
phase: 12
phaseName: "Data Engineering"
category: "Phase 12 - Data Engineering"
subcategory: "data-engineering"
language: "cpp"
artifact-id: "ZHFT_REALTIME_PIPELINE"
---
## Key Learning Points

- **Kafka vs Redpanda vs Aeron**: latency/throughput/consistency tradeoffs — Kafka: 1-100ms latency, high throughput (millions msg/sec), strong consistency (acks=all, ISR replication), complex operations (ZooKeeper → KRaq migration). Redpanda: 1-10ms latency, Kafka API-compatible, no JVM (C++ Raft implementation), simpler operations. Aeron: 1-10μs latency (IPC), 10-100μs (UDP), no persistence, no replay, no consumer groups. For HFT: Aeron is the default for inter-process communication (same machine or same rack). Redpanda/Kafka are for cross-datacenter replication, historical data storage, and audit trails. The choice is binary: sub-millisecond → Aeron/ef_vi; millisecond → Redpanda; durability required → Kafka
- **Exactly-once semantics**: idempotent producer + transactional consumer — Kafka's exactly-once semantics (EOS) requires: (a) idempotent producer (deduplication via sequence numbers), (b) transactional consumer (read-committed isolation level), (c) atomic writes (producer writes to multiple partitions atomically). For HFT: EOS is overkill for market data ingestion (duplicates are harmless — just ignore stale ticks). EOS is critical for order management (never execute an order twice). The tradeoff: EOS adds 2-5ms latency per message (transaction commit overhead). Use idempotent producer only (no transactions) for market data; use full EOS for order management
- **Schema registry**: Avro/Protobuf for forward/backward compat — the schema registry stores message schemas and handles versioning. Avro: rich schema evolution (add/remove fields with defaults), JSON schema definition, compact binary encoding. Protobuf: simpler schema (`.proto` files), faster encoding, more widely used. FlatBuffers: zero-deserialize (direct memory access), no schema registry needed, but schema evolution is limited. For HFT: FlatBuffers for low-latency paths (market data decode: 10-50x faster than Avro), Avro for analytics (rich schema evolution, query-friendly). The schema registry is a single point of failure — run it in a 3-node cluster with automatic failover
- **Partitioning by symbol**: ordering guarantees — partition by symbol so all ticks for a given symbol are processed by the same consumer in order. This is critical for strategies that depend on tick ordering (e.g., order book reconstruction, trade sequencing). For HFT: partition by symbol using MurmurHash3 — uniform distribution across partitions, no hot keys (AAPL has more ticks than XYZ, but hash distributes evenly). The tradeoff: hot symbols (AAPL, TSLA) generate more data per partition, causing uneven consumer load. Mitigation: use more partitions (100+) to dilute hot-key impact
- **Consumer rebalancing**: sticky vs eager, impact on HFT — when a consumer joins or leaves the group, partitions are reassigned. Eager rebalancing: all consumers stop, partitions are reassigned, consumers restart (downtime: 10-100ms). Sticky rebalancing: minimize partition movement (only move what's necessary). For HFT: rebalancing is dangerous — during rebalance, you're blind to market data. Mitigation: static membership (consumers have persistent IDs, don't rebalance on temporary disconnects). Use Kafka's `group.instance.id` for static membership. For Aeron: no consumer groups — each subscriber is independent, no rebalancing
- **Aeron**: sub-microsecond IPC/UDP, lossless via term buffers — Aeron uses shared-memory ring buffers (IPC) or UDP with retransmission (network). Term buffers are fixed-size (64KB by default) — a message that doesn't fit in a term buffer is fragmented across multiple buffers. Lossless mode: Aeron's reliability layer detects gaps and retransmits, ensuring no message loss. For HFT: Aeron's IPC mode is the fastest inter-process communication available (1-10μs). The tradeoff: Aeron has no persistence (messages are lost if the receiver crashes), no replay (can't re-read old messages), no consumer groups (manual fan-out). Use Aeron for real-time signal propagation between components; use Kafka/Redpanda for persistence and replay
- **Alternatives**: ZeroMQ, NATS, Solarflare ef_vi for kernel bypass — ZeroMQ: lightweight, no broker, multiple patterns (PUB/SUB, REQ/REP, PUSH/PULL), 10-100μs latency, no persistence. NATS: lightweight, at-most-once delivery, 10-100μs latency, simple operations. ef_vi: Solarflare's kernel-bypass API, sub-microsecond latency, requires hardware support (Solarflare NICs), no built-in reliability. For HFT: ef_vi is the lowest-latency option (sub-microsecond) but requires Solarflare/Mellanox NICs and custom driver code. Aeron is the pragmatic choice for most HFT systems (low latency, good reliability, active development). ZeroMQ is useful for legacy systems or quick prototypes

## Usage

AeronSubscriber sub("aeron:ipc", 10001);
sub.onMessage([](const uint8_t* data, size_t len) { ... });

## Source Code

```cpp
#include <cstdint>
#include <functional>
#include <thread>
#include <atomic>

// --------------------------------------------------------------------
// Aeron IPC Subscriber (pseudo — Aeron C++ API is JNI-based)

class AeronSubscriber {
    // Aeron: fixed-size ring buffer, zero-copy, UDP or IPC
    // Media Driver runs as separate process or embedded
    // tradeoff: Aeron (1-10μs) vs Kafka (1-100ms) vs ef_vi (sub-μs)
    std::function<void(const uint8_t*, size_t)> callback_;
    std::atomic<bool> running_{false};
    std::thread poll_thread_;

public:
    AeronSubscriber(const char* channel, int stream_id,
                    std::function<void(const uint8_t*, size_t)> cb)
        : callback_(std::move(cb)) {
        // In production: Aeron::addSubscription(channel, stream_id, callback)
    }

    void start() {
        running_ = true;
        poll_thread_ = std::thread([this]() {
            while (running_) {
                // Aeron::conductor->poll(block=false)
                // tradeoff: busy-poll (0% sleep) vs yield (lower CPU)
            }
        });
    }

    void stop() { running_ = false; if (poll_thread_.joinable()) poll_thread_.join(); }
};

// --------------------------------------------------------------------
// Pipeline Comparison Wrapper

class PipelineSelector {
public:
    // Decision: pick technology based on latency budget
    enum class Budget { SUB_US, US_10, US_100, MS_1, MS_10, MS_100 };
    enum class Tech { AERON, EF_VI, REDPANDA, KAFKA, ZMQ, NATS };

    static Tech recommend(Budget budget) {
        switch (budget) {
            case Budget::SUB_US: return Tech::EF_VI;  // kernel bypass
            case Budget::US_10:  return Tech::AERON;  // userspace TCP/UDP
            case Budget::US_100: return Tech::REDPANDA;
            case Budget::MS_1:   return Tech::KAFKA;
            case Budget::MS_10:  return Tech::NATS;
            case Budget::MS_100: return Tech::ZMQ;
        }
    }
};

// --------------------------------------------------------------------
// Schema Versioning with Avro (simplified)

class SchemaRegistry {
    // tradeoff: Avro (schema evolution) vs FlatBuffers (zero-deserialize)
    // FlatBuffers: 10-50x faster decode, no schema registry needed
    // Avro: rich schema evolution, JSON-friendly
    struct SchemaInfo {
        int id;
        std::string schema;  // Avro JSON schema
        int version;
    };

    std::unordered_map<int, SchemaInfo> schemas_;
    int next_id_{1};

public:
    int registerSchema(const std::string& schema) {
        int id = next_id_++;
        schemas_[id] = {id, schema, 1};
        return id;
    }
};

// --------------------------------------------------------------------
// Partitioning Strategy for Market Data

class MarketDataPartitioner {
    // Key insight: partition by symbol → single consumer sees ordered ticks
    // tradeoff: hot keys (AAPL gets more data) need range or consistent hashing
    static uint32_t partition(const std::string& symbol, uint32_t num_partitions) {
        // MurmurHash3 simple version
        uint32_t h = 0x971e137b;
        for (char c : symbol) {
            h ^= c;
            h *= 0x5bd1e995;
            h ^= h >> 15;
        }
        return h % num_partitions;
    }
};
```
