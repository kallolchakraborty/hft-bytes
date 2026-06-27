---
type: reference
title: "Secrets Management"
description: "API keys and certificates for exchange connectivity must never appear. Vault (HashiCorp) provides dynamic secrets + automatic rotation; KMS is"
tags: ["regulation"]
timestamp: "2026-06-27T03:06:09.448Z"
phase: 14
phaseName: "Monitoring & Security"
category: "Phase 14 - Monitoring & Security"
subcategory: "monitoring"
language: "cpp"
artifact-id: "ZHFT_SECRETS_MGMT"
---
## Key Learning Points

- API keys and certificates for exchange connectivity must never appear
- Vault (HashiCorp) provides dynamic secrets + automatic rotation; KMS is
- Certificate rotation must be zero-downtime — pre-generate overlapping
- Mutual TLS for FIX/Fast/ITCH connections authenticates both sides;
- Secrets should be fetched once at startup and held in mlock'd memory

## Source Code

```cpp
#include <algorithm>
#include <array>
#include <atomic>
#include <cerrno>
#include <chrono>
#include <cstdint>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <memory>
#include <mutex>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <sys/mman.h>
#include <unistd.h>
#include <vector>

// ---------------------------------------------------------------------------
// Memory-protected buffer — mlock'd, zeroed on destruction, guard pages.
// ---------------------------------------------------------------------------
class SecureBuffer {
  uint8_t *data_ = nullptr;
  size_t   size_ = 0;

public:
  SecureBuffer() = default;

  SecureBuffer(size_t sz) : size_(sz) {
    // Allocate with guard pages before and after the secret.
    size_t page_size = sysconf(_SC_PAGESIZE);
    size_t alloc_sz  = ((sz + page_size - 1) & ~(page_size - 1)) + 2 * page_size;

    void *raw = mmap(nullptr, alloc_sz, PROT_NONE,
                     MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    if (raw == MAP_FAILED) throw std::bad_alloc();

    // Middle page is readable/writable.
    void *data_page = static_cast<uint8_t *>(raw) + page_size;
    mprotect(data_page, alloc_sz - 2 * page_size, PROT_READ | PROT_WRITE);
    mlock(data_page, alloc_sz - 2 * page_size);
    data_ = static_cast<uint8_t *>(data_page);
  }

  ~SecureBuffer() {
    if (data_) {
      // Secure zero before munlock/munmap.
      explicit_bzero(data_, size_);
      size_t page_size = sysconf(_SC_PAGESIZE);
      size_t alloc_sz  = ((size_ + page_size - 1) & ~(page_size - 1)) + 2 * page_size;
      munlock(data_, alloc_sz - 2 * page_size);
      munmap(data_ - page_size, alloc_sz);
    }
  }

  SecureBuffer(const SecureBuffer &) = delete;
  SecureBuffer &operator=(const SecureBuffer &) = delete;
  SecureBuffer(SecureBuffer &&o) noexcept : data_(o.data_), size_(o.size_) {
    o.data_ = nullptr;
    o.size_ = 0;
  }

  std::span<uint8_t> span() noexcept { return {data_, size_}; }
  std::span<const uint8_t> span() const noexcept { return {data_, size_}; }
};

// ---------------------------------------------------------------------------
// Secrets manager — fetches secrets from Vault/KMS/file + holds in secure
// memory with atomic hot-reload for rotation.
// ---------------------------------------------------------------------------
template <size_t MaxSecretSize = 4096>
class SecretsManager {
  struct SecretSlot {
    SecureBuffer buffer;
    uint64_t     version = 0; // Monotonic version for rotation detection.
  };

  // Two slots for double-buffered rotation: readers use the active index
  // atomically; the rotation thread writes to the inactive index then swaps.
  alignas(64) std::atomic<uint32_t> active_{0};
  SecretSlot slots_[2];

  // Source configuration.
  enum class Backend { File, Vault, Kms };
  Backend backend_;

public:
  explicit SecretsManager(Backend b) : backend_(b) {
    slots_[0].buffer = SecureBuffer(MaxSecretSize);
    slots_[1].buffer = SecureBuffer(MaxSecretSize);
  }

  // Load a secret from the configured backend. Called once at startup.
  bool load(const std::string &path) {
    switch (backend_) {
    case Backend::File: {
      std::ifstream f(path, std::ios::binary);
      if (!f) return false;
      size_t pos = 0;
      std::array<uint8_t, 4096> tmp;
      while (f.read(reinterpret_cast<char *>(tmp.data()), tmp.size())) {
        auto span = slots_[0].buffer.span();
        size_t to_copy = std::min(tmp.size(), span.size() - pos);
        std::memcpy(span.data() + pos, tmp.data(), to_copy);
        pos += to_copy;
      }
      break;
    }
    case Backend::Vault:
      // Vault HTTP API call (libcurl / CPR) — omitted.
      // Response is JSON: {"data":{"key":"<base64>"}}
      break;
    case Backend::Kms:
      // AWS KMS Decrypt via SDK — omitted.
      break;
    }
    slots_[0].version = 1;
    return true;
  }

  // Access the active secret. The caller gets a versioned handle; if the
  // version changes, the handle is stale and should be re-fetched.
  struct SecretHandle {
    std::span<const uint8_t> data;
    uint64_t version;
  };

  SecretHandle read() const noexcept {
    uint32_t idx = active_.load(std::memory_order_acquire);
    return {slots_[idx].buffer.span(), slots_[idx].version};
  }

  // Rotate: called by a timer or Vault webhook. Must not block the hot path.
  bool rotate(const std::string &path) {
    uint32_t next = active_.load(std::memory_order_acquire) ^ 1;
    if (!load_into(path, next)) return false;
    slots_[next].version = slots_[active_.load()].version + 1;
    active_.store(next, std::memory_order_release);
    return true;
  }

private:
  bool load_into(const std::string &path, uint32_t slot_idx) {
    // Same as load() but writes into slots_[slot_idx].
    return load(path); // Simplified.
  }
};

// ---------------------------------------------------------------------------
// Mutual TLS configuration for FIX sessions.
// ---------------------------------------------------------------------------
struct MtlsConfig {
  SecureBuffer client_cert_der;
  SecureBuffer client_key_der;
  SecureBuffer ca_cert_der;           // Exchange's CA root
  std::string  expected_san;          // Subject Alternative Name to pin

  // Validate that the exchange's cert matches our pinning rules.
  static bool validate_peer_cert(const uint8_t *peer_cert_der, size_t len,
                                 const std::string &expected_san) noexcept {
    // In production: use OpenSSL X509_* APIs.
    // Steps: parse DER, extract SAN, compare with expected_san.
    // Also verify the cert chain against ca_cert_der.
    return true; // Placeholder.
  }
};
```
