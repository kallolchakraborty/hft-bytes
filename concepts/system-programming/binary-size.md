---
type: reference
title: "Binary Size"
description: "Linker garbage collection (-Wl,--gc-sections) drops unreferenced. LTO (Link-Time Optimization) enables cross-module inlining, dead"
tags: ["protocols"]
difficulty: intermediate
timestamp: "2026-06-27T03:06:09.411Z"
phase: 4
phaseName: "System Programming & IPC"
category: "Phase 4 - System Programming & IPC"
subcategory: "system-programming"
language: "cpp"
artifact-id: "ZHFT_BINARY_SIZE"
---
## Key Learning Points

- Linker garbage collection (-Wl,--gc-sections) drops unreferenced
- LTO (Link-Time Optimization) enables cross-module inlining, dead
- Visibility: -fvisibility=hidden makes all symbols hidden by
- Stripping: strip --strip-unneeded removes debug and unwind
- Startup time measurement: use __attribute__((init_priority))
- Prelink: prelink maps shared libraries at fixed addresses,
- -fno-exceptions eliminates unwind tables (.eh_frame, .gcc_except_table),
- Minimal init priority: use constinit (C++20) or constexpr for

## Usage

// g++ -O3 -std=c++20 ZHFT_BINARY_SIZE.txt -o binary_size
// ./binary_size
// strip ./binary_size  (optional)

## Source Code

