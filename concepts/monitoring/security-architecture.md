---
type: reference
title: "Security Architecture for Trading"
description: "Network segmentation (DMZ, trading VLAN, admin VLAN, management VLAN), mTLS certificate rotation, SSH CA-based authentication, zero-trust principles for trading systems, secrets rotation with Vault, and audit log tamper-proofing."
tags: ["operations"]
difficulty: staff
timestamp: "2026-06-27T03:50:00.000Z"
phase: 14
phaseName: "Monitoring & Security"
category: "Monitoring"
subcategory: "monitoring"
language: "cpp"
artifact-id: "ZHFT_SECURITY_ARCHITECTURE"
---
## Key Learning Points

- Network segmentation: DMZ for exchange-facing connectivity (FIX gateways, market-data feeds), trading VLAN for strategy/OMS/SOR (low-latency, no encryption), admin VLAN (SSH, config, monitoring), management VLAN (IPMI, BMC). Firewalls between DMZ and trading VLAN only permit known ports/protocols
- mTLS certificate rotation: internal services use mutual TLS; short-lived certs (24h) issued by internal CA; auto-renew via cert-manager/ Vault; cert revocation list checked per connection; rotation must not add > 1us to connection setup
- SSH CA-based auth: no SSH keys distributed per-user; user certs signed by SSH CA; certs embed principal, expiry, source IP; revocation via CA cert reissue + cert list
- Zero-trust for trading: every service-to-service call authenticated and authorized; no implicit trust within trading VLAN; policy: service A can only call service B on specific port, no lateral movement
- Secrets rotation: credentials (exchange passwords, API keys, database passwords) rotated every 30 days; Vault dynamic secrets for databases (auto-expiring credentials); rotation must be live (no restart)
- Audit log tamper-proofing: logs written to append-only storage (WORM drive or cloud object lock); SHA-256 hash chain links consecutive log entries; integrity verified daily

## Usage

```cpp
// Network segmentation mapping (simplified)
// VLAN 100 — Exchange DMZ (public IPs, FIX/market-data)
//   → Gateways: TCP 9100-9199 (FIX), UDP 5000-5100 (MDP)
// VLAN 200 — Trading (no outbound to internet)
//   → Strategies, OMS, SOR, order-book handlers
// VLAN 300 — Admin (SSH access only from jump box)
//   → Jump box: SSH CA-signed certs only
// VLAN 400 — Management (IPMI, iDRAC, BMC)
//   → Isolated, no internet, VPN-only access

// Secrets rotation via Vault (API)
struct SecretsManager {
    std::string getSecret(const std::string& path) {
        // vault read -field=value secret/trading/exchange/cme_password
        // Returns cached secret with expiry TTL
        // On expiry (TTL < 60s), re-read from Vault
    }

    void rotate() {
        // For each secret:
        // 1. Issue new secret in Vault (old still valid for overlap)
        // 2. Update application config (live reload)
        // 3. Verify new secret works
        // 4. Revoke old secret in Vault
    }
};

// Audit log entry with hash chain
struct AuditEntry {
    uint64_t index_;
    std::string payload_;       // JSON event
    std::string prev_hash_;     // SHA-256 of previous entry
    std::string hash_;          // SHA-256(prev_hash + payload)
};
```

## Source Code

```cpp
// mTLS certificate path (internal services)
// ┌────────────┐     mTLS     ┌────────────┐
// │ Strategy   │◄────────────►│ OMS        │
// │ (client)   │              │ (server)   │
// └────────────┘              └────────────┘
// Each service has:
//   /etc/certs/tls.crt   (signed by internal CA, valid 24h)
//   /etc/certs/tls.key   (private key, 0600 perms)
//   /etc/certs/ca.crt    (internal CA cert)

// Access control policy (example):
// allow strategy-oms-api if:
//   source.service == "strategy-es-mm"
//   dest.service == "oms"
//   protocol == "sbe"
//   port == 9001

// SSH CA cert request:
// $ ssh-keygen -s ca_key -I "kallol" -n "kallol" \
//     -V "+52w" -O source-address=10.0.0.0/8 \
//     /home/kallol/.ssh/id_ed25519.pub
```
