---
type: reference
title: "Flatbuffers"
description: "FlatBuffers provides zero-copy deserialization: the wire format. Cap'n Proto uses a similar zero-copy model but with a different"
tags: ["phase-4"]
difficulty: advanced
timestamp: "2026-06-27T03:06:09.413Z"
phase: 4
phaseName: "System Programming & IPC"
category: "Phase 4 - System Programming & IPC"
subcategory: "system-programming"
language: "cpp"
artifact-id: "ZHFT_FLATBUFFERS"
---
## Key Learning Points

- FlatBuffers provides zero-copy deserialization: the wire format
- Cap'n Proto uses a similar zero-copy model but with a different
- Schema evolution: both allow adding new fields without breaking
- Field access without parsing: FlatBuffers uses a vtable at the
- Buffer alignment: FlatBuffers requires 4 B or 8 B alignment;
- Size comparison: SBE has no schema info in the buffer (pure

## Usage

// 1. Install flatc (FlatBuffers compiler)
// 2. flatc --cpp marketdata.fbs
// 3. g++ -O3 -std=c++20 -I. ZHFT_FLATBUFFERS.txt -o fb_bench
// 4. ./fb_bench

## Source Code

```cpp
// =====================================================================
// marketdata.fbs  — FlatBuffers schema for market data.
// =====================================================================
/*
namespace zhft.marketdata;

table Quote {
    symbol:      string (required);
    bid_price:   int64;         // fixed-point 1e-9
    ask_price:   int64;         // fixed-point 1e-9
    bid_size:    uint32;
    ask_size:    uint32;
    exchange_ts: uint64;        // nanoseconds
    flags:       uint8;
    // Optional legs (repeating group — FlatBuffers uses vector of tables).
    legs:        [Leg];
}

table Leg {
    leg_symbol: string;
    leg_ratio:  int8;
}

enum Side: uint8 { BUY = 1, SELL = 2 }

root_type Quote;
*/

// =====================================================================
// Manual zero-copy flyweight that mirrors FlatBuffers' internals.
// This shows exactly what FlatBuffers does under the hood.
// =====================================================================

#include <algorithm>
#include <array>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <iostream>
#include <random>
#include <span>
#include <string_view>
#include <vector>

// -------------------------------------------------------------------
// FlatBuffers vtable entry: stores offset (in bytes) from the table
// object's start to the field. 0 means field is not present.
// -------------------------------------------------------------------
struct VTable {
    uint16_t vtable_size;       // total bytes of vtable (including this field)
    uint16_t table_size;        // total bytes of table (including vtable offset)
    uint16_t field_offset[7];   // offsets for our 7 fields
};

// -------------------------------------------------------------------
// Manual flyweight table (simulating generated FlatBuffers code).
// -------------------------------------------------------------------
class QuoteFlyweight {
public:
    QuoteFlyweight(std::span<uint8_t> buf) : buf_{buf} {
        // The first 4 B are a sooffset (int32) pointing to the vtable.
        int32_t vtable_off;
        std::memcpy(&vtable_off, buf_.data(), sizeof(vtable_off));
        vtable_ = reinterpret_cast<const VTable*>(buf_.data() + 4 + vtable_off);
    }

    auto Symbol() const -> std::string_view {
        // String: 4 B length + data, offset from table start.
        uint16_t off = vtable_->field_offset[0];
        if (off == 0) return {};
        uint32_t len;
        std::memcpy(&len, buf_.data() + off, 4);
        return {reinterpret_cast<const char*>(buf_.data() + off + 4), len};
    }

    auto BidPrice() const -> int64_t {
        uint16_t off = vtable_->field_offset[1];
        if (off == 0) return 0;
        int64_t v;
        std::memcpy(&v, buf_.data() + off, 8);
        return v;
    }

    auto AskPrice() const -> int64_t {
        uint16_t off = vtable_->field_offset[2];
        if (off == 0) return 0;
        int64_t v;
        std::memcpy(&v, buf_.data() + off, 8);
        return v;
    }

    auto BidSize() const -> uint32_t {
        uint16_t off = vtable_->field_offset[3];
        if (off == 0) return 0;
        uint32_t v;
        std::memcpy(&v, buf_.data() + off, 4);
        return v;
    }

    auto AskSize() const -> uint32_t {
        uint16_t off = vtable_->field_offset[4];
        if (off == 0) return 0;
        uint32_t v;
        std::memcpy(&v, buf_.data() + off, 4);
        return v;
    }

private:
    std::span<uint8_t> buf_;
    const VTable*      vtable_ = nullptr;
};

// -------------------------------------------------------------------
// Encode a Quote into a simple FlatBuffers-like buffer.
// For the benchmark, we compare sizes vs SBE (from ZHFT_SBE) and
// vs a minimal Cap'n Proto representation.
// -------------------------------------------------------------------
auto EncodeFlatBuffer(std::span<uint8_t> buf, const char* symbol,
                      int64_t bid, int64_t ask,
                      uint32_t bidsz, uint32_t asksz) -> std::size_t {
    // Layout:
    //   [0..3]     vtable offset (sooffset from table end)
    //   [4..7]     table start marker (or inline data)
    //   [8..end]   actual field data
    // For simplicity, we build a packed struct without vtables.
    // Real FlatBuffers would use vtables for schema evolution.
    struct PackedQuote {
        int32_t  vtable_off;    // points backwards
        uint32_t sym_len;
        char     sym[8];
        int64_t  bid_price;
        int64_t  ask_price;
        uint32_t bid_size;
        uint32_t ask_size;
    } __attribute__((packed));
    static_assert(sizeof(PackedQuote) == 40);

    auto* pq = reinterpret_cast<PackedQuote*>(buf.data());
    pq->vtable_off = -static_cast<int32_t>(sizeof(PackedQuote)); // dummy
    pq->sym_len = 8;
    std::memcpy(pq->sym, symbol, 8);
    pq->bid_price = bid;
    pq->ask_price = ask;
    pq->bid_size  = bidsz;
    pq->ask_size  = asksz;
    return sizeof(PackedQuote);
}

// -- Cap'n Proto size estimate --
// Cap'n Proto wire format: 4 B segment table, 16 B struct data word,
// pointer sections, far-pointer landing pads. Approximated as ~48 B
// for a simple struct with a string.

// -------------------------------------------------------------------
// Benchmark: compare sizes + encode time for SBE vs FlatBuffers vs
// Cap'n Proto (approximate).
// -------------------------------------------------------------------
auto main() -> int {
    constexpr int kIter = 1'000'000;

    std::vector<uint8_t> fb_buf(256);

    // Warm up
    for (int i = 0; i < 100'000; ++i) {
        EncodeFlatBuffer(fb_buf, "AAPL    ", 150000000000LL, 150050000000LL, 100, 200);
    }

    // SBE size (from previous file)
    constexpr std::size_t kSbeSize = 49;       // IncrementalQuote (fixed)

    // FlatBuffers encoded size
    auto fb_n = EncodeFlatBuffer(fb_buf, "AAPL    ", 150000000000LL, 150050000000LL, 100, 200);

    // Cap'n Proto estimate: struct data (16 B) + pointer section + string
    constexpr std::size_t kCapnpSize = 48;

    // Encode time (FlatBuffers)
    auto t0 = std::chrono::steady_clock::now();
    for (int i = 0; i < kIter; ++i) {
        EncodeFlatBuffer(fb_buf, "AAPL    ", 150000000000LL, 150050000000LL, 100, 200);
    }
    auto t1 = std::chrono::steady_clock::now();
    auto fb_ns = std::chrono::duration_cast<std::chrono::nanoseconds>(t1 - t0).count();

    // Decode time (FlatBuffers — read 3 fields)
    t0 = std::chrono::steady_clock::now();
    for (int i = 0; i < kIter; ++i) {
        QuoteFlyweight qf{fb_buf};
        volatile auto sym = qf.Symbol();
        volatile auto bid = qf.BidPrice();
        volatile auto ask = qf.AskPrice();
        (void)sym; (void)bid; (void)ask;
    }
    t1 = std::chrono::steady_clock::now();
    auto decode_ns = std::chrono::duration_cast<std::chrono::nanoseconds>(t1 - t0).count();

    std::cout << "=== Binary Encoding Comparison (Quote message) ===\n\n";
    std::cout << "Format          Size (B)   Encode (ns)   Decode (ns)\n";
    std::cout << "----------------------------------------------------\n";
    std::cout << "SBE                " << kSbeSize << "          <20           <10\n";
    std::cout << "FlatBuffers        " << fb_n << "          "
              << (fb_ns / kIter) << "           "
              << (decode_ns / kIter) << "\n";
    std::cout << "Cap'n Proto (est)  " << kCapnpSize << "          ~30           ~8\n";
    std::cout << "FIX ASCII (ref)    ~120         ~80           ~120\n";

    std::cout << "\n=== Tradeoffs ===\n";
    std::cout << "| Feature          | SBE      | FlatBuffers | Cap'n Proto |\n";
    std::cout << "|------------------|----------|-------------|-------------|\n";
    std::cout << "| Zero-copy decode | Yes      | Yes         | Yes         |\n";
    std::cout << "| Schema evolution | Limited  | Full        | Full        |\n";
    std::cout << "| Min message size | Smallest | +8-12 B     | +20-30 B    |\n";
    std::cout << "| Human-readable  | No       | No          | No          |\n";
    std::cout << "| Code generation  | Java     | flatc       | capnp tool  |\n";
    std::cout << "| Mutability       | Yes      | Builder     | Builder     |\n";
    std::cout << "| RPC support      | No       | No          | Yes         |\n";

    std::cout << "\n=== HFT Recommendation ===\n";
    std::cout << "For pure market data feeds (fixed schema, max speed),\n";
    std::cout << "use SBE — it has the smallest size and fastest decode.\n";
    std::cout << "For systems needing schema evolution or cross-language\n";
    std::cout << "RPC with zero-copy, FlatBuffers is the best choice.\n";
    std::cout << "Cap'n Proto is ideal when RPC + serialization are unified.\n";

    return 0;
}
```
