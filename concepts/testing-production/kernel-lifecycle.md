---
type: reference
title: "OS & Kernel Lifecycle Management for HFT"
description: "Kernel live patching (kpatch/kGraft) for security updates without reboot, OS golden image management, PXE boot, rolling reboots without trading downtime, minimal kernel configuration for HFT, GRUB tuning, and canarying kernel changes across 1000+ servers."
tags: ["kernel", "os", "lifecycle", "patching", "operations"]
difficulty: staff
timestamp: "2026-06-27T21:00:00.000Z"
phase: 15
phaseName: "Testing & Production"
category: "Testing & Production"
subcategory: "testing-production"
language: "cpp"
artifact-id: "ZHFT_KERNEL_LIFECYCLE"
---

## Key Learning Points

- **Kernel live patching**: kpatch (Red Hat) and kGraft (SUSE) allow applying security patches to the running kernel without a reboot. kpatch works by: (a) taking a diff between the patched and unpatched function; (b) creating a "patch module" that replaces the function's first 5 bytes with a jump to the patched version; (c) using `stop_machine` to safely apply the patch. For HFT: live patching is essential for security vulnerabilities (e.g., Dirty Pipe, Stack Clash) that require immediate fixes. Apply patches in a canary group first (1 server, 24 hours observation), then roll out across the fleet. Monitoring: verify patch applied with `kpatch list`. Rollback: `kpatch disable` on the patch module — but only if no server has been rebooted since the patch was applied. Live patching cannot fix data structure layout changes or ABI breaks — those still require a reboot
- **Golden image management**: every trading server must boot from a known-good OS image. Build golden images with Packer: (a) start from minimal base OS (RHEL Rocky / Ubuntu LTS minimal); (b) apply kernel boot parameters: `nohz_full=1-15 isolcpus=1-15 rcu_nocbs=1-15 hugepagesz=2M hugepages=8192 transparent_hugepage=never audit=0 intel_pstate=disable`; (c) install trading-specific packages: DPDK, Solarflare onload, ptp4l, phc2sys, custom allocators; (d) harden: disable unnecessary services (cups, avahi, postfix), remove compilers (no gcc on prod), set kernel parameters via sysctl; (e) sign with GPG and store in artifact repository. Each image is versioned (`rocky-9.3-hft-v2.14.0`). Deployment: PXE boot from the artifact repo
- **PXE boot and kickstart**: PXE boot enables provisioning a new server from bare metal to trading-ready in < 10 minutes without USB or physical media. Architecture: (a) DHCP server assigns IP and points to TFTP server for bootloader; (b) bootloader (pxelinux/grub2) loads kernel + initrd; (c) initrd runs kickstart/anaconda for automated install; (d) post-install script pulls golden image from artifact repo and applies per-server config (hostname, IP, BIOS settings). For HFT: PXE network must be on a separate management VLAN — not sharing bandwidth with trading traffic. PXE boot timeout: 30 seconds max before falling back to local disk boot (avoid hung servers on PXE server failure)
- **Rolling reboots without trading downtime**: no single server processes all venues — strategies are split across servers and venues (vertical separation). To reboot a server: (a) migrate its trading activity to redundant servers (failover venues to backup paths, stop strategy, wait for all orders to cancel/timeout); (b) verify the server is quiescent (no active orders, no position); (c) drain the network (withdraw anycast BGP prefix); (d) reboot; (e) after boot: verify OS image version, kernel boot params, service health; (f) re-join to trading (announce BGP prefix, resume strategy). Target: total trading downtime per server = 0 (if backup takes over transparently). Scheduling: rotate reboots across servers, never more than 1 server per rack simultaneously
- **Minimal kernel configuration**: compile a custom kernel with only the drivers and subsystems needed for trading. Config changes: (a) disable unneeded filesystems (ext2, btrfs, xfs — keep ext4 only; no FAT, NTFS, FUSE); (b) disable networking features not used (IPv6 if not needed, bridging, bonding, 802.1q if not used, Netfilter/iptables offloaded to hardware); (c) disable audio, USB, Bluetooth, Firewire, Thunderbolt; (d) disable cgroups v1, keep cgroups v2 only; (e) set CONFIG_HZ_1000 for finer timer granularity (1ms); (f) set CONFIG_PREEMPT=y for lower scheduling latency; (g) enable CONFIG_RCU_NOCB_CPU for offloaded RCU callbacks on isolated cores. Benchmark: a minimal kernel boots 3x faster and uses 50% less memory idle
- **Kernel boot parameters**: critical parameters for HFT in `/etc/default/grub`: `nohz_full=1-15` (full tickless on trading cores), `isolcpus=1-15` (isolate from scheduler), `rcu_nocbs=1-15` (defer RCU callbacks), `hugepagesz=2M hugepages=8192 transparent_hugepage=never`, `intel_pstate=disable` (use acpi-cpufreq governor), `processor.max_cstate=1` (limit idle states to C1), `pcie_aspm=off` (disable PCIe power management), `audit=0` (disable auditd), `nmi_watchdog=0` (disable NMI watchdog), `modprobe.blacklist=mei_me,mei` (disable Intel ME driver). After changing GRUB: `grub2-mkconfig -o /boot/grub2/grub.cfg` and schedule a rolling reboot
- **Canarying kernel changes**: any kernel change (patch, config, boot parameter) must be tested on a canary server before fleet rollout. Process: (a) pick a "canary pool" of 3-5 servers (one per strategy type: MM, arb, execution); (b) apply change during market close; (c) monitor for 24 hours: latency (p50/p99/p999), packet loss, connection stability, error rates; (d) compare metrics to the pre-canary 7-day baseline; (e) if any metric degrades > 5% (p99 latency increase, packet loss increase), rollback immediately; (f) if clean, roll out to 25% of fleet, then 50%, then 100%, each with 12-hour monitoring window. Kernel changes never deploy on Fridays (avoid weekend incidents). Use a configuration management tool (Ansible/Salt) with a "pre-flight" check that validates: kernel version matches expected, all boot params are set, no unexpected kernel modules loaded
- **OS upgrade strategy**: major OS upgrades (e.g., RHEL 8 → 9) require a multi-month plan: (a) build new golden image; (b) test in dev/staging with synthetic load; (c) run shadow mode on 1 server for 2 weeks (compare latency/stability to production OS); (d) roll out to canary pool for 2 weeks; (e) fleet rollout over 4 weeks (25% per week). Rollback path: keep old golden image deployed on standby partition (dual-boot images). On upgrade failure, reboot into the old partition. OS upgrades must be scheduled during low-volatility periods (avoid earnings season, Fed days)

