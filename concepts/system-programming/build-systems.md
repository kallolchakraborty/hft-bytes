---
type: reference
title: "Build Systems"
description: "CMakePresets.json ("cmake --preset") standardises configure/build. Bazel handles monorepos with Hermetic builds, remote caching,"
tags: ["phase-4"]
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

## Usage

// cmake --preset hft-release
// cmake --build --preset hft-release
// ./build/hft_release/my_strategy

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
