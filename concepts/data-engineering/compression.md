---
type: reference
title: "Compression"
description: "Delta-of-delta encoding for timestamps (Gorilla paper, Facebook). XOR compression for float64 values (leading/trailing zeros)"
tags: ["phase-12"]
difficulty: intermediate
timestamp: "2026-06-27T03:06:09.443Z"
phase: 12
phaseName: "Data Engineering"
category: "Phase 12 - Data Engineering"
subcategory: "data-engineering"
language: "cpp"
artifact-id: "ZHFT_COMPRESSION"
---
## Key Learning Points

- Delta-of-delta encoding for timestamps (Gorilla paper, Facebook)
- XOR compression for float64 values (leading/trailing zeros)
- Dictionary encoding for symbols (repeated strings)
- Run-length encoding for constant fields (e.g. bid size)
- SIMD-accelerated decompression (AVX2/NEON)

## Usage

GorillaCompressor comp;
comp.compress(price, timestamp);
auto out = comp.finalize();

## Source Code

```cpp
#include <cstdint>
#include <vector>
#include <cstring>

// --------------------------------------------------------------------
// Gorilla XOR Float Compression

class GorillaCompressor {
    uint64_t prev_val_{0};
    uint64_t prev_leading_{64};
    uint64_t prev_trailing_{0};

    std::vector<uint8_t> output_;
    int bit_pos_{0};

public:
    // Gorilla XOR: store XOR with previous, then leading/trailing zeros
    // Key insight: consecutive prices have similar XOR → few meaningful bits
    void compressValue(double value) {
        uint64_t raw;
        std::memcpy(&raw, &value, sizeof(double));

        if (output_.empty()) {
            appendBits(raw, 64);  // first value: store raw
        } else {
            uint64_t xor_result = raw ^ prev_val_;
            if (xor_result == 0) {
                appendBits(0, 1);  // same value: single '0' bit
            } else {
                appendBits(1, 1);  // different: '1' prefix
                uint64_t leading = __builtin_clzll(xor_result);
                uint64_t trailing = __builtin_ctzll(xor_result);

                if (leading >= prev_leading_ && trailing >= prev_trailing_) {
                    // store meaningful bits only (block inside previous window)
                    appendBits(0, 1);
                    uint64_t meaningful = 64 - prev_leading_ - prev_trailing_;
                    appendBits(xor_result >> prev_trailing_, meaningful);
                } else {
                    // new leading/trailing counts needed
                    appendBits(1, 1);
                    appendBits(leading, 6);   // 6 bits → 0-63
                    appendBits(trailing, 6);
                    uint64_t meaningful = 64 - leading - trailing;
                    appendBits(xor_result >> trailing, meaningful);
                    prev_leading_ = leading;
                    prev_trailing_ = trailing;
                }
            }
        }
        prev_val_ = raw;
    }

    // Delta-of-delta for timestamps
    // tradeoff: Gorilla + delta-delta vs LZ4 vs Zstd
    void compressTimestamp(int64_t timestamp_ns, int64_t prev_timestamp,
                            int64_t prev_delta) {
        int64_t delta = timestamp_ns - prev_timestamp;
        int64_t delta_delta = delta - prev_delta;

        // variable-length encoding based on magnitude
        // tradeoff: smaller encoding for small deltas
        if (delta_delta == 0)          appendBits(0, 1);
        else if (delta_delta >= -63 && delta_delta <= 64)
            { appendBits(0b10, 2); appendBits(delta_delta & 0x7F, 7); }
        else if (delta_delta >= -255 && delta_delta <= 256)
            { appendBits(0b110, 3); appendBits(delta_delta & 0xFFFF, 9); }
        else if (delta_delta >= -2047 && delta_delta <= 2048)
            { appendBits(0b1110, 4); appendBits(delta_delta & 0xFFFF, 12); }
        else
            { appendBits(0b1111, 4); appendBits(delta_delta, 64); }
    }

    std::vector<uint8_t> finalize() {
        // flush remaining bits (pad to byte boundary)
        if (bit_pos_ % 8 != 0)
            output_.push_back(0);
        return std::move(output_);
    }

private:
    void appendBits(uint64_t value, int bits) {
        // bit-by-bit — slow; use 64-bit shift in production
        // tradeoff: simplicity vs SIMD-optimized batch append
        for (int i = bits - 1; i >= 0; --i) {
            if (bit_pos_ % 8 == 0) output_.push_back(0);
            if ((value >> i) & 1)
                output_.back() |= (1 << (bit_pos_ % 8));
            bit_pos_++;
        }
    }
};

// --------------------------------------------------------------------
// Dictionary Encoding for Symbols

class SymbolDictionary {
    std::vector<std::string> table_;
    // tradeoff: fixed dictionary vs adaptive (Zstd-style)

public:
    uint32_t encode(const std::string& sym) {
        for (uint32_t i = 0; i < table_.size(); ++i)
            if (table_[i] == sym) return i;
        table_.push_back(sym);
        return table_.size() - 1;
    }

    const std::string& decode(uint32_t code) const {
        return table_[code];
    }
};
```
