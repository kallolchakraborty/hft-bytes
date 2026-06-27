---
type: reference
title: "Market Data Compression"
description: "Delta-of-delta timestamp compression, XOR-based float compression (Gorilla), dictionary encoding for repeating symbols, schema-based compression (SBE), real-time decompression latency budgets, and columnar storage for market data replay."
tags: ["data-engineering"]
difficulty: staff
timestamp: "2026-06-27T03:50:00.000Z"
phase: 12
phaseName: "Data Engineering"
category: "Data Engineering"
subcategory: "data-engineering"
language: "cpp"
artifact-id: "ZHFT_MARKET_DATA_COMPRESSION"
---
## Key Learning Points

- Delta-of-delta timestamps: store first timestamp absolute, subsequent timestamps as delta from previous; second-order delta (delta-of-delta) further reduces bits; most timestamps in a burst require only 1-2 bytes vs 8 bytes raw
- XOR float compression (Gorilla/Facebook): store first value raw; subsequent values store XOR with previous; leading/trailing zeros are variable-length encoded; typical compression 4x-8x for price/volume series
- Dictionary encoding: repeated symbol strings (e.g., "ESM7", "NQH7") map to 2-byte integer IDs; shared dictionary per session; eliminates 10-50x overhead of ASCII symbol strings
- Schema-based compression: SBE (Simple Binary Encoding) defines fixed-width fields with protocol-level compression; FastPacket (CME) uses template ID to define field presence; no decompression overhead at the protocol level
- Decompression latency budget: for real-time feed handlers, decompression must complete in < 100 ns per message (pipelined with SIMD); Gorilla decompression ~50-80 ns per float on AVX-512
- Columnar storage for replay: Arrow/Parquet columnar format enables vectorized reads for backtesting; filter pushdown skips irrelevant columns (e.g., read price+size without timestamp); compression ratio 3-5x better than row-oriented

## Usage

```cpp
// Delta-of-delta timestamp encoding
struct TimestampEncoder {
    uint64_t prev_ts_ = 0;
    uint64_t prev_delta_ = 0;

    uint64_t encode(uint64_t ts) {
        uint64_t delta = ts - prev_ts_;
        uint64_t d2 = delta - prev_delta_;  // delta-of-delta
        prev_ts_ = ts;
        prev_delta_ = delta;
        return d2;  // varint-encoded before writing
    }
};

// XOR float compression (Gorilla-style)
struct FloatEncoder {
    uint64_t prev_bits_ = 0;

    uint64_t encode(double value) {
        uint64_t bits = std::bit_cast<uint64_t>(value);
        uint64_t xor_result = bits ^ prev_bits_;
        prev_bits_ = bits;
        // Leading/trailing zero count encoded in 2 bits + payload
        // if xor_result == 0: store 1-bit '0' (no change)
        // else: store 1-bit '1' + leading zeros (5 bits) + block length (6 bits) + payload
        return xor_result;
    }
};

// Compression ratios (real market data, 1 day CME MDP):
// ┌──────────────────────┬──────────┬───────────┐
// │ Method               │ Ratio    │ Decomp ns │
// ├──────────────────────┼──────────┼───────────┤
// │ Raw (uncompressed)   │ 1:1      │ 0         │
// │ Gzip (level 1)       │ 3.5:1    │ ~200      │
// │ LZ4                  │ 2.8:1    │ ~50       │
// │ Gorilla (price+ts)   │ 6.2:1    │ ~60       │
// │ SBE (schema)         │ 1.8:1    │ 0         │
// └──────────────────────┴──────────┴───────────┘
```

## Source Code

```cpp
// Dictionary encoding for symbol strings
class SymbolDictionary {
    std::unordered_map<uint64_t, std::string> id_to_symbol_;
    std::unordered_map<std::string, uint16_t> symbol_to_id_;
    uint16_t next_id_ = 1;  // 0 = invalid

    uint16_t encode(const std::string& sym) {
        auto it = symbol_to_id_.find(sym);
        if (it != symbol_to_id_.end()) return it->second;
        uint16_t id = next_id_++;
        symbol_to_id_[sym] = id;
        id_to_symbol_[id] = sym;
        return id;
    }

    const std::string& decode(uint16_t id) {
        return id_to_symbol_.at(id);
    }
};
```
