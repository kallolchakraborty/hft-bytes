---
type: reference
title: "SBE"
description: "SBE uses an XML schema to define message layouts; the codec. The flyweight pattern overlays a struct on a byte buffer with"
tags: ["phase-4"]
difficulty: advanced
timestamp: "2026-06-27T03:06:09.413Z"
phase: 4
phaseName: "System Programming & IPC"
category: "Phase 4 - System Programming & IPC"
subcategory: "system-programming"
language: "cpp"
artifact-id: "ZHFT_SBE"
---
## Key Learning Points

- SBE uses an XML schema to define message layouts; the codec
- The flyweight pattern overlays a struct on a byte buffer with
- Message framing in SBE: 8-byte header (message type, block
- SBE is typically 3-5x smaller than FIX tag=value (which wastes
- Direct buffer access: SBE headers expose pointers to the
- Compile-time code generation means the schema is frozen at

## Usage

```bash

1. Create message.xml schema file
2. Run: java -jar sbe.jar message.xml > sbe_generated.hpp
3. Compile: g++ -O3 -std=c++20 -I. ZHFT_SBE.txt -o sbe_bench
4. ./sbe_bench
```

## Source Code

```cpp
// =====================================================================
// sbe-schema.xml  — SBE schema for a simplified market data feed.
// =====================================================================
/*
<?xml version="1.0" encoding="UTF-8"?>
<sbe:messageSchema xmlns:sbe="http://fixprotocol.io/2016/sbe"
                   package="zhft.marketdata"
                   id="1001"
                   version="0"
                   semanticVersion="1.0"
                   description="HFT Bytes Market Data SBE Schema"
                   byteOrder="littleEndian">
    <types>
        <composite name="messageHeader" description="SBE standard header">
            <type name="blockLength"    primitiveType="uint16"/>
            <type name="templateId"     primitiveType="uint16"/>
            <type name="schemaId"       primitiveType="uint16"/>
            <type name="version"        primitiveType="uint16"/>
        </composite>
        <composite name="groupSizeEncoding">
            <type name="blockLength"    primitiveType="uint16"/>
            <type name="numInGroup"     primitiveType="uint16"/>
        </composite>
        <composite name="varStringEncoding">
            <type name="length"         primitiveType="uint32"/>
            <type name="varData"        primitiveType="uint8" length="0"/>
        </composite>
        <enum name="Side" encodingType="uint8">
            <validValue name="BUY"> 1</validValue>
            <validValue name="SELL">2</validValue>
        </enum>
    </types>

    <sbe:message name="IncrementalQuote" id="100" description="Equity quote update">
        <field name="symbol"        id="1" type="char" length="8"/>
        <field name="bidPrice"      id="2" type="int64" description="Fixed-point 1e-9"/>
        <field name="askPrice"      id="3" type="int64" description="Fixed-point 1e-9"/>
        <field name="bidSize"       id="4" type="uint32"/>
        <field name="askSize"       id="5" type="uint32"/>
        <field name="exchangeTS"    id="6" type="uint64" description="Nanoseconds since epoch"/>
        <field name="flags"         id="7" type="uint8"/>
        <group name="optionalLegs" id="8" dimensionType="groupSizeEncoding">
            <field name="legSymbol" id="9" type="char" length="4"/>
            <field name="legRatio" id="10" type="int8"/>
        </group>
        <field name="tradeCondition" id="11" type="varStringEncoding"/>
    </sbe:message>
</sbe:schema>
*/

// =====================================================================
// sbe_bench.cpp  — Manual flyweight SBE codec + benchmark vs FIX ASCII.
// =====================================================================

#include <algorithm>
#include <array>
#include <bit>
#include <chrono>
#include <charconv>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <iostream>
#include <random>
#include <span>
#include <string_view>
#include <vector>

// -------------------------------------------------------------------
// Minimal SBE header (8 bytes, little-endian).
// -------------------------------------------------------------------
struct SbeHeader {
    uint16_t blockLength;
    uint16_t templateId;
    uint16_t schemaId;
    uint16_t version;
} __attribute__((packed));

static_assert(sizeof(SbeHeader) == 8);

// -------------------------------------------------------------------
// Flyweight message — overlays on raw buffer, zero deserialization.
// In production, the SBE code generator emits these automatically
// from the XML schema.
// -------------------------------------------------------------------
class IncrementalQuoteFlyweight {
public:
    // Overlay on a buffer at the given offset.
    IncrementalQuoteFlyweight(std::span<uint8_t> buf, std::size_t offset = 0)
        : buf_{buf}, offset_{offset} {}

    // --- Header access (8 bytes before payload) ---
    auto header() -> SbeHeader& {
        return *reinterpret_cast<SbeHeader*>(buf_.data() + offset_);
    }
    auto header() const -> const SbeHeader& {
        return *reinterpret_cast<const SbeHeader*>(buf_.data() + offset_);
    }

    // --- Fixed fields at known compile-time offsets ---
    static constexpr std::size_t kSymbolOffset     = 8;      // 8 B
    static constexpr std::size_t kBidPriceOffset   = 16;     // 8 B
    static constexpr std::size_t kAskPriceOffset   = 24;     // 8 B
    static constexpr std::size_t kBidSizeOffset    = 32;     // 4 B
    static constexpr std::size_t kAskSizeOffset    = 36;     // 4 B
    static constexpr std::size_t kExchangeTSOffset = 40;     // 8 B
    static constexpr std::size_t kFlagsOffset      = 48;     // 1 B
    static constexpr std::size_t kFixedEnd         = 49;     // total fixed

    static constexpr std::size_t kBlockLength      = kFixedEnd - 8; // 41

    void SetSymbol(const char* sym) {
        std::memcpy(buf_.data() + offset_ + kSymbolOffset, sym, 8);
    }
    auto Symbol() const -> std::string_view {
        return {reinterpret_cast<const char*>(buf_.data() + offset_ + kSymbolOffset), 8};
    }

    void SetBidPrice(int64_t p) {
        std::memcpy(buf_.data() + offset_ + kBidPriceOffset, &p, 8);
    }
    auto BidPrice() const -> int64_t {
        int64_t v;
        std::memcpy(&v, buf_.data() + offset_ + kBidPriceOffset, 8);
        return v;
    }

    // ... (same pattern for all fixed fields)

    // --- Groups: requires counting entries and iterating ---
    // (omitted for brevity — same flyweight pattern with inner offsets)

private:
    std::span<uint8_t> buf_;
    std::size_t        offset_;
};

// -------------------------------------------------------------------
// Manual SBE encoder (no codegen, for demonstration).
// -------------------------------------------------------------------
auto EncodeSBE(std::span<uint8_t> buf, const char* symbol,
               int64_t bid, int64_t ask, uint32_t bidsz, uint32_t asksz,
               uint64_t ts, uint8_t flags) -> std::size_t {
    IncrementalQuoteFlyweight msg{buf, 0};
    msg.header().blockLength = IncrementalQuoteFlyweight::kBlockLength;
    msg.header().templateId  = 100;
    msg.header().schemaId    = 1001;
    msg.header().version     = 0;
    msg.SetSymbol(symbol);
    msg.SetBidPrice(bid);
    // ... (all fixed fields)
    return IncrementalQuoteFlyweight::kFixedEnd;
}

// -------------------------------------------------------------------
// Manual FIX encoder (tag=value) for size comparison.
// -------------------------------------------------------------------
auto EncodeFIX(std::span<char> buf, const char* symbol,
               int64_t bid, int64_t ask, uint32_t bidsz, uint32_t asksz) -> std::size_t {
    // FIX tag=value: 35=D (quote), 55=symbol, 132=bid px, 133=offer px, ...
    auto ptr = buf.data();
    auto end = buf.data() + buf.size();
    // In real code, use snprintf / charconv for each tag.
    ptr += std::snprintf(ptr, end - ptr,
                         "35=d|55=%-8s|132=%.2f|133=%.2f|134=%u|135=%u|",
                         symbol,
                         static_cast<double>(bid) / 1e9,
                         static_cast<double>(ask) / 1e9,
                         bidsz, asksz);
    return static_cast<std::size_t>(ptr - buf.data());
}

// -------------------------------------------------------------------
// Benchmark: encode 1M quotes in SBE and FIX, compare sizes + time.
// -------------------------------------------------------------------
auto main() -> int {
    constexpr int kIter = 1'000'000;

    std::vector<uint8_t> sbe_buf(256);
    std::vector<char>    fix_buf(512);

    // Warm up.
    for (int i = 0; i < 100'000; ++i) {
        EncodeSBE(sbe_buf, "AAPL    ", 150000000000LL, 150050000000LL,
                  100, 200, 1234567890ULL, 0);
        EncodeFIX(fix_buf, "AAPL    ", 150000000000LL, 150050000000LL, 100, 200);
    }

    // Measure SBE encode.
    auto t0 = std::chrono::steady_clock::now();
    std::size_t sbe_total_bytes = 0;
    for (int i = 0; i < kIter; ++i) {
        auto n = EncodeSBE(sbe_buf, "AAPL    ", 150000000000LL, 150050000000LL,
                           100, 200, 1234567890ULL, 0);
        sbe_total_bytes += n;
    }
    auto t1 = std::chrono::steady_clock::now();

    // Measure FIX encode.
    auto t2 = std::chrono::steady_clock::now();
    std::size_t fix_total_bytes = 0;
    for (int i = 0; i < kIter; ++i) {
        auto n = EncodeFIX(fix_buf, "AAPL    ", 150000000000LL, 150050000000LL,
                           100, 200);
        fix_total_bytes += n;
    }
    auto t3 = std::chrono::steady_clock::now();

    auto sbe_ns = std::chrono::duration_cast<std::chrono::nanoseconds>(t1 - t0).count();
    auto fix_ns = std::chrono::duration_cast<std::chrono::nanoseconds>(t3 - t2).count();

    std::cout << "=== SBE vs FIX Comparison (kIter=" << kIter << ") ===\n\n";
    std::cout << "Metric                     SBE          FIX       FIX/SBE\n";
    std::cout << "---------------------------------------------------------\n";
    std::cout << "Avg message size (B)       "
              << (sbe_total_bytes / kIter) << "          "
              << (fix_total_bytes / kIter) << "         "
              << static_cast<double>(fix_total_bytes) / static_cast<double>(sbe_total_bytes)
              << "x\n";
    std::cout << "Total encode time (ms)     "
              << (sbe_ns / 1'000'000) << "          "
              << (fix_ns / 1'000'000)
              << "\n";
    std::cout << "Encode / msg (ns)          "
              << (sbe_ns / kIter) << "          "
              << (fix_ns / kIter)
              << "\n";

    // Decode benchmark (SBE read 3 fields, FIX parse 5 tags).
    t0 = std::chrono::steady_clock::now();
    for (int i = 0; i < kIter; ++i) {
        IncrementalQuoteFlyweight fw{sbe_buf};
        volatile auto sym  = fw.Symbol();
        volatile auto bid  = fw.BidPrice();
        (void)sym; (void)bid;
    }
    t1 = std::chrono::steady_clock::now();
    auto decode_ns = std::chrono::duration_cast<std::chrono::nanoseconds>(t1 - t0).count();
    std::cout << "SBE decode 3 fields (ns)   "
              << (decode_ns / kIter) << "\n";

    std::cout << "\n=== Key Takeaways ===\n";
    std::cout << "1. SBE is ~" << (fix_total_bytes / sbe_total_bytes)
              << "x smaller than equivalent FIX\n";
    std::cout << "2. SBE encode is faster because no sprintf/string formatting\n";
    std::cout << "3. SBE decode is ~zero: just a pointer dereference\n";
    std::cout << "4. FIX advantage: human-readable, self-describing\n";
    std::cout << "5. SBE schema evolution requires append-only fields\n";

    return 0;
}
```
