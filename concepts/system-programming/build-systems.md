---
type: reference
title: "Build Systems"
description: "CMakePresets.json ("cmake --preset") standardises configure/build. Bazel handles monorepos with Hermetic builds, remote caching,"
tags: ["phase-4"]
difficulty: intermediate
timestamp: "2026-06-27T03:06:09.411Z"
phase: 4
phaseName: "System Programming & IPC"
category: "Phase 4 - System Programming & IPC"
subcategory: "system-programming"
language: "cpp"
artifact-id: "ZHFT_BUILD_SYSTEMS"
---
## Key Learning Points

- CMakePresets.json ("cmake --preset") standardises configure/build
- Bazel handles monorepos with Hermetic builds, remote caching,
- Dependency management: vcpkg (manifest mode) for C++ libraries
- Unity (jumbo) builds merge multiple .cpp files into one translation
- ccache/sccache cache object files across clean builds. sccache
- distcc distributes compilation across network workers. Rare in
- Compilation database (CMAKE_EXPORT_COMPILE_COMMANDS) enables
- **Hermetic builds**: Bazel's sandboxing ensures each action sees only declared inputs — eliminates "works on my machine" bugs. For HFT, hermeticity guarantees that a build from git tag X produces a bit-identical binary regardless of the machine, time, or developer. Bazel achieves this via: remote caching (content-addressed storage — identical actions reuse cached outputs), remote execution (distribute across workers), and strict dependency declarations. CMake has no built-in hermeticity — you need Docker/containerized builds to approximate it
- **Distributed cache invalidation under LTO**: link-time optimization (LTO) means any object file change can invalidate the entire link result because cross-module inlining may change across all translation units. This makes incremental builds with LTO nearly as expensive as clean builds. Mitigations: (a) ThinLTO (`-flto=thin`) reduces the link-time working set by partitioning the callgraph; (b) split LTO steps into "import" and "codegen" phases so only changed modules need codegen; (c) use `-fimplicit-modules` (C++20 modules) to reduce transitive header dependencies. In practice, HFT teams either accept full rebuilds on LTO changes or keep a non-LTO debug build for quick iteration and use LTO only for release
- **PGO (Profile-Guided Optimization) build pipeline in CI**: ideal HFT pipeline: (a) build instrumented binary with `-fprofile-generate -fprofile-update=atomic`; (b) deploy to production-like replay environment that processes 1 hour of market data; (c) collect `.profraw` files, merge with `llvm-profdata merge`; (d) rebuild with `-fprofile-use -fprofile-partial-training`; (e) verify no performance regression against baseline profile (bit-exact diff of profile data). Store baseline profile in git LFS or artifact store. Gate CI on: if optimized binary IPC < 95% of baseline IPC, fail the build
- **Monorepo vs multi-repo decision for HFT**: monorepo (Bazel) — single source of truth, atomic cross-project changes, unified build cache, but requires investment in build tooling and may have slow `git log` at 10M+ files. Multi-repo (CMake + git submodules) — independent versioning, team autonomy, but cross-repo changes require coordination and tags. HFT pattern: most top firms use a monorepo with Bazel for C++ + Python trading code, and a separate repo (with submodule) for third-party dependencies. The monorepo enables cross-strategy refactoring (e.g., changing the order book API used by 50 strategies in one commit)
- **Caching strategy for HFT CI**: ccache/sccache cache object files by hash of preprocessed input — effective for non-LTO builds but misses cache with any header change. sccache supports S3/GCS as a distributed cache. For Bazel: remote cache (e.g., `bazel build --remote_cache=https://cache.example.com`) caches all action outputs. Target: 80%+ cache hit rate on PR builds. Monitor with `bazel build --color=yes 2>&1 | grep "remote cache hit"`. Avoid cache poisoning by separating debug/release cache keys (different compiler flags)
- **Build tool selection flow**: CMake for teams with existing CMake expertise, single-platform C++ codebases, and moderate scale (<500 source files). Bazel for multi-language monorepos, large teams (20+ devs), and where build hermeticity is a compliance requirement (must reproduce binary exactly). Meson for Python/C hybrid projects. In HFT: CMake dominates legacy firms migrating from Makefiles; Bazel dominates newer firms and quant-heavy shops due to Python+C+++CUDA multi-language support

## Staff+ Perspective

