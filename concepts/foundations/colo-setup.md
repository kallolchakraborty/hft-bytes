---
type: reference
title: "Colo Setup"
description: "Server rackmount: 1U or 2U depending on PCIe card count.  Leave. OS installation: minimal CentOS Stream / Ubuntu Server LTS."
tags: ["phase-1"]
difficulty: beginner
timestamp: "2026-06-27T03:06:09.395Z"
phase: 1
phaseName: "Foundations"
category: "Foundations"
subcategory: "foundations"
language: "cpp"
artifact-id: "ZHFT_COLO_SETUP"
---
## Key Learning Points

- Server rackmount: 1U or 2U depending on PCIe card count.  Leave
- OS installation: minimal CentOS Stream / Ubuntu Server LTS.
- SSH: key-only auth, disable root login, use a jump box/bastion.
- Network interface naming: biosdevname / systemd.link — set
- Firmware: update BIOS/iDRAC/iLO/BIOS before deployment.
- RAID vs no-RAID: HFT prefers JBOD (no RAID) on NVMe because
- SWAP: disable or set to a tiny partition on a slow disk.  HFT
- NTP: use PTP (IEEE 1588) with hardware timestamping for
- Monitoring: install node_exporter + netdata or collectd with

```html
<div class="ad-wrapper">
  <div class="ad-title">Colo Network Topology — Rack to Exchange</div>
  <div class="ad-topo">
    <div class="ad-node"><span class="ad-node-icon">🗄️</span><span>Firm Rack</span><span class="ad-node-label">Colo Cage</span></div>
    <div class="ad-link"><span class="ad-link-line"></span><span class="ad-link-dot"></span></div>
    <div class="ad-node"><span class="ad-node-icon">🔀</span><span>Top-of-Rack Switch</span><span class="ad-node-label">Leaf</span></div>
    <div class="ad-link"><span class="ad-link-line"></span><span class="ad-link-dot"></span></div>
    <div class="ad-node"><span class="ad-node-icon">🌐</span><span>DC Core Switch</span><span class="ad-node-label">Spine</span></div>
    <div class="ad-link"><span class="ad-link-line"></span><span class="ad-link-dot"></span></div>
    <div class="ad-node"><span class="ad-node-icon">🏛️</span><span>Exchange ME</span><span class="ad-node-label">Matching Engine</span></div>
  </div>
</div>
```

## Usage

```bash

g++ -std=c++20 ZHFT_COLO_SETUP.txt -o colo_config
./colo_config --generate > bootstrap.sh
(review and run on each colo server)
```

## Source Code

