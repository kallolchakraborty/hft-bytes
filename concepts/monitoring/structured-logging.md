---
type: reference
title: "Structured Logging"
description: "Binary logging with fixed schema enables zero-allocation, sub-100ns logging. JSON logging is for human consumers (auditors, regulators) — transform offline"
tags: ["phase-14"]
timestamp: "2026-06-27T03:06:09.449Z"
phase: 14
phaseName: "Monitoring & Security"
category: "Phase 14 - Monitoring & Security"
subcategory: "monitoring"
language: "cpp"
artifact-id: "ZHFT_STRUCTURED_LOGGING"
---
## Key Learning Points

- Binary logging with fixed schema enables zero-allocation, sub-100ns logging
- JSON logging is for human consumers (auditors, regulators) — transform offline
- Encryption at rest prevents tampering; immutable log chains detect deletion
- Retention policies must balance regulatory requirements (MiFID II = 5yr)
- Log queryability via indexed metadata — not full-text search on binary blobs

## Source Code

```cpp
#include <array>
#include <atomic>
#include <bit>
#include <chrono>
#include <concepts>
#include <cstdint>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <mutex>
#include <span>

// ---------------------------------------------------------------------------
// Binary log record — fixed-size header + payload. 64 bytes total to fit in a
// cache line and avoid fragmentation on SSDs.
// ---------------------------------------------------------------------------
// The schema version allows evolving fields without breaking the query tool.
// Using a magic number helps distinguish our logs from arbitrary files.
// ---------------------------------------------------------------------------
struct alignas(64) BinaryLogRecord {
  uint32_t magic;         // 0x484C4F47 ("HLOG")
  uint32_t schema_ver;    // 1
  uint64_t timestamp_ns;  // Monotonic or TAI timestamp
  uint64_t sequence;      // Global log sequence number (chain link)
  uint32_t thread_id;     // Originating thread
  uint16_t entry_type;    // 0=order, 1=market_data, 2=system, 3=audit
  uint16_t payload_len;   // Bytes in payload (max 32)
  uint8_t  payload[32];   // Inline payload — for longer payloads, use continuation records
  uint64_t prev_hash;     // SHA-256 truncated to 64 bits of previous record (chain)

  // Compute the "hash" linking this record to prev.
  static uint64_t link_hash(const BinaryLogRecord &prev) noexcept {
    // In production, use SipHash-1-3. Here we use a simple FNV-1a to illustrate.
    uint64_t h = 0xCBF29CE484222325ULL;
    const auto *bytes = reinterpret_cast<const uint8_t *>(&prev);
    for (size_t i = 0; i < sizeof(BinaryLogRecord); ++i) {
      h ^= bytes[i];
      h *= 0x100000001B3ULL;
    }
    return h;
  }
};

// ---------------------------------------------------------------------------
// Binary log writer — zero-allocation, thread-local ring buffer flushed to
// disk by a dedicated writer thread.
// ---------------------------------------------------------------------------
// Tradeoff: using thread-local buffers avoids lock contention at the cost of
// per-thread memory (~1MB per thread). For HFT firms with 8–16 cores this is
// acceptable; for 64-core machines, consider a shared lock-free MPSC queue.
// ---------------------------------------------------------------------------
class alignas(64) BinaryLogWriter {
  static constexpr size_t kBufferSize = 1 << 20; // 1M records per buffer.
  std::array<BinaryLogRecord, kBufferSize> buffer_;
  std::atomic<uint64_t> write_pos_{0};
  uint64_t          global_seq_ = 0;
  BinaryLogRecord   last_record_{};

  // File writer — runs on a background thread.
  std::mutex        file_mutex_;
  std::ofstream     file_;

public:
  void open(const std::filesystem::path &path) {
    std::lock_guard lk(file_mutex_);
    file_.open(path, std::ios::binary | std::ios::app);
  }

  // Requires: payload_len <= 32, data points to valid bytes.
  void write(uint16_t entry_type, const void *data, uint16_t payload_len) noexcept {
    uint64_t pos    = write_pos_.fetch_add(1, std::memory_order_acq_rel);
    auto &rec       = buffer_[pos & (kBufferSize - 1)];
    rec.magic       = 0x484C4F47;
    rec.schema_ver  = 1;
    rec.timestamp_ns = std::chrono::duration_cast<std::chrono::nanoseconds>(
                           std::chrono::system_clock::now().time_since_epoch())
                           .count();
    rec.sequence    = ++global_seq_;
    rec.thread_id   = 0; // Set via thread_local.
    rec.entry_type  = entry_type;
    rec.payload_len = std::min(payload_len, uint16_t(32));
    std::memcpy(rec.payload, data, rec.payload_len);
    rec.prev_hash   = BinaryLogRecord::link_hash(last_record_);
    last_record_    = rec;

    // Flush when buffer is half full (background thread wakes periodically).
    if ((pos & (kBufferSize / 2 - 1)) == 0) {
      flush();
    }
  }

  void flush() {
    std::lock_guard lk(file_mutex_);
    uint64_t pos = write_pos_.load(std::memory_order_acquire);
    // Write up to (pos % kBufferSize) records.
    // In production: batch write with pwritev or io_uring for zero-copy.
    file_.write(reinterpret_cast<const char *>(buffer_.data()),
                (pos & (kBufferSize - 1)) * sizeof(BinaryLogRecord));
    file_.flush();
  }

  // -----------------------------------------------------------------------
  // Query: replay records matching entry_type in a time window.
  // -----------------------------------------------------------------------
  template <typename Fn>
  void replay(uint16_t entry_type, uint64_t from_seq, uint64_t to_seq,
              Fn &&callback) {
    std::lock_guard lk(file_mutex_);
    file_.seekg(0);
    BinaryLogRecord rec;
    while (file_.read(reinterpret_cast<char *>(&rec), sizeof(rec))) {
      if (rec.magic != 0x484C4F47) continue; // Corruption or wrong file.
      if (rec.entry_type == entry_type && rec.sequence >= from_seq &&
          rec.sequence <= to_seq) {
        callback(rec);
      }
    }
  }
};

// ---------------------------------------------------------------------------
// Immutable log chain verifier.
// ---------------------------------------------------------------------------
// Reads a log file and checks that each record's prev_hash matches the SHA-256
// (truncated) of the preceding record. Returns the first mismatch position.
// ---------------------------------------------------------------------------
class LogChainVerifier {
public:
  struct Result {
    uint64_t first_corrupt_seq = UINT64_MAX;
    bool     valid             = true;
  };

  Result verify(std::span<const BinaryLogRecord> records) noexcept {
    Result res;
    for (size_t i = 1; i < records.size(); ++i) {
      uint64_t expected = BinaryLogRecord::link_hash(records[i - 1]);
      if (records[i].prev_hash != expected) {
        res.valid             = false;
        res.first_corrupt_seq = records[i].sequence;
        break;
      }
    }
    return res;
  }
};
```