> **Staff+ Perspective**: Build system choice in HFT is driven more by compliance than developer convenience. At the firm, we adopted Bazel because the regulatory requirement for binary reproducibility (MiFID II RTS 6) demanded a hermetic build. With CMake + Docker, we could reproduce builds only if the Docker image was locked — which meant maintaining 100GB+ of Docker layers per compiler version. Bazel's `--remote_cache` and lockfile for toolchains made this manageable. The cache invalidation under LTO was a painful lesson: our first attempt at PGO in CI failed because the profile from the instrumented binary used different LTO partitioning than the optimized binary, causing `llvm-profdata` merge failures. The fix: use the same LTO flags for both instrumented and optimized builds, and add `-fprofile-partial-training` so unprofiled functions don't get optimized to branch to zero (crashes). For monorepo: expect resistance from teams with separate release cycles (market-data team releases independently from strategy team). We introduced "Bazel packages" with explicit visibility rules — the strategy team couldn't depend on the market-data team's internal symbols without approval. That solved the governance problem.

## Usage

```bash

cmake --preset hft-release
cmake --build --preset hft-release
./build/hft_release/my_strategy
```

## Source Code

```cpp
// =====================================================================
// CMakeLists.txt — HFT-optimised build configuration.
// =====================================================================
/*
cmake_minimum_required(VERSION 3.28)
project(zhft_hft
    VERSION 1.0.0
    DESCRIPTION "HFT Bytes — Low-Latency Trading Toolkit"
    LANGUAGES CXX
)

# -------------------------------------------------------------------
# C++ Standard & Global Flags
# -------------------------------------------------------------------
set(CMAKE_CXX_STANDARD 23)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)               # -pedantic-errors

# --- Interprocedural Optimisation (LTO) ---
set(CMAKE_INTERPROCEDURAL_OPTIMIZATION_RELEASE ON)
set(CMAKE_INTERPROCEDURAL_OPTIMIZATION_RELWITHDEBINFO OFF)  # debugability

# --- Compilation Database for clangd ---
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

# --- Position Independent Code (only for shared libs) ---
set(CMAKE_POSITION_INDEPENDENT_CODE OFF)    # saves 1-2% on static binary

# -------------------------------------------------------------------
# HFT-Optimised Compiler Flags (gcc / clang)
# -------------------------------------------------------------------
if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
    # Common optimisations for all HFT targets.
    set(HFT_COMMON_FLAGS
        -O3
        -mtune=native
        -funroll-loops
        -fomit-frame-pointer
        -fno-strict-aliasing            # some HFT code relies on punning
        -fvisibility=hidden              # default hidden visibility
        -fno-exceptions                  # exception-free hot path
        -fno-rtti                        # no RTTI for hot objects
        -fno-math-errno
        -ffast-math                      # HFT doesn't need IEEE 754 corner cases
        -freciprocal-math
        -fno-signed-zeros
        -fno-trapping-math
        -Wno-undefined-optimize          # suppress false positives
    )

    # LTO flags.
    set(HFT_LTO_FLAGS
        -flto=auto
        -fuse-linker-plugin
    )

    # Linker flags for minimum binary.
    set(HFT_LINK_FLAGS
        -Wl,--gc-sections                # garbage-collect unused sections
        -Wl,-z,relro                     # read-only relocations
        -Wl,-z,now                       # bind-now (security + startup)
        -Wl,--as-needed                  # link only needed libs
    )

    # Architecture dispatch: see ZHFT_CROSS_COMPILE for runtime dispatch.
    # DO NOT set -march=native here — use preset host-var.

    add_compile_options(${HFT_COMMON_FLAGS})
    add_link_options(${HFT_LTO_FLAGS} ${HFT_LINK_FLAGS})
endif()

# -------------------------------------------------------------------
# Libraries (vcpkg manifest mode; see vcpkg.json)
# -------------------------------------------------------------------
find_package(fmt CONFIG REQUIRED)
find_package(spdlog CONFIG REQUIRED)

# -------------------------------------------------------------------
# Core low-latency library
# -------------------------------------------------------------------
add_library(zhft_core
    src/core/order_book.cpp
    src/core/market_data.cpp
    src/core/timer.cpp
)
target_include_directories(zhft_core PUBLIC include)
target_link_libraries(zhft_core PUBLIC fmt::fmt spdlog::spdlog)

# -------------------------------------------------------------------
# Strategy executable
# -------------------------------------------------------------------
add_executable(zhft_strategy
    src/strategies/my_hft_strat.cpp
)
target_link_libraries(zhft_strategy PRIVATE zhft_core)

# -------------------------------------------------------------------
# Tests (Google Test)
# -------------------------------------------------------------------
enable_testing()
find_package(GTest CONFIG REQUIRED)
add_executable(zhft_tests
    tests/test_order_book.cpp
    tests/test_market_data.cpp
)
target_link_libraries(zhft_tests PRIVATE zhft_core GTest::gtest_main)
include(GoogleTest)
gtest_discover_tests(zhft_tests)
*/

// =====================================================================
// CMakePresets.json — Host-specific build configurations.
// =====================================================================
/*
{
    "version": 8,
    "configurePresets": [
        {
            "name": "default",
            "hidden": true,
            "generator": "Ninja",
            "binaryDir": "${sourceDir}/build/${presetName}",
            "cacheVariables": {
                "CMAKE_BUILD_TYPE": "RelWithDebInfo",
                "CMAKE_EXPORT_COMPILE_COMMANDS": "ON",
                "CMAKE_CXX_COMPILER_LAUNCHER": "ccache"
            }
        },
        {
            "name": "hft-dev",
            "inherits": "default",
            "displayName": "HFT Development",
            "description": "Fast incremental builds with ccache",
            "cacheVariables": {
                "CMAKE_BUILD_TYPE": "RelWithDebInfo",
                "CMAKE_INTERPROCEDURAL_OPTIMIZATION": "OFF",
                "HFT_ARCH_FLAGS": "-march=x86-64-v3"
            }
        },
        {
            "name": "hft-release",
            "inherits": "default",
            "displayName": "HFT Release",
            "description": "Fully optimised production binary",
            "cacheVariables": {
                "CMAKE_BUILD_TYPE": "Release",
                "CMAKE_INTERPROCEDURAL_OPTIMIZATION": "ON",
                "HFT_ARCH_FLAGS": "-march=x86-64-v4",
                "CMAKE_CXX_COMPILER_LAUNCHER": "sccache"
            }
        },
        {
            "name": "hft-ci",
            "inherits": "default",
            "displayName": "CI Build",
            "description": "Maximum build performance, no LTO",
            "cacheVariables": {
                "CMAKE_BUILD_TYPE": "Release",
                "CMAKE_INTERPROCEDURAL_OPTIMIZATION": "OFF",
                "HFT_ARCH_FLAGS": "-march=x86-64-v3",
                "CMAKE_UNITY_BUILD": "ON",
                "CMAKE_UNITY_BUILD_BATCH_SIZE": "32"
            }
        }
    ],
    "buildPresets": [
        { "name": "hft-dev",    "configurePreset": "hft-dev" },
        { "name": "hft-release","configurePreset": "hft-release" },
        { "name": "hft-ci",     "configurePreset": "hft-ci" }
    ],
    "testPresets": [
        {
            "name": "hft-tests",
            "configurePreset": "hft-dev",
            "output": {"outputOnFailure": true},
            "execution": {"noTestsAction": "error", "stopOnFailure": false}
        }
    ]
}
*/

// =====================================================================
// vcpkg.json — Manifest mode dependency pinning.
// =====================================================================
/*
{
    "name": "zhft-hft",
    "version": "1.0.0",
    "dependencies": [
        "fmt",
        "spdlog",
        "gtest",
        "boost-container",
        "boost-lockfree",
        "lz4",
        "xxhash"
    ],
    "builtin-baseline": "2d8a86a57d6f3c6ae9e6b464c3d09dab7ad0b3d8"
}
*/

// =====================================================================
// Build Systems Decision Matrix
// =====================================================================
/*
| Feature              | CMake + Ninja          | Bazel             | Meson          |
|----------------------|------------------------|-------------------|----------------|
| Incremental rebuild  | ~2-5 s (unity off)     | ~1-3 s (remote)   | ~2-5 s         |
| Remote caching       | sccache                | Built-in (CAS)    | ccache         |
| Dependency mgmt      | vcpkg / Conan          | WORKSPACE / Bzlmod| wrap files     |
| Multi-language       | C/C++/CUDA only        | Any (C++, Java,..)| C/C++/Rust     |
| Learning curve       | Low                    | High              | Medium         |
| CI integration       | Trivial                | Excellent         | Good           |
| HFT adoption         | ~70%                   | ~15%              | ~10%           |
| LTO support          | Mature                 | Good              | Good           |
*/

// =====================================================================
// No executable code — this is a build configuration reference.
// =====================================================================
auto main() -> int {
    std::cout << "Configure with: cmake --preset hft-release\n"
              << "Build with:     cmake --build --preset hft-release\n";
    return 0;
}
```
