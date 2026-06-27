---
type: reference
title: "BIOS Tuning"
description: "Hyper-Threading (SMT): often disabled for trading workloads.. Turbo Boost: disable for consistent latency.  Turbo transitions"
tags: ["phase-1"]
difficulty: beginner
timestamp: "2026-06-27T03:06:09.387Z"
phase: 1
phaseName: "Foundations"
category: "Foundations"
subcategory: "foundations"
language: "cpp"
artifact-id: "ZHFT_BIOS_TUNING"
---
## Key Learning Points

- Hyper-Threading (SMT): often disabled for trading workloads.
- Turbo Boost: disable for consistent latency.  Turbo transitions
- C-states and P-states: disable all deep C-states.
- PCIe ASPM (Active State Power Management): disable.
- Power profile: select "Performance" or "Maximum Performance"
- Memory interleaving: enable to spread memory access across all
- SR-IOV: enable if using virtual functions for NIC sharing.
- Watchdog timers: disable (HPET, TCO watchdog) to avoid NMIs.

## Usage

```bash

g++ -std=c++20 -O2 ZHFT_BIOS_TUNING.txt -o bios_validator
sudo ./bios_validator   (reads MSRs to verify BIOS settings)
```

## Source Code

```cpp
#include <algorithm>
#include <cerrno>
#include <cstdint>
#include <cstring>
#include <format>
#include <fstream>
#include <iostream>
#include <string>
#include <vector>

// -------------------------------------------------------------------
// MSR (Model-Specific Register) Reader
//
// On Linux, MSRs are accessed via /dev/cpu/<N>/msr.  The msr kernel
// module must be loaded (modprobe msr).  Only root can read MSRs.
//
// Relevant MSRs for BIOS verification:
//   0x1A0  MSR_IA32_MISC_ENABLE   — bit 34 = Turbo Boost disabled
//   0x10   MSR_IA32_PLATFORM_ID   — power profile info
//   0x198  MSR_IA32_PERF_STATUS   — current P-state
//   0x19C  MSR_IA32_THERM_STATUS  — thermal throttling
//   0x1FC  MSR_POWER_CTL          — C-state limits
//   0xCE   MSR_INTEL_PLATFORM_INFO — package C-state limits
//   0xE2   MSR_PKG_CST_CONFIG_CONTROL — C-state configuration
// -------------------------------------------------------------------

class MsrReader {
    int cpu_;
    int fd_;

public:
    explicit MsrReader(int cpu) : cpu_(cpu) {
        std::string path = std::format("/dev/cpu/{}/msr", cpu);
        fd_ = ::open(path.c_str(), O_RDONLY);
        if (fd_ < 0) {
            throw std::runtime_error(
                std::format("Cannot open {}: {} (load 'msr' module?)",
                            path, std::strerror(errno)));
        }
    }

    ~MsrReader() { if (fd_ >= 0) ::close(fd_); }

    // Disable copy.
    MsrReader(const MsrReader&) = delete;
    MsrReader& operator=(const MsrReader&) = delete;

    // Read a 64-bit MSR.
    [[nodiscard]] auto read(std::uint32_t msr) const -> std::uint64_t {
        std::uint64_t val = 0;
        auto n = ::pread(fd_, &val, sizeof(val), msr);
        if (n != sizeof(val)) {
            throw std::runtime_error(
                std::format("MSR read failed at 0x{:x}: {}", msr,
                            std::strerror(errno)));
        }
        return val;
    }
};

// -------------------------------------------------------------------
// BIOS Configuration Validator
//
// Reads critical MSRs and checks them against expected values for
// an HFT-optimised BIOS configuration.  Prints a pass/fail report.
// -------------------------------------------------------------------

struct BiosCheck {
    std::string     description;
    bool            ok;
    std::string     actual_value;
};

class BiosValidator {
    std::vector<BiosCheck> checks_;

public:
    explicit BiosValidator(int cpu = 0) {
        try {
            MsrReader msr(cpu);

            // ---- Turbo Boost: MSR_IA32_MISC_ENABLE bit 34 ----
            // 0 = Turbo enabled (default), 1 = disabled.
            // HFT wants Turbo disabled for deterministic latency.
            {
                auto val = msr.read(0x1A0);
                bool turbo_disabled = (val >> 34) & 1;
                checks_.push_back({
                    "Turbo Boost Disabled",
                    turbo_disabled,
                    turbo_disabled ? "disabled (OK)" : "ENABLED (jitter risk)"
                });
            }

            // ---- C-State Limit: MSR_PKG_CST_CONFIG_CONTROL bits [3:0] ----
            // 0 = C0/C1 only (no deep C-states), 7 = unlimited.
            // HFT wants 0 or 1.
            {
                auto val = msr.read(0xE2);
                int cstate_limit = val & 0xF;
                bool ok = cstate_limit <= 1;
                checks_.push_back({
                    "C-State Limit (PKG_CST_CONFIG)",
                    ok,
                    std::format("limit = C{} (desired <= C1)", cstate_limit)
                });
            }

            // ---- Hardware P-State control: MSR_MISC_PWR_MGMT bit 0 ----
            // 1 = hardware-controlled P-states (EIST).  HFT prefers
            // fixed frequency, so this should be 0 (OS-controlled, locked to max).
            {
                auto val = msr.read(0x1AA); // MSR_MISC_PWR_MGMT
                bool hw_pstate = val & 1;
                checks_.push_back({
                    "Hardware P-State Control (EIST)",
                    !hw_pstate,
                    hw_pstate ? "hardware-controlled (jitter)" : "OS/fixed (OK)"
                });
            }

            // ---- Thermal throttling: MSR_IA32_THERM_STATUS ----
            // bit 31 = PROCHOT (thermal throttle) status.
            // If set, the CPU is currently throttling — bad.
            {
                auto val = msr.read(0x19C);
                bool throttling = (val >> 31) & 1;
                checks_.push_back({
                    "Thermal Throttling Active",
                    !throttling,
                    throttling ? "THROTTLING (cooling issue)" : "not throttling (OK)"
                });
            }

            // ---- SMT (Hyper-Threading): check via /sys/devices/system/cpu/smt/active ----
            {
                std::string smt;
                std::ifstream ifs("/sys/devices/system/cpu/smt/active");
                if (ifs.good()) std::getline(ifs, smt);
                bool smt_on = (smt == "1");
                // HFT trading cores: SMT off.
                checks_.push_back({
                    "SMT / Hyper-Threading",
                    !smt_on,
                    smt_on ? "ON (contention risk)" : "OFF (OK)"
                });
            }

            // ---- Intel SpeedStep (EIST): MSR_IA32_MISC_ENABLE bit 16 ----
            // 1 = SpeedStep enabled.  HFT wants it disabled.
            {
                auto val = msr.read(0x1A0);
                bool eist = (val >> 16) & 1;
                checks_.push_back({
                    "Intel SpeedStep (EIST)",
                    !eist,
                    eist ? "ENABLED (frequency changes)" : "disabled (OK)"
                });
            }

        } catch (const std::exception& ex) {
            std::cerr << "Validation error: " << ex.what() << "\n";
            checks_.push_back({
                "MSR Access",
                false,
                std::format("FAILED: {}", ex.what())
            });
        }
    }

    // Print report.
    void report() const {
        bool all_pass = true;
        std::cout << "=== BIOS Configuration Validation ===\n";
        std::cout << std::format("{:<40} {:<12} {}\n", "Check", "Result", "Detail");
        std::cout << std::string(80, '-') << "\n";
        for (const auto& c : checks_) {
            std::cout << std::format("{:<40} {:<12} {}\n",
                                     c.description,
                                     c.ok ? "PASS" : "FAIL",
                                     c.actual_value);
            if (!c.ok) all_pass = false;
        }
        std::cout << std::string(80, '-') << "\n";
        if (all_pass) {
            std::cout << "All checks passed. BIOS is HFT-optimised.\n";
        } else {
            std::cout << "SOME CHECKS FAILED. Review BIOS settings.\n";
        }
    }
};

// -------------------------------------------------------------------
// MAIN
// -------------------------------------------------------------------
auto main(int argc, char** argv) -> int {
    int cpu = 0;
    if (argc > 1) cpu = std::stoi(argv[1]);

    try {
        BiosValidator validator(cpu);
        validator.report();
    } catch (const std::exception& e) {
        std::cerr << "FATAL: " << e.what() << "\n";
        return 1;
    }
    return 0;
}
```
