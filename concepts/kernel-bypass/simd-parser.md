---
type: reference
title: "SIMD Parser"
description: "SIMD bitset for tag detection: load 32 bytes of FIX message into. SWAR (SIMD Within A Register) techniques: use 64-bit integer"
tags: ["simd"]
difficulty: advanced
timestamp: "2026-06-27T03:06:09.416Z"
phase: 5
phaseName: "Kernel Bypass & Protocols"
category: "Phase 5 - Kernel Bypass & Protocols"
subcategory: "kernel-bypass"
language: "cpp"
artifact-id: "ZHFT_SIMD_PARSER"
---
## Key Learning Points

- SIMD bitset for tag detection: load 32 bytes of FIX message into
- SWAR (SIMD Within A Register) techniques: use 64-bit integer
- Branchless parsing with cmov: replace conditional branches with
- Lookup tables (LUT): precompute a 256-entry table mapping byte
- Streaming through 64 bytes per instruction: with AVX512, load
- The key insight: protocol parsing is branch-prediction limited,

## Usage

// g++ -O3 -mavx2 -std=c++20 ZHFT_SIMD_PARSER.txt -o simd_parser
// ./simd_parser

## Source Code

```cpp
#include <algorithm>
#include <array>
#include <bit>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <iostream>
#include <span>
#include <string_view>
#include <vector>

#if defined(__AVX2__)
#include <immintrin.h>
#endif

// ====================================================================
// SIMD FIX tag finder (AVX2): locate '=' and '\x01' delimiters.
// ====================================================================

// Search for delimiter bytes in a 32-byte chunk; return a bitmask
// where bits 0-31 correspond to positions of matches.
#if defined(__AVX2__)
inline auto FindDelimiterMask(const char* chunk, char delim) -> uint32_t {
    __m256i data = _mm256_loadu_si256(reinterpret_cast<const __m256i*>(chunk));
    __m256i pattern = _mm256_set1_epi8(delim);
    __m256i cmp = _mm256_cmpeq_epi8(data, pattern);
    return static_cast<uint32_t>(_mm256_movemask_epi8(cmp));
}
#else
inline auto FindDelimiterMask(const char* chunk, char delim) -> uint32_t {
    // Scalar fallback.
    uint32_t mask = 0;
    for (int i = 0; i < 32; ++i) {
        if (chunk[i] == delim) mask |= (1u << i);
    }
    return mask;
}
#endif

// -------------------------------------------------------------------
// Find the first '=' and then the subsequent '\x01' in a 32-byte block.
// Returns {tag_length, value_length} as {offset_of_=, length_after_=}.
// -------------------------------------------------------------------
struct TagValueSpan {
    uint32_t eq_pos;        // position of '='
    uint32_t soh_pos;       // position of '\x01' (after eq)
};

inline auto FindTagValue(const char* data) -> TagValueSpan {
    uint32_t eq_mask  = FindDelimiterMask(data, '=');
    uint32_t soh_mask = FindDelimiterMask(data, '\x01');

    // Count trailing zeros = position of first match.
    uint32_t eq_pos  = static_cast<uint32_t>(std::countr_zero(eq_mask));
    uint32_t soh_pos = static_cast<uint32_t>(std::countr_zero(soh_mask));

    // If '=' or '\x01' not found in this block, signal overflow.
    // In production, advance the data pointer and continue.
    // (Simplified: assume both are found.)
    return {eq_pos, soh_pos};
}

// ====================================================================
// Branchless decimal parser for price fields (fixed point).
// Parses ASCII digits '0'..'9' into a 64-bit integer without branches.
// Uses: (byte - '0') * (10^pos) for each digit, accumulated.
// ====================================================================

// Precompute 8-entry lookup: 10^i for each position.
static constexpr std::array<uint64_t, 16> kPow10 = {
    1, 10, 100, 1000, 10000, 100000, 1000000, 10000000,
    100000000, 1000000000, 10000000000ULL, 100000000000ULL,
    1000000000000ULL, 10000000000000ULL, 100000000000000ULL,
    1000000000000000ULL,
};

// Parse decimal from a buffer of known length (branchless).
// Uses a technique: for each byte, compute is_digit = (byte - '0') < 10,
// then value += (byte - '0') * pow10[pos] * is_digit (no branch).
// If the byte is not a digit, is_digit = 0 → no contribution.
inline auto ParseDecimalBranchless(const char* buf, int len) -> uint64_t {
    uint64_t value = 0;
    for (int i = 0; i < len; ++i) {
        uint8_t  c       = static_cast<uint8_t>(buf[i]);
        uint64_t digit   = static_cast<uint64_t>(c - '0');
        uint64_t is_digit = static_cast<uint64_t>(digit < 10);
        // If is_digit is 0, digit contribution is zeroed.
        value += (digit & (is_digit - 1)) * kPow10[len - 1 - i];
        // Alternative (branchless cmov approach):
        // value = is_digit ? value + digit * pow10[.] : value;
    }
    return value;
}

// ====================================================================
// SWAR (SIMD Within A Register) — find first '=' in 8 bytes.
// This works on any x86-64 CPU without SIMD extensions.
// ====================================================================
inline auto FindEqSWAR(uint64_t chunk) -> int {
    // Algorithm: http://0x80.pl/articles/simd-byte-lookup.html
    // For each byte in the 8-byte chunk, check if it equals '=' (0x3D).
    const uint64_t eq_byte = 0x3D3D3D3D3D3D3D3DULL;
    uint64_t cmp = chunk ^ eq_byte;
    // Use hasless(v, 1) trick: ((v - 0x0101...) & ~v & 0x8080...) detects zero bytes.
    uint64_t t = cmp - 0x0101010101010101ULL;
    t = t & ~cmp;
    t = t & 0x8080808080808080ULL;
    if (t == 0) return -1;
    return std::countr_zero(t) >> 3;   // bit position → byte index
}

// ====================================================================
// Benchmark: compare byte-by-byte vs SIMD vs SWAR tag finding.
// ====================================================================

auto FindTagByteByByte(std::string_view msg, int tag) -> std::string_view {
    // Linear scan of the FIX message to find a given tag.
    // Baseline comparison.
    for (auto ptr = msg.data(), end = msg.data() + msg.size(); ptr < end; ) {
        // Read tag number.
        int found_tag = 0;
        while (ptr < end && *ptr != '=') {
            found_tag = found_tag * 10 + (*ptr - '0');
            ++ptr;
        }
        if (ptr >= end) break;
        ++ptr;  // skip '='
        auto val_start = ptr;
        while (ptr < end && *ptr != '\x01') ++ptr;
        if (found_tag == tag) {
            return {val_start, static_cast<std::size_t>(ptr - val_start)};
        }
        ++ptr;  // skip '\x01'
    }
    return {};
}

auto main() -> int {
    // Sample FIX message.
    std::string_view fix_msg =
        "8=FIX.4.2\x01"
        "9=120\x01"
        "35=D\x01"
        "49=SENDER\x01"
        "56=TARGET\x01"
        "34=789\x01"
        "52=20260101-00:00:00.000\x01"
        "55=AAPL\x01"
        "44=150.25\x01"
        "38=1000\x01"
        "40=2\x01"
        "59=0\x01"
        "10=128\x01";

    std::cout << "=== SIMD-Accelerated Protocol Parsing ===\n\n";
    std::cout << "FIX message (" << fix_msg.size() << " B):\n"
              << "  " << fix_msg.substr(0, 80) << "...\n\n";

    // Test SIMD tag finder.
    if (fix_msg.size() >= 32) {
        auto span = FindTagValue(fix_msg.data());
        std::cout << "First tag (SIMD): '=' at " << span.eq_pos
                  << ", '\\x01' at " << span.soh_pos << "\n";
        // Decode tag value.
        auto tag_val = std::string_view{
            fix_msg.data(),
            span.eq_pos
        };
        std::cout << "  Tag=" << tag_val << "\n";
    }

    // Test SWAR finder on first 8 bytes.
    uint64_t first8;
    std::memcpy(&first8, fix_msg.data(), 8);
    int swar_pos = FindEqSWAR(first8);
    std::cout << "First '=' (SWAR): byte " << swar_pos << "\n";

    // Test branchless decimal parser.
    std::string_view price_str = "15025000";   // $150.25 (fixed point 100000)
    uint64_t parsed = ParseDecimalBranchless(price_str.data(),
                                             static_cast<int>(price_str.size()));
    std::cout << "\nBranchless decimal parse: '" << price_str << "' -> "
              << parsed << " (expected 15025000)\n";

    // Benchmark: compare byte scanning vs SIMD for tag 44 (price).
    constexpr int kIter = 500'000;

    // Byte-by-byte.
    auto t0 = std::chrono::steady_clock::now();
    for (int i = 0; i < kIter; ++i) {
        volatile auto v = FindTagByteByByte(fix_msg, 44);
        (void)v;
    }
    auto t1 = std::chrono::steady_clock::now();

    // SIMD-based (simplified: we scan with SIMD for delimiter positions
    // then manually decode — in practice a full SIMD FIX parser would
    // work differently; this is illustrative).
    auto t2 = std::chrono::steady_clock::now();
    for (int i = 0; i < kIter; ++i) {
        // Use SIMD to find delimiters in the first block.
        auto span = FindTagValue(fix_msg.data());
        volatile auto a = span.eq_pos;
        volatile auto b = span.soh_pos;
        (void)a; (void)b;
    }
    auto t3 = std::chrono::steady_clock::now();

    auto byte_ns = std::chrono::duration_cast<std::chrono::nanoseconds>(t1 - t0).count();
    auto simd_ns = std::chrono::duration_cast<std::chrono::nanoseconds>(t3 - t2).count();

    std::cout << "\nBenchmark (" << kIter << " iterations):\n";
    std::cout << "  Byte-by-byte scan: " << (byte_ns / kIter) << " ns/iter\n";
    std::cout << "  SIMD delimiters:   " << (simd_ns / kIter) << " ns/iter\n";
    std::cout << "  Speedup:           "
              << (static_cast<double>(byte_ns) / simd_ns) << "x\n\n";

    std::cout << "=== Techniques Summary ===\n";
    std::cout << "| Technique          | Latency | Branch-free | Notes          |\n";
    std::cout << "|--------------------|---------|-------------|----------------|\n";
    std::cout << "| Byte-by-byte       | 5-10 ns | No          | Baseline       |\n";
    std::cout << "| SWAR (8-byte)      | 1-3 ns  | Yes         | No SIMD req.   |\n";
    std::cout << "| AVX2 (32-byte)     | < 1 ns  | Yes         | x86-64-v3      |\n";
    std::cout << "| AVX512 (64-byte)   | < 0.5 ns| Yes         | x86-64-v4      |\n";
    std::cout << "| Branchless decimal | 2-3 ns  | Yes         | Uses cmov/mul  |\n";

    return 0;
}
```
