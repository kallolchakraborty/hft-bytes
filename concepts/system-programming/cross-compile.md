---
type: reference
title: "Cross Compile"
description: "x86-64 microarchitecture levels (x86-64-v1 through v4) define. -march=native is dangerous across machines: a binary built on"
tags: ["phase-4"]
timestamp: "2026-06-27T03:06:09.412Z"
phase: 4
phaseName: "System Programming & IPC"
category: "Phase 4 - System Programming & IPC"
subcategory: "system-programming"
language: "cpp"
artifact-id: "ZHFT_CROSS_COMPILE"
---
## Key Learning Points

- x86-64 microarchitecture levels (x86-64-v1 through v4) define
- -march=native is dangerous across machines: a binary built on
- CPU feature detection at runtime uses cpuid (x86) or getauxval
- Function multi-versioning (GCC IFUNC / clang multiversion)
- For cross-compilation: use a sysroot (e.g., via crosstool-NG

## Usage

// g++ -O3 -std=c++20 -march=x86-64-v2 ZHFT_CROSS_COMPILE.txt -o dispatch
// ./dispatch

## Source Code

```cpp
#include <array>
#include <bit>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <iostream>
#include <string_view>

#if defined(__linux__) && defined(__x86_64__)
#include <cpuid.h>
#include <elf.h>
#include <sys/auxv.h>
#endif

// -------------------------------------------------------------------
// x86-64 CPU feature set (subset relevant to HFT).
// -------------------------------------------------------------------
struct CpuFeatures {
    bool sse4_2    : 1;
    bool popcnt    : 1;
    bool avx       : 1;
    bool avx2      : 1;
    bool bmi1      : 1;
    bool bmi2      : 1;
    bool avx512f   : 1;
    bool avx512bw  : 1;
    bool avx512dq  : 1;
    bool avx512vl  : 1;
    bool clflushopt: 1;
    bool rdtscp    : 1;
    bool invariant_tsc : 1;
    bool xsave     : 1;
    bool xsavec    : 1;
    bool xgetbv    : 1;

    // Human-readable summary.
    auto ToString() const -> std::string {
        std::string s;
        auto add = [&](const char* name, bool val) {
            if (val) { if (!s.empty()) s += ", "; s += name; }
        };
        add("SSE4.2", sse4_2); add("POPCNT", popcnt);
        add("AVX", avx); add("AVX2", avx2);
        add("BMI1", bmi1); add("BMI2", bmi2);
        add("AVX512F", avx512f); add("AVX512BW", avx512bw);
        add("AVX512DQ", avx512dq); add("AVX512VL", avx512vl);
        add("CLFLUSHOPT", clflushopt); add("RDTSCP", rdtscp);
        add("INVARIANT_TSC", invariant_tsc);
        return s;
    }

    // Determine microarchitecture level.
    auto MicroarchLevel() const -> int {
        if (avx512f)  return 4;    // v4 = AVX512F + AVX512BW/DQ/VL
        if (avx2)     return 3;    // v3 = AVX + AVX2 + BMI
        if (sse4_2)   return 2;    // v2 = SSE4.2 + POPCNT
        return 1;                   // v1 = baseline x86-64
    }
};

// -------------------------------------------------------------------
// Singleton CPU feature detector — call once, cache forever.
// -------------------------------------------------------------------
class CpuInfo {
public:
    static auto Instance() -> const CpuInfo& {
        static CpuInfo instance;
        return instance;
    }

    auto Features() const -> const CpuFeatures& { return features_; }
    auto Level() const -> int { return features_.MicroarchLevel(); }

private:
    CpuInfo() { Detect(); }

    void Detect() {
#if defined(__x86_64__)
        uint32_t eax, ebx, ecx, edx;

        // Maximum standard leaf.
        if (__get_cpuid(0, &eax, &ebx, &ecx, &edx) == 0) return;

        // Leaf 1: feature bits.
        if (__get_cpuid(1, &eax, &ebx, &ecx, &edx) != 0) {
            features_.sse4_2 = (ecx >> 20) & 1;
            features_.popcnt = (ecx >> 23) & 1;
            features_.xsave  = (ecx >> 26) & 1;
            features_.rdtscp = (ecx >> 27) & 1;
            features_.xgetbv = ((ecx >> 26) & 1) && ((ecx >> 27) & 1);
        }

        // Leaf 7 (subleaf 0): extended features (AVX2, BMI, AVX512).
        if (__get_cpuid_count(7, 0, &eax, &ebx, &ecx, &edx) != 0) {
            features_.bmi1    = (ebx >> 3) & 1;
            features_.avx2    = (ebx >> 5) & 1;
            features_.bmi2    = (ebx >> 8) & 1;
            features_.avx512f = (ebx >> 16) & 1;
            features_.avx512dq = (ebx >> 17) & 1;
            features_.avx512bw = (ebx >> 30) & 1;
            features_.avx512vl = (ebx >> 31) & 1;
            features_.avx     = features_.avx2;   // AVX implied by AVX2
            features_.clflushopt = (ebx >> 23) & 1;
        }

        // Check OS XSAVE support (AVX require OS context save).
        if (features_.xgetbv) {
            uint64_t xcr0;
            asm volatile("xgetbv" : "=a"(eax), "=d"(edx) : "c"(0));
            xcr0 = (static_cast<uint64_t>(edx) << 32) | eax;
            features_.avx  = features_.avx  && ((xcr0 >> 1) & 1);   // YMM
            features_.avx2 = features_.avx2 && ((xcr0 >> 1) & 1);
            features_.avx512f = features_.avx512f && ((xcr0 >> 5) & 1); // OPMASK/ZMM
        }

        // Check invariant TSC via /proc/cpuinfo or auxv.
        // On Linux, getauxval(AT_HWCAP) includes this on modern kernels.
#if defined(__linux__)
        unsigned long hwcaps = getauxval(AT_HWCAP);
        (void)hwcaps;
#endif
        // The invariant TSC flag is usually in leaf 0x80000007.
        if (__get_cpuid(0x80000007, &eax, &ebx, &ecx, &edx) != 0) {
            features_.invariant_tsc = (edx >> 8) & 1;
        }
#endif
    }

    CpuFeatures features_ = {};
};

// -------------------------------------------------------------------
// SIMD routine dispatch layer using IFUNC (GCC).
// This lets the linker pick the best implementation at load time.
// -------------------------------------------------------------------

// Scalar fallback: sum array of int64 (simple example).
auto SumScalar(const int64_t* data, std::size_t n) -> int64_t {
    int64_t sum = 0;
    for (std::size_t i = 0; i < n; ++i) sum += data[i];
    return sum;
}

// AVX2 vectorised sum.
#if defined(__AVX2__)
#include <immintrin.h>
auto SumAVX2(const int64_t* data, std::size_t n) -> int64_t {
    __m256i sum_vec = _mm256_setzero_si256();
    std::size_t i = 0;
    for (; i + 4 <= n; i += 4) {
        __m256i v = _mm256_loadu_si256(reinterpret_cast<const __m256i*>(data + i));
        sum_vec = _mm256_add_epi64(sum_vec, v);
    }
    int64_t sum = 0;
    alignas(32) int64_t tmp[4];
    _mm256_store_si256(reinterpret_cast<__m256i*>(tmp), sum_vec);
    for (int j = 0; j < 4; ++j) sum += tmp[j];
    for (; i < n; ++i) sum += data[i];
    return sum;
}
#endif

// -------------------------------------------------------------------
// IFUNC resolver: called once at program load time.
// Returns pointer to the best implementation for this CPU.
// -------------------------------------------------------------------
#if defined(__GNUC__) && !defined(__clang__) && defined(__AVX2__)
static auto ResolveSum() -> decltype(&SumScalar) {
    const auto& f = CpuInfo::Instance().Features();
    if (f.avx2) return SumAVX2;
    return SumScalar;
}

// The IFUNC attribute tells the linker to call ResolveSum() at load time.
auto SumDispatch(const int64_t* data, std::size_t n) -> int64_t
    __attribute__((ifunc("ResolveSum")));
#else
// Clang or non-IFUNC: just use scalar (or manual dispatch).
auto SumDispatch(const int64_t* data, std::size_t n) -> int64_t {
    const auto& f = CpuInfo::Instance().Features();
#if defined(__AVX2__)
    if (f.avx2) return SumAVX2(data, n);
#endif
    return SumScalar(data, n);
}
#endif

// -------------------------------------------------------------------
// Manual runtime dispatch (alternative to IFUNC) — for compilers
// that don't support IFUNC. Slightly higher overhead (indirect call
// via function pointer loaded from cache).
// -------------------------------------------------------------------
using SumFn = auto (*)(const int64_t*, std::size_t) -> int64_t;

auto GetSumImpl() -> SumFn {
    const auto& f = CpuInfo::Instance().Features();
    if (f.avx2) {
#if defined(__AVX2__)
        return SumAVX2;
#endif
    }
    return SumScalar;
}

// -------------------------------------------------------------------
// Demonstration.
// -------------------------------------------------------------------
auto main() -> int {
    const auto& info  = CpuInfo::Instance();
    const auto& feats = info.Features();

    std::cout << "=== CPU Feature Detection ===\n";
    std::cout << "Microarchitecture level: x86-64-v" << info.Level() << "\n";
    std::cout << "Features: " << feats.ToString() << "\n\n";

    // Benchmark IFUNC dispatch.
    std::array<int64_t, 1024> data{};
    for (auto& v : data) v = 1;

    volatile auto result = SumDispatch(data.data(), data.size());

    auto sum_fn = GetSumImpl();
    volatile auto result2 = sum_fn(data.data(), data.size());

    std::cout << "Sum (IFUNC dispatch): " << result << "\n";
    std::cout << "Sum (manual dispatch): " << result2 << "\n\n";

    std::cout << "=== Recommendations ===\n";
    std::cout << "1. For cross-compilation: use -march=x86-64-v3 (not -march=native)\n";
    std::cout << "2. Use IFUNC for hot-path numeric routines\n";
    std::cout << "3. Cache CpuInfo::Instance() once at startup\n";
    std::cout << "4. For deploy: build fat binary with multiple -march variants\n";
    std::cout << "   and use dlopen() to load the best at runtime\n";

    return 0;
}
```