```cpp
#include <algorithm>
#include <array>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <span>
#include <string_view>
#include <vector>

#include <dlfcn.h>
#include <unistd.h>

// -------------------------------------------------------------------
// Startup-time instrumentation.
// We use init_priority to control ordering and measure the duration
// of each initializer.
// -------------------------------------------------------------------
struct StartupTimer {
    const char*     name;
    uint64_t        tsc_start;
    uint64_t        tsc_end;

    static auto rdtsc() -> uint64_t {
        uint32_t hi, lo;
        asm volatile("rdtsc" : "=a"(lo), "=d"(hi));
        return (static_cast<uint64_t>(hi) << 32) | lo;
    }

    StartupTimer(const char* n) : name(n), tsc_start(rdtsc()) {}
    ~StartupTimer() {
        tsc_end = rdtsc();
        // Collect in a global list (simple linked list to avoid alloc).
        static StartupTimer* head = nullptr;
        next = head;
        head = this;
        list_head = head;   // ugly but avoids heap allocation
    }

    StartupTimer* next = nullptr;
    static StartupTimer* list_head;
};

StartupTimer* StartupTimer::list_head = nullptr;

// -------------------------------------------------------------------
// Some global objects (with controlled init).
// -------------------------------------------------------------------
constinit int g_fixed_value = 42;               // zero-cost init

// A global that does real work — we want to measure its init time.
alignas(64) static std::array<int, 1024> g_work_table;

// Constructor with measured init using init_priority.
struct alignas(64) WorkTableInit {
    WorkTableInit() {
        // Simulate a non-trivial global initializer:
        // fill with a deterministic pattern.
        for (std::size_t i = 0; i < g_work_table.size(); ++i) {
            g_work_table[i] = static_cast<int>((i * 0x9E3779B9) >> 16);
        }
    }
};

// Low priority (high number = runs last). Default priority ensures
// this runs before main but after I/O init.
WorkTableInit g_work_init __attribute__((init_priority(2000)));

// -------------------------------------------------------------------
// Binary size measurement utility.
// -------------------------------------------------------------------
auto GetBinarySize(const char* path) -> std::size_t {
    namespace fs = std::filesystem;
    try {
        if (fs::exists(path)) {
            return fs::file_size(path);
        }
    } catch (...) {}
    return 0;
}

auto GetSectionSizes(const char* path) -> void {
    // Use readelf (Linux) or size (macOS) to report section sizes.
    std::string cmd = std::string("size -A -d ") + path + " 2>/dev/null || "
                      "readelf -S " + path + " 2>/dev/null | grep -E '^\s+\\[' || "
                      "echo 'size tool not available'";
    std::array<char, 4096> buf{};
    FILE* fp = popen(cmd.c_str(), "r");
    if (fp) {
        while (fgets(buf.data(), static_cast<int>(buf.size()), fp)) {
            std::cout << "  " << buf.data();
        }
        pclose(fp);
    }
}

// -------------------------------------------------------------------
// Enumerate global initializers in the .init_array / .fini_array.
// This shows how many constructors run before main().
// -------------------------------------------------------------------
void DumpInitArray() {
    // On Linux with dl_iterate_phdr, one could enumerate init functions.
    // Here, we simulate by printing our known timers.
    std::cout << "\nRegistered startup timers:\n";
    auto* t = StartupTimer::list_head;
    int count = 0;
    uint64_t total_tsc = 0;
    while (t) {
        uint64_t elapsed = t->tsc_end - t->tsc_start;
        total_tsc += elapsed;
        std::cout << "  " << t->name << ": " << elapsed << " cycles\n";
        t = t->next;
        ++count;
    }
    std::cout << "Total init time: " << total_tsc << " cycles ("
              << (total_tsc / 4'000'000'000ULL) << " ms @ 4 GHz)\n";
    std::cout << "Number of initializers tracked: " << count << "\n";
}

// -------------------------------------------------------------------
// CMake configuration that achieves minimal binary.
// =====================================================================
// add_compile_options(
//     -ffunction-sections
//     -fdata-sections
//     -fvisibility=hidden
//     -fno-exceptions
//     -fno-rtti
// )
// add_link_options(
//     -Wl,--gc-sections
//     -Wl,-z,relro
//     -Wl,-z,now
//     -Wl,--as-needed
//     -flto=auto
// )
//
// # For stripping:
// add_custom_command(TARGET zhft_strategy POST_BUILD
//     COMMAND ${CMAKE_STRIP} --strip-unneeded -R .comment -R .note
//     $<TARGET_FILE:zhft_strategy>
// )
// =====================================================================

// -------------------------------------------------------------------
// Helper: measure actual CPU time from /proc/self/stat (Linux).
// -------------------------------------------------------------------
auto GetStartupCPUTime() -> double {
    std::ifstream proc("/proc/self/stat");
    if (!proc) return 0.0;
    std::string ignore;
    // Field 12 = cutime, field 13 = cstime, field 14 = starttime.
    for (int i = 0; i < 21; ++i) proc >> ignore;
    long startticks;
    proc >> startticks;
    long hertz = sysconf(_SC_CLK_TCK);
    if (hertz <= 0) hertz = 100;
    return static_cast<double>(startticks) / static_cast<double>(hertz);
}

// -------------------------------------------------------------------
// Demonstration.
// -------------------------------------------------------------------
auto main() -> int {
    // Record entry point time.
    auto t0 = std::chrono::steady_clock::now();
    static StartupTimer main_timer("main");

    const char* bin_path = "/proc/self/exe";   // Linux
    // Fallback: readlink
    std::array<char, 1024> exe_path{};
    ssize_t len = readlink("/proc/self/exe", exe_path.data(), exe_path.size() - 1);
    if (len > 0) {
        exe_path[len] = '\0';
        bin_path = exe_path.data();
    }

    std::cout << "=== Binary Size & Startup Analysis ===\n\n";
    std::cout << "Binary path: " << bin_path << "\n";
    std::cout << "Binary size: " << GetBinarySize(bin_path) << " bytes ("
              << (GetBinarySize(bin_path) / 1024.0) << " KB)\n\n";

    std::cout << "Section breakdown:\n";
    GetSectionSizes(bin_path);

    DumpInitArray();

    std::cout << "\n=== Optimization Techniques Applicable ===\n";
    std::cout << "| Technique              | Typical saving | Notes                    |\n";
    std::cout << "|------------------------|----------------|--------------------------|\n";
    std::cout << "| -ffunction-sections    | 10-15%         | Enables gc-sections      |\n";
    std::cout << "| -Wl,--gc-sections      | 15-25%         | Combine with above       |\n";
    std::cout << "| -flto                  | 10-20%         | Slower link, smaller bin |\n";
    std::cout << "| -fno-exceptions        | 5-15%          | Removes .eh_frame        |\n";
    std::cout << "| -fvisibility=hidden    | 5-10%          | Smaller .dynsym          |\n";
    std::cout << "| strip --strip-unneeded | 30-70%         | Remove debug/commment    |\n";
    std::cout << "| constinit / constexpr  | 0-5%           | Fewer global constructors|\n";
    std::cout << "| Static linking         | -20-50% larger | No PLT, faster startup   |\n";

    auto t1 = std::chrono::steady_clock::now();
    auto startup_ms = std::chrono::duration_cast<std::chrono::milliseconds>(t1 - t0).count();
    std::cout << "\nStartup to main() time: " << (startup_ms) << " ms\n";

    return 0;
}
```
