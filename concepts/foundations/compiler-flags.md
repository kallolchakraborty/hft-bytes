---
type: reference
title: "Compiler Flags"
description: "-O2  : safe optimisations; no precision loss.  Default for most. -O3  : enables -O2 + inlining heuristics, vectorisation, LCM,"
tags: ["phase-1"]
timestamp: "2026-06-27T03:06:09.395Z"
phase: 1
phaseName: "Foundations"
category: "Foundations"
subcategory: "foundations"
language: "cpp"
artifact-id: "ZHFT_COMPILER_FLAGS"
---
## Key Learning Points

- -O2  : safe optimisations; no precision loss.  Default for most
- -O3  : enables -O2 + inlining heuristics, vectorisation, LCM,
- -Ofast: -O3 + -ffast-math + -fno-protect-parens.  Breaks IEEE-754
- -march=native : tunes for the build host's exact CPU.  Never ship
- -mtune=...    : optimises scheduling/micro-op fusion for a specific
- LTO (-flto / -flto=thin): whole-program optimisation across TUs.
- PGO (-fprofile-generate / -fprofile-use): uses runtime profiles.
- -fomit-frame-pointer: frees RBP as GPR.  Essential on x86-64 where
- -fvisibility=hidden: reduces PLT indirection and .dynsym size.
- -ffast-math dangers: reassociates FP operations, flushes denormals

## Usage

See CMakeLists.txt below for a complete HFT-targeted configuration.

## Source Code

```cpp
// The CMakeLists.txt below is the build system; the C++ file after
// it is a simple benchmark to detect whether LTO made a difference.

/* ===================== CMakeLists.txt =====================
cmake_minimum_required(VERSION 3.25)
project(hft_optimised CXX)

set(CMAKE_CXX_STANDARD 23)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE OFF)

# ---- Base flags ----
set(BASE_FLAGS "-fomit-frame-pointer -fvisibility=hidden")
set(BASE_FLAGS "${BASE_FLAGS} -fno-strict-aliasing")  # HFT may use
  # type-punned reads from wire format; strict aliasing breaks them.
set(BASE_FLAGS "${BASE_FLAGS} -fno-exceptions -fno-rtti")
  # HFT code  rarely throws; disabling exceptions shrinks binary and
  # avoids the landing-pad overhead on every function prologue.

# ---- Architecture ----
# In CI, pass -DTARGET_ARCH=... so the binary runs on target hardware.
# For local builds, -march=native is fine.
if(NOT DEFINED TARGET_ARCH)
    set(TARGET_ARCH "native")
endif()
set(ARCH_FLAGS "-march=${TARGET_ARCH} -mtune=${TARGET_ARCH}")

# ---- Optimisation level ----
# We use -O3, NOT -Ofast, because financial numerics often depend on
# IEEE-754 denormals (prices very near zero) and precise FMA behaviour.
set(OPT_FLAGS "-O3")

# ---- Link-Time Optimisation ----
# ThinLTO on Clang; full LTO on GCC.  LTO enables cross-module inlining
# which is critical for small HFT helper functions (e.g., endian swaps).
if(CMAKE_CXX_COMPILER_ID MATCHES "Clang")
    set(LTO_FLAGS "-flto=thin")
else()
    set(LTO_FLAGS "-flto -fuse-linker-plugin")
endif()

# ---- Profile-Guided Optimisation ----
# Usage:
#   cmake -B build -DPGO=GENERATE
#   make -C build
#   ./build/bench --profile  # run representative workload
#   cmake -B build -DPGO=USE
#   make -C build
option(PGO "PGO mode: GENERATE or USE" "")
if(PGO STREQUAL "GENERATE")
    set(PGO_FLAGS "-fprofile-generate=${CMAKE_BINARY_DIR}/pgo")
elseif(PGO STREQUAL "USE")
    if(EXISTS "${CMAKE_BINARY_DIR}/pgo")
        set(PGO_FLAGS "-fprofile-use=${CMAKE_BINARY_DIR}/pgo")
    endif()
endif()

string(JOIN " " CMAKE_CXX_FLAGS_RELEASE
    ${BASE_FLAGS}
    ${ARCH_FLAGS}
    ${OPT_FLAGS}
    "-DNDEBUG"
)

string(JOIN " " CMAKE_EXE_LINKER_FLAGS_RELEASE
    ${LTO_FLAGS}
)

add_executable(lto_bench lto_bench.cpp)
target_compile_options(lto_bench PRIVATE
    $<$<CONFIG:Release>:${CMAKE_CXX_FLAGS_RELEASE}>
)
target_link_options(lto_bench PRIVATE
    $<$<CONFIG:Release>:${CMAKE_EXE_LINKER_FLAGS_RELEASE}>
)

# ---- Additional targets for PGO ----
if(PGO STREQUAL "GENERATE")
    target_compile_options(lto_bench PRIVATE ${PGO_FLAGS})
    target_link_options(lto_bench PRIVATE ${PGO_FLAGS})
elseif(PGO STREQUAL "USE")
    target_compile_options(lto_bench PRIVATE ${PGO_FLAGS})
    target_link_options(lto_bench PRIVATE ${PGO_FLAGS})
endif()
===================== CMakeLists.txt ===================== */

// -------------------------------------------------------------------
// lto_bench.cpp  —  Demonstrates LTO's impact on cross-module inlining.
//
// The function `sum` is defined in the same TU but in real LTO
// scenarios it would be in a separately compiled .cpp file.  LTO
// inlines it even across translation units.
// -------------------------------------------------------------------

#include <algorithm>
#include <chrono>
#include <cstdint>
#include <iomanip>
#include <iostream>
#include <random>
#include <vector>

// A small function that LTO can inline across TU boundaries.
// Without LTO, this call would cost a function call + return overhead
// (~5-10 cycles on Skylake).  With LTO and inlining, the compiler
// can fuse the loop and eliminate the call entirely.
[[gnu::always_inline]]
static inline std::uint64_t sum_values(const std::uint64_t* data,
                                        std::size_t n) noexcept {
    // Defined in a separate TU in real projects; here inline for demo.
    std::uint64_t s = 0;
    // The loop is vectorisable; LTO + PGO can unroll and SIMD it.
    for (std::size_t i = 0; i < n; ++i) s += data[i];
    return s;
}

// -------------------------------------------------------------------
// Benchmark: timed loop calling sum_values many times.
// Compile with and without -flto and compare run times.
// -------------------------------------------------------------------
auto main() -> int {
    constexpr std::size_t kCount   = 1'000'000;
    constexpr int         kRounds  = 100;

    std::vector<std::uint64_t> data(kCount);
    std::mt19937_64 rng{42};
    for (auto& v : data) v = rng();

    double best = 1e9;

    for (int r = 0; r < kRounds; ++r) {
        auto t0 = std::chrono::steady_clock::now();

        // The compiler CANNOT optimise this away because the result
        // is used below.  Without LTO, sum_values is a call.
        volatile auto sink = sum_values(data.data(), kCount);

        auto t1 = std::chrono::steady_clock::now();
        auto ns = std::chrono::duration<double, std::nano>(t1 - t0).count();
        best = std::min(best, ns);
    }

    std::cout << std::fixed << std::setprecision(1);
    std::cout << "LTO Benchmark:\n"
              << "  Elements      : " << kCount << "\n"
              << "  Best time     : " << best << " ns\n"
              << "  ns/element    : " << (best / static_cast<double>(kCount))
              << "\n";
    std::cout << "\nCompile with and without -flto; lower ns/element "
                 "indicates LTO inlined the cross-TU call.\n";
    return 0;
}
```
