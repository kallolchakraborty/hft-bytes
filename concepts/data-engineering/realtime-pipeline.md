---
type: reference
title: "Realtime Pipeline"
description: "Kafka vs Redpanda vs Aeron: latency/throughput/consistency tradeoffs. Exactly-once semantics: idempotent producer + transactional"
tags: ["data-engineering", "deployment", "ipc", "time-series"]
timestamp: "2026-06-27T03:06:09.444Z"
phase: 12
phaseName: "Data Engineering"
category: "Phase 12 - Data Engineering"
subcategory: "data-engineering"
language: "cpp"
artifact-id: "ZHFT_REALTIME_PIPELINE"
---
## Key Learning Points

- Kafka vs Redpanda vs Aeron: latency/throughput/consistency tradeoffs
- Exactly-once semantics: idempotent producer + transactional
- Schema registry: Avro/Protobuf for forward/backward compat
- Partitioning by symbol for ordering guarantees
- Consumer rebalancing: sticky vs eager, impact on HFT
- Aeron: sub-microsecond IPC/UDP, lossless via term buffers
- Alternatives: ZeroMQ, NATS, Solarflare ef_vi for kernel bypass

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