```cpp
#include <algorithm>
#include <format>
#include <fstream>
#include <iostream>
#include <map>
#include <string>
#include <string_view>
#include <vector>

// -------------------------------------------------------------------
// Ansible-like config generator for colo server provisioning.
//
// Instead of shipping Ansible (Python) on the target, we generate a
// shell bootstrap script.  This keeps the colo OS minimal: a stock
// kernel + busybox-level userspace + our trading binary.
// -------------------------------------------------------------------

// Represents one configuration block to emit as shell commands.
struct ConfigBlock {
    std::string title;
    std::vector<std::string> commands;
};

class ColoProvisioner {
    std::string hostname_;
    std::string trading_nic_;   // e.g., "ens785" → renamed to "trading0"
    std::string mgmt_nic_;      // e.g., "eno1" → "mgmt0"
    std::string ssh_pubkey_;
    std::string ntp_server_;
    bool        disable_swap_ = true;
    bool        disable_raid_ = true;   // Use NVMe JBOD

public:
    ColoProvisioner(std::string_view hostname,
                    std::string_view trading_nic,
                    std::string_view mgmt_nic,
                    std::string_view ssh_pubkey,
                    std::string_view ntp_server = "pool.ntp.org")
        : hostname_(hostname)
        , trading_nic_(trading_nic)
        , mgmt_nic_(mgmt_nic)
        , ssh_pubkey_(ssh_pubkey)
        , ntp_server_(ntp_server) {}

    // Generate the entire bootstrap script.
    [[nodiscard]] auto generate() const -> std::string {
        std::string out;
        out += "#!/bin/bash\n";
        out += "# Auto-generated colo bootstrap for " + hostname_ + "\n";
        out += "set -euo pipefail\n\n";

        out += emit_system_prep();
        out += emit_ssh_setup();
        out += emit_network_naming();
        out += emit_disk_config();
        out += emit_kernel_tuning();
        out += emit_ntp_setup();
        out += emit_monitoring();
        out += emit_finalize();

        return out;
    }

private:
    // ---- Prepare system ----
    [[nodiscard]] auto emit_system_prep() const -> std::string {
        return R"bash(# ---- System Preparation ----
# Remove unnecessary services to free CPU and reduce attack surface.
systemctl disable --now firewalld avahi-daemon cups \
    postfix tuned chronyd 2>/dev/null || true

# Install only what we need.
# We use dnf (RHEL) - adjust for apt (Debian/Ubuntu).
dnf install -y -q \
    kernel-devel \
    gcc-toolset-12-gcc-c++ \
    numactl-devel \
    libhugetlbfs-utils \
    sysstat \
    pps-tools \
    linuxptp \
    git

# Disable SELinux for minimum kernel bypass overhead; re-evaluate in audit.
setenforce 0
sed -i 's/^SELINUX=enforcing/SELINUX=permissive/' /etc/selinux/config

# Set hostname
)"bash;
        out += "hostnamectl set-hostname " + hostname_ + "\n\n";
        return out;
    }

    // ---- SSH ----
    [[nodiscard]] auto emit_ssh_setup() const -> std::string {
        std::string out = R"bash(# ---- SSH Hardening ----
mkdir -p /root/.ssh
chmod 700 /root/.ssh
echo ')"bash;
        out += ssh_pubkey_;
        out += R"bash(' >> /root/.ssh/authorized_keys
chmod 600 /root/.ssh/authorized_keys

cat > /etc/ssh/sshd_config.d/99-hft.conf << 'SSH'
PermitRootLogin prohibit-password
PasswordAuthentication no
PubkeyAuthentication yes
ChallengeResponseAuthentication no
UsePAM no
ClientAliveInterval 30
ClientAliveCountMax 3
MaxStartups 5
SSH
systemctl restart sshd
)"bash;
        return out;
    }

    // ---- Network naming ----
    [[nodiscard]] auto emit_network_naming() const -> std::string {
        return std::format(R"bash(# ---- Predictable Network Naming ----
# Rename interfaces so trading code always sees the same name.
# Uses systemd.link (supported in systemd v248+).
cat > /etc/systemd/network/10-trading.link << 'LINK'
[Match]
MACAddress=%s
[Link]
Name=trading0
TransmitHashPolicy=layer3+4
LINK

cat > /etc/systemd/network/10-mgmt.link << 'LINK'
[Match]
MACAddress=%s
[Link]
Name=mgmt0
LINK

# Apply naming (or reboot).
udevadm control --reload && udevadm trigger
sleep 2
ip link set trading0 up
ip link set mgmt0 up
)"bash, "xx:xx:xx:xx:xx:xx", "yy:yy:yy:yy:yy:yy");
    }

    // ---- Disk config (JBOD, no SWAP) ----
    [[nodiscard]] auto emit_disk_config() const -> std::string {
        std::string out;
        if (disable_swap_) {
            out += R"bash(# ---- Disable SWAP ----
swapoff -a
sed -i '/swap/d' /etc/fstab
# Also remove swapfile if present.
rm -f /swapfile 2>/dev/null || true
)"bash;
        }
        if (disable_raid_) {
            out += R"bash(# ---- No RAID / JBOD ----
# NVMe drives should be exposed as /dev/nvme0n1, /dev/nvme1n1.
# We do NOT create mdadm arrays; the trading app manages device directly.
# Format each NVMe with ext4, noatime, nodiscard.
for dev in /dev/nvme*n1; do
    echo "Formatting $dev ..."
    mkfs.ext4 -F -E lazy_itable_init=0,lazy_journal_init=0 "$dev"
    tune2fs -o journal_data_writeback "$dev"
done

# Mount with noatime to avoid access-time updates on every read.
mkdir -p /data/trading /data/logs
mount -o noatime,nodiscard,nobarrier /dev/nvme0n1 /data/trading
mount -o noatime,nodiscard,nobarrier /dev/nvme1n1 /data/logs
echo '/dev/nvme0n1 /data/trading ext4 noatime,nodiscard,nobarrier 0 0' >> /etc/fstab
echo '/dev/nvme1n1 /data/logs    ext4 noatime,nodiscard,nobarrier 0 0' >> /etc/fstab
)"bash;
        }
        return out;
    }

    // ---- Kernel tuning ----
    [[nodiscard]] auto emit_kernel_tuning() const -> std::string {
        return R"bash(# ---- Kernel Boot Parameters ----
# Append to GRUB_CMDLINE_LINUX
# This requires regenerating grub.cfg; the admin should review first.
CURRENT=$(grep '^GRUB_CMDLINE_LINUX=' /etc/default/grub | head -1 | sed "s/GRUB_CMDLINE_LINUX=//" | tr -d '"')
NEW="$CURRENT intel_idle.max_cstate=0 processor.max_cstate=1"
NEW="$NEW isolcpus=2-15,18-31 nohz_full=2-15,18-31 rcu_nocbs=2-15,18-31"
NEW="$NEW default_hugepagesz=1G hugepagesz=1G hugepages=16"
sed -i "s|^GRUB_CMDLINE_LINUX=.*|GRUB_CMDLINE_LINUX=\"$NEW\"|" /etc/default/grub
grub2-mkconfig -o /boot/grub2/grub.cfg

# Apply sysctl settings.
cat > /etc/sysctl.d/99-hft.conf << 'SYSCTL'
# Reduce jitter
kernel.timer_migration = 0
kernel.nmi_watchdog = 0
vm.swappiness = 0
vm.stat_interval = 0
# Network
net.core.rmem_max = 134217728
net.core.wmem_max = 134217728
net.core.busy_poll = 50
net.core.busy_read = 50
SYSCTL
sysctl --system
)"bash;
    }

    // ---- NTP / PTP ----
    [[nodiscard]] auto emit_ntp_setup() const -> std::string {
        return std::format(R"bash(# ---- Time Synchronization ----
# Prefer PTP; fall back to NTP.
# Assuming NIC supports hardware timestamping (e.g., Solarflare).
cat > /etc/linuxptp/ptp4l.conf << 'PTP'
[global]
network_transport      L2
delay_mechanism       P2P
tsproc_mode           hardware
logSyncInterval       0
logAnnounceInterval   1
logMinDelayReqInterval 0
PTP

# Run ptp4l on the trading NIC.
# systemctl enable ptp4l@trading0
# For NTP fallback:
echo 'server {} iburst prefer' > /etc/chrony.conf
echo 'refclock PHC /dev/ptp0 poll 0 dpoll -2 offset 0' >> /etc/chrony.conf
systemctl restart chronyd
)"bash, ntp_server_);
    }

    // ---- Monitoring ----
    [[nodiscard]] auto emit_monitoring() const -> std::string {
        return R"bash(# ---- Monitoring Agents ----
# Install node_exporter (Prometheus) — minimal CPU footprint.
curl -sL https://github.com/prometheus/node_exporter/releases/... | tar xz
./node_exporter --no-collector.softnet --no-collector.arp \
    --no-collector.bcache --no-collector.conntrack \
    --collector.disable-defaults \
    --collector.cpu --collector.memory --collector.netdev \
    --collector.diskstats --collector.nvme &

# Write a simple health-check script that reports to the trading monitor.
cat > /usr/local/bin/hft_health.sh << 'HEALTH'
#!/bin/bash
echo "host=$(hostname) uptime=$(uptime -p) load=$(uptime | awk '{print $(NF-2)}')"
HEALTH
chmod +x /usr/local/bin/hft_health.sh

# Add to crontab (every 10 seconds — aggressive but lightweight).
echo '* * * * * /usr/local/bin/hft_health.sh >> /var/log/hft_health.log' | crontab -
)"bash;
    }

    // ---- Finalize ----
    [[nodiscard]] auto emit_finalize() const -> std::string {
        return R"bash(# ---- Final Steps ----
echo "Bootstrap complete for $(hostname)."
echo "Reboot to apply kernel parameters: sudo reboot"
)"bash;
    }
};

// -------------------------------------------------------------------
// MAIN
// -------------------------------------------------------------------
auto main(int argc, char** argv) -> int {
    bool generate = false;
    for (int i = 1; i < argc; ++i) {
        if (std::string(argv[i]) == "--generate") generate = true;
    }

    if (!generate) {
        std::cout << "Usage: " << argv[0] << " --generate > bootstrap.sh\n";
        std::cout << "Generates a colo provisioning script.\n";
        return 0;
    }

    ColoProvisioner provisioner(
        "hft-colo-01",
        "xx:xx:xx:xx:xx:01",  // trading NIC MAC
        "xx:xx:xx:xx:xx:02",  // mgmt NIC MAC
        "ssh-ed25519 AAAAC3... user@hft-jumpbox"
    );

    std::cout << provisioner.generate();
    return 0;
}
```
