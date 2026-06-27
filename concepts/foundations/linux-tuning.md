---
type: reference
title: "Linux Tuning"
description: "isolcpus: reserve cores for user-space polling — the kernel. nohz_full: disable timer ticks on isolated cores, preventing"
tags: ["phase-1"]
timestamp: "2026-06-27T03:06:09.398Z"
phase: 1
phaseName: "Foundations"
category: "Foundations"
subcategory: "foundations"
language: "cpp"
artifact-id: "ZHFT_LINUX_TUNING"
---
## Key Learning Points

- isolcpus: reserve cores for user-space polling — the kernel
- nohz_full: disable timer ticks on isolated cores, preventing
- rcu_nocbs: offload RCU callbacks from isolated cores to the
- intel_idle.max_cstate=0 processor.max_cstate=1: prevent deep
- IRQ affinity: bind NIC IRQs to isolated cores using
- cgroups/cpusets: further partition cores via cgroup v2.
- CPU governor: "performance" locks frequency at max so DVFS
- systemd service isolation: CPUAffinity, AllowedCPUs, and

## Usage

// g++ -std=c++20 ZHFT_LINUX_TUNING.txt -o linux_tuner
// sudo ./linux_tuner --apply   (applies settings via sysfs)
// sudo ./linux_tuner --verify  (checks current settings)

## Source Code