## Source Code

```cpp
// Kernel patch status check
#include <cstdio>
#include <cstdlib>
#include <cstring>

int check_kpatch() {
  FILE* fp = popen("kpatch list 2>&1", "r");
  if (!fp) return -1;
  char buf[256];
  int patched = 0;
  while (fgets(buf, sizeof(buf), fp)) {
    if (strstr(buf, "patch")) patched++;
  }
  pclose(fp);
  printf("Applied patches: %d\n", patched);
  return patched;
}

// PXE boot config generator (simplified)
void generate_pxe_config(const char* hostname, const char* image_version) {
  printf("DEFAULT linux\n");
  printf("LABEL linux\n");
  printf("  KERNEL vmlinuz-%s\n", image_version);
  printf("  APPEND initrd=initrd-%s.img ", image_version);
  printf("nohz_full=1-15 isolcpus=1-15 rcu_nocbs=1-15 ");
  printf("hugepagesz=2M hugepages=8192 transparent_hugepage=never ");
  printf("intel_pstate=disable processor.max_cstate=1 ");
  printf("pcie_aspm=off audit=0 nmi_watchdog=0\n");
  printf("  IPAPPEND 2\n"); // use DHCP
}
```

## Usage

```bash
# Build golden image with Packer
packer build -var 'os_version=rocky-9.3' -var 'hft_version=2.14.0' hft-server.pkr.hcl

# Apply a kpatch
kpatch-build -t vmlinux kpatch-CVE-2026-1234.patch
kpatch install kpatch-CVE-2026-1234.ko
kpatch list

# Check boot parameters are correctly applied on a server
grep -q 'nohz_full=1-15' /proc/cmdline && echo "OK" || echo "MISSING"

# Rolling reboot of a server (after quiesce)
./quiesce_server.sh --host trading-42
ssh trading-42 'sudo reboot'
sleep 120
ssh trading-42 'sudo kpatch list'  # verify patches applied
./resume_trading.sh --host trading-42
```

## Staff+ Perspective

> **Staff+ Perspective**: The most critical OS lifecycle lesson I've learned: never deploy a kernel change during the trading week. We broke this rule once — applied a cgroup v2 kernel patch on a Wednesday during a quiet period. The patch had a latent bug in the memory controller that caused a kernel panic on our largest options MM server at 10:02 AM Thursday (market open volatility). The server dropped 200+ active orders, we missed 15 minutes of market making, and the PnL impact was $400K. The fix: revert to the standby partition (dual-boot) — the old kernel booted in 90 seconds, but the OMS had to reconnect all sessions, which took another 5 minutes. The post-mortem added two rules: (1) no kernel changes Wednesday-Thursday; (2) all kernel changes must have a verified rollback plan. For kpatch: we used it to patch the Dirty Pipe vulnerability (CVE-2022-0847) within 4 hours of the disclosure without a single reboot. The patch was written, compiled, tested on canary, and deployed to the fleet in 24 hours. Without kpatch, we would have needed a rolling reboot of 200+ servers — which would have taken a full weekend. Golden images solved our "server drift" problem — before golden images, each server had unique package versions, kernel settings, and BIOS configs (accumulated over years of manual changes). After golden images, every server is identical, making troubleshooting and performance tuning predictable. PXE boot saved a colo migration: we moved 100 servers from NY4 to NJ2 in 2 weeks — each server PXE-booted at the new colo with the correct network config and was trading within 8 minutes of power-on.