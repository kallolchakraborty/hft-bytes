---
type: reference
title: "SIMD Intrinsics"
description: "SSE (128-bit), AVX2 (256-bit), and AVX-512 (512-bit) process. SIMD-accelerated string operations (e.g., finding '=' in a FIX"
tags: ["simd"]
difficulty: advanced
timestamp: "2026-06-27T03:06:09.410Z"
phase: 3
phaseName: "C++ Low-Latency Patterns"
category: "C++ Low-Latency Patterns"
subcategory: "cpp-patterns"
language: "cpp"
artifact-id: "ZHFT_SIMD_INTRINSICS"
---
## Key Learning Points

- SSE (128-bit), AVX2 (256-bit), and AVX-512 (512-bit) process
- SIMD-accelerated string operations (e.g., finding '=' in a FIX
- Gather/scatter instructions (AVX2/AVX-512) enable indexed access
- Masked operations (AVX-512) avoid branching by blending results
- Horizontal reductions (hadd, reduce_add) sum across SIMD lanes;

## Usage

// Fast FIX tag finder
size_t pos = simd::findTag(msg, "38", 2);  // find OrderQty tag
// Normalize price array to Z-scores
simd::normalizeAVX512(prices.data(), N, mean, stddev);

## Source Code

```cpp
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <algorithm>
#include <bit>
#include <span>
#include <vector>

// ---------------------------------------------------------------------------
// Platform detection
// ---------------------------------------------------------------------------
#if defined(__AVX512F__) || defined(__AVX2__) || defined(__SSE4_2__)
#include <immintrin.h>
#include <x86intrin.h>
#else
#error "This file requires SSE4.2, AVX2, or AVX-512"
#endif

namespace simd {

// ---------------------------------------------------------------------------
// SSE4.2: Find first occurrence of '=' in a FIX message tag (e.g. "38=100")
// Returns position within buffer, or SIZE_MAX if not found.
// ---------------------------------------------------------------------------
inline size_t findEqualsSSE(const char* buf, size_t len) {
    __m128i eq = _mm_set1_epi8('=');
    size_t i = 0;

    for (; i + 16 <= len; i += 16) {
        __m128i chunk = _mm_loadu_si128(
            reinterpret_cast<const __m128i*>(buf + i));
        __m128i cmp = _mm_cmpeq_epi8(chunk, eq);
        int mask = _mm_movemask_epi8(cmp);
        if (mask != 0)
            return i + static_cast<size_t>(std::countr_zero(
                static_cast<unsigned>(mask)));
    }

    // Remainder
    for (; i < len; ++i)
        if (buf[i] == '=') return i;
    return SIZE_MAX;
}

// ---------------------------------------------------------------------------
// AVX2: Find tag (2-char + '=') using vectorized approach
// Detect pattern: two specified bytes followed by '='
// ---------------------------------------------------------------------------
inline size_t findTagAVX2(const char* buf, size_t len,
                           const char* tag, size_t tag_len) {
    if (tag_len != 2) return SIZE_MAX;  // simplified for 2-char tags

    __m256i byte1 = _mm256_set1_epi8(tag[0]);
    __m256i byte2 = _mm256_set1_epi8(tag[1]);
    __m256i eq    = _mm256_set1_epi8('=');
    size_t i = 0;

    for (; i + 33 < len; ++i) {
        __m256i chunk = _mm256_loadu_si256(
            reinterpret_cast<const __m256i*>(buf + i));
        __m256i cmp1  = _mm256_cmpeq_epi8(chunk, byte1);
        __m256i cmp2  = _mm256_cmpeq_epi8(chunk, byte2);
        __m256i cmpeq = _mm256_cmpeq_epi8(chunk, eq);

        // We need: buf[i] == tag[0] && buf[i+1] == tag[1] && buf[i+2] == '='
        // Shift left for alignment matching
        __m256i cmp_shift = _mm256_alignr_epi8(cmp2, cmp2, 1);
        __m256i eq_shift  = _mm256_alignr_epi8(cmpeq, cmpeq, 2);
        __m256i found = _mm256_and_si256(cmp1,
                          _mm256_and_si256(cmp_shift, eq_shift));

        int mask = _mm256_movemask_epi8(found);
        if (mask != 0)
            return i + static_cast<size_t>(std::countr_zero(
                static_cast<unsigned>(mask)));
    }

    // Scalar remainder
    for (; i + 2 < len; ++i)
        if (buf[i] == tag[0] && buf[i+1] == tag[1] && buf[i+2] == '=')
            return i;
    return SIZE_MAX;
}

// ---------------------------------------------------------------------------
// AVX-512: Normalize a float array to Z-scores
// (x - mean) / stddev, with clamping
// ---------------------------------------------------------------------------
inline void normalizeAVX512(float* data, size_t n,
                             float mean, float stddev) {
    if (n == 0) return;
    float inv_std = 1.0f / (stddev + 1e-20f);
    __m512 v_mean   = _mm512_set1_ps(mean);
    __m512 v_invstd = _mm512_set1_ps(inv_std);
    size_t i = 0;

    for (; i + 16 <= n; i += 16) {
        __m512 v = _mm512_loadu_ps(data + i);
        v = _mm512_sub_ps(v, v_mean);
        v = _mm512_mul_ps(v, v_invstd);
        // Clamp to [-4, 4] to avoid outliers
        v = _mm512_max_ps(_mm512_set1_ps(-4.0f),
            _mm512_min_ps(_mm512_set1_ps(4.0f), v));
        _mm512_storeu_ps(data + i, v);
    }

    // Scalar remainder
    for (; i < n; ++i)
        data[i] = std::max(-4.0f, std::min(4.0f,
                                  (data[i] - mean) * inv_std));
}

// ---------------------------------------------------------------------------
// AVX-512: Normalize double array
// ---------------------------------------------------------------------------
inline void normalizeAVX512(double* data, size_t n,
                             double mean, double stddev) {
    if (n == 0) return;
    double inv_std = 1.0 / (stddev + 1e-20);
    __m512d v_mean   = _mm512_set1_pd(mean);
    __m512d v_invstd = _mm512_set1_pd(inv_std);
    size_t i = 0;

    for (; i + 8 <= n; i += 8) {
        __m512d v = _mm512_loadu_pd(data + i);
        v = _mm512_sub_pd(v, v_mean);
        v = _mm512_mul_pd(v, v_invstd);
        v = _mm512_max_pd(_mm512_set1_pd(-4.0),
            _mm512_min_pd(_mm512_set1_pd(4.0), v));
        _mm512_storeu_pd(data + i, v);
    }

    for (; i < n; ++i)
        data[i] = std::max(-4.0, std::min(4.0,
                                   (data[i] - mean) * inv_std));
}

// ---------------------------------------------------------------------------
// SSE4.2: Sum float array (horizontal reduce)
// ---------------------------------------------------------------------------
inline float sumSSE(const float* data, size_t n) {
    __m128 vsum = _mm_setzero_ps();
    size_t i = 0;

    for (; i + 4 <= n; i += 4) {
        __m128 v = _mm_loadu_ps(data + i);
        vsum = _mm_add_ps(vsum, v);
    }

    // Horizontal add
    vsum = _mm_hadd_ps(vsum, vsum);
    vsum = _mm_hadd_ps(vsum, vsum);
    float result = _mm_cvtss_f32(vsum);

    for (; i < n; ++i)
        result += data[i];
    return result;
}

// ---------------------------------------------------------------------------
// AVX2: Sum float array (256-bit)
// ---------------------------------------------------------------------------
inline float sumAVX2(const float* data, size_t n) {
    __m256 vsum = _mm256_setzero_ps();
    size_t i = 0;

    for (; i + 8 <= n; i += 8) {
        __m256 v = _mm256_loadu_ps(data + i);
        vsum = _mm256_add_ps(vsum, v);
    }

    // Reduce to 128, then hadd
    __m128 hi = _mm256_extractf128_ps(vsum, 1);
    __m128 lo = _mm256_castps256_ps128(vsum);
    __m128 sum128 = _mm_add_ps(lo, hi);
    sum128 = _mm_hadd_ps(sum128, sum128);
    sum128 = _mm_hadd_ps(sum128, sum128);
    float result = _mm_cvtss_f32(sum128);

    for (; i < n; ++i)
        result += data[i];
    return result;
}

// ---------------------------------------------------------------------------
// AVX-512: Sum float array with mask
// ---------------------------------------------------------------------------
inline float sumAVX512(const float* data, size_t n) {
    __m512 vsum = _mm512_setzero_ps();
    size_t i = 0;

    for (; i + 16 <= n; i += 16) {
        __m512 v = _mm512_loadu_ps(data + i);
        vsum = _mm512_add_ps(vsum, v);
    }

    float result = _mm512_reduce_add_ps(vsum);

    for (; i < n; ++i)
        result += data[i];
    return result;
}

// ---------------------------------------------------------------------------
// AVX-512 masked load for tail handling
// ---------------------------------------------------------------------------
inline float sumAVX512Masked(const float* data, size_t n) {
    __m512 vsum = _mm512_setzero_ps();
    size_t i = 0;

    for (; i + 16 <= n; i += 16) {
        __m512 v = _mm512_loadu_ps(data + i);
        vsum = _mm512_add_ps(vsum, v);
    }

    // Masked tail
    size_t remaining = n - i;
    if (remaining > 0) {
        __mmask16 mask = static_cast<__mmask16>(
            (1ULL << remaining) - 1);
        __m512 v = _mm512_maskz_loadu_ps(mask, data + i);
        vsum = _mm512_add_ps(vsum, v);
    }

    return _mm512_reduce_add_ps(vsum);
}

// ---------------------------------------------------------------------------
// AVX2: Gather prices from index array (order book lookups)
// ---------------------------------------------------------------------------
inline void gatherPrices(const double* base, const int* indices,
                          double* out, size_t n) {
    size_t i = 0;
    for (; i + 4 <= n; i += 4) {
        __m128i idx = _mm_loadu_si128(
            reinterpret_cast<const __m128i*>(indices + i));
        __m128d v1 = _mm_i32gather_pd(base, idx, 8);
        // Gather 4 doubles using 128-bit indices — need separate loads
        // for full AVX2 support; simplified here
        _mm_storeu_pd(out + i, v1);
    }
    for (; i < n; ++i)
        out[i] = base[indices[i]];
}

// ---------------------------------------------------------------------------
// FIX message parser using SIMD
// ---------------------------------------------------------------------------
class SIMDFIXParser {
public:
    // Find tag value position in FIX message
    struct TagResult {
        size_t value_start;
        size_t value_len;
    };

    static TagResult findTagValue(const char* msg, size_t msg_len,
                                   const char* tag, size_t tag_len) {
        size_t pos = findTagAVX2(msg, msg_len, tag, tag_len);
        if (pos == SIZE_MAX) return {SIZE_MAX, 0};
        pos += tag_len + 1;  // skip tag + '='

        // Find next SOH (0x01)
        size_t end = pos;
        __m256i soh = _mm256_set1_epi8(0x01);
        for (; end + 32 <= msg_len; end += 32) {
            __m256i chunk = _mm256_loadu_si256(
                reinterpret_cast<const __m256i*>(msg + end));
            int mask = _mm256_movemask_epi8(
                _mm256_cmpeq_epi8(chunk, soh));
            if (mask != 0) {
                end += static_cast<size_t>(std::countr_zero(
                    static_cast<unsigned>(mask)));
                return {pos, end - pos};
            }
        }
        // Scalar tail
        for (; end < msg_len; ++end)
            if (msg[end] == 0x01)
                return {pos, end - pos};
        return {pos, msg_len - pos};
    }
};

// ---------------------------------------------------------------------------
// Benchmark helper
// ---------------------------------------------------------------------------
inline void runBenchmark() {
    constexpr size_t N = 1024;
    alignas(64) float data[N];
    for (size_t i = 0; i < N; ++i)
        data[i] = static_cast<float>(i);

    float sum_sse   = sumSSE(data, N);
    float sum_avx2  = sumAVX2(data, N);
    float sum_avx512 = sumAVX512(data, N);

    // Normalize
    float mean = sum_avx512 / N;
    float var = 0;
    for (size_t i = 0; i < N; ++i)
        var += (data[i] - mean) * (data[i] - mean);
    float stddev = std::sqrt(var / N);
    normalizeAVX512(data, N, mean, stddev);
}

} // namespace simd
```