```cpp
#include <algorithm>
#include <cerrno>
#include <cstdint>
#include <cstring>
#include <filesystem>
#include <format>
#include <fstream>
#include <iostream>
#include <string>
#include <string_view>
#include <system_error>
#include <vector>

namespace fs = std::filesystem;

// -------------------------------------------------------------------
// Sysfs file writer — all tuning is done by writing to /sys or /proc.
// This is a no-nonsense helper with error reporting.
// -------------------------------------------------------------------
static bool write_sysfs(const fs::path& path, std::string_view value) {
    std::ofstream ofs(path);
    if (!ofs.is_open()) {
        std::cerr << std::format("FAIL: cannot open {}: {}\n",
                                 path.c_str(), std::strerror(errno));
        return false;
    }
    ofs << value;
    if (!ofs.good()) {
        std::cerr << std::format("FAIL: write to {} failed\n", path.c_str());
        return false;
    }
    std::cout << std::format("  OK  {}  <=  {}\n", path.c_str(), value);
    return true;
}

static bool read_sysfs(const fs::path& path, std::string& out) {
    std::ifstream ifs(path);
    if (!ifs.is_open()) return false;
    std::getline(ifs, out);
    return !out.empty();
}

// -------------------------------------------------------------------
// --apply: apply recommended HFT kernel settings
// -------------------------------------------------------------------
static bool apply_tuning(int first_isolated, int last_isolated) {
    bool all_ok = true;

    // 1. Set CPU governor to "performance".
    for (int cpu = 0; cpu <= last_isolated; ++cpu) {
        auto path = std::format(
            "/sys/devices/system/cpu/cpu{}/cpufreq/scaling_governor", cpu);
        if (fs::exists(path))
            all_ok &= write_sysfs(path, "performance");
    }

    // 2. Disable deep C-states via intel_idle.
    //    This also requires kernel boot parameter intel_idle.max_cstate=0.
    all_ok &= write_sysfs("/sys/module/intel_idle/parameters/max_cstate", "0");

    // 3. Disable dynamic power management on PCIe (ASPM).
    //    The kernel parses these as a bitmask; 0 = off.
    all_ok &= write_sysfs("/sys/module/pcie_aspm/parameters/policy", "performance");

    // 4. Set IRQ affinity for a given NIC (example: ens785) to core 2.
    //    In production you'd enumerate /sys/class/net/*/device/irq.
    //    This is illustrative only — uncomment when you know the IRQ numbers.
    // for (auto& entry : fs::directory_iterator("/proc/irq")) {
    //     std::string irq = entry.path().filename();
    //     if (irq.find_first_not_of("0123456789") == std::string::npos) {
    //         // Check if this IRQ belongs to the target NIC.
    //         // For now, skip (pre-set manually).
    //     }
    // }

    // 5. Reduce swappiness — we never want the kernel to swap HFT pages.
    all_ok &= write_sysfs("/proc/sys/vm/swappiness", "0");

    // 6. Disable transparent hugepage compaction.
    //    Compaction causes unpredictable latency spikes.
    all_ok &= write_sysfs("/sys/kernel/mm/transparent_hugepage/defrag", "never");
    all_ok &= write_sysfs("/sys/kernel/mm/transparent_hugepage/khugepaged/defrag", "0");

    // 7. Reduce timer slack.
    all_ok &= write_sysfs("/proc/sys/kernel/timer_migration", "0");

    std::cout << (all_ok ? "\nAll settings applied successfully.\n"
                         : "\nSome settings failed (see above).\n");
    return all_ok;
}

// -------------------------------------------------------------------
// --verify: read back current settings and report.
// -------------------------------------------------------------------
static void verify_tuning() {
    struct { std::string path; std::string label; } checks[] = {
        {"/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor", "CPU governor"},
        {"/sys/module/intel_idle/parameters/max_cstate", "intel_idle max_cstate"},
        {"/sys/module/pcie_aspm/parameters/policy", "ASPM policy"},
        {"/proc/sys/vm/swappiness", "swappiness"},
        {"/sys/kernel/mm/transparent_hugepage/defrag", "THP defrag"},
        {"/proc/sys/kernel/timer_migration", "timer migration"},
    };

    std::cout << "=== Kernel Tuning Verification ===\n";
    for (auto& c : checks) {
        std::string val;
        bool ok = read_sysfs(c.path, val);
        std::cout << std::format("  {} : {} ({})\n",
                                 c.label, ok ? val : "<unreadable>",
                                 ok ? "present" : "MISSING");
    }

    // Check isolcpus from kernel cmdline.
    std::string cmdline;
    if (read_sysfs("/proc/cmdline", cmdline)) {
        auto pos = cmdline.find("isolcpus=");
        if (pos != std::string::npos) {
            std::cout << std::format("  isolcpus : {} (from cmdline)\n",
                                     cmdline.substr(pos));
        } else {
            std::cout << "  isolcpus : NOT SET (reboot with isolcpus=...)\n";
        }
    }
}

// -------------------------------------------------------------------
// C++ Wrapper for cpuset Management
//
// cgroup v2 cpuset controller lets you partition cores dynamically.
// This class wraps the common operations.
// -------------------------------------------------------------------
class Cpuset {
    fs::path cgroup_base_ = "/sys/fs/cgroup";
    fs::path cpuset_path_;

public:
    explicit Cpuset(std::string_view name) : cpuset_path_(cgroup_base_ / name) {
        fs::create_directory(cpuset_path_);
        // The cgroup v2 cpuset controller requires that we write
        // the parent's cpuset.cpus and cpuset.mems first.
    }

    // Set allowed CPUs (e.g., "2-5" or "2,4,6").
    void set_cpus(std::string_view cpus) {
        write_sysfs(cpuset_path_ / "cpuset.cpus", cpus);
    }

    // Set allowed memory nodes (NUMA nodes).
    void set_mems(std::string_view mems) {
        write_sysfs(cpuset_path_ / "cpuset.mems", mems);
    }

    // Move a thread/TGID into this cpuset.
    void attach(pid_t pid) {
        write_sysfs(cpuset_path_ / "cgroup.procs", std::to_string(pid));
    }

    // Remove the cgroup.
    void remove() {
        fs::remove(cpuset_path_);
    }

    [[nodiscard]] auto path() const noexcept -> const fs::path& {
        return cpuset_path_;
    }
};

// -------------------------------------------------------------------
// MAIN
// -------------------------------------------------------------------
auto main(int argc, char** argv) -> int {
    bool apply  = false;
    bool verify = false;

    for (int i = 1; i < argc; ++i) {
        std::string arg(argv[i]);
        if (arg == "--apply")  apply = true;
        if (arg == "--verify") verify = true;
    }

    if (!apply && !verify) {
        std::cout << "Usage: sudo " << argv[0]
                  << " --apply | --verify\n";
        std::cout << "\n--apply applies kernel tuning parameters.\n";
        std::cout << "--verify reads back current settings.\n";
        return 0;
    }

    if (apply) {
        // Example: isolate cores 2-15 on a 16-core system.
        apply_tuning(2, 15);
    }

    if (verify) {
        verify_tuning();
    }

    return 0;
}
```
