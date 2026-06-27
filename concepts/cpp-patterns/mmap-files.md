---
type: reference
title: "MMAP Files"
description: "mmap maps a file directly into virtual address space, avoiding. MAP_SHARED: writes go back to file (shared across processes)."
tags: ["ipc", "trading"]
difficulty: advanced
timestamp: "2026-06-27T03:06:09.409Z"
phase: 3
phaseName: "C++ Low-Latency Patterns"
category: "C++ Low-Latency Patterns"
subcategory: "cpp-patterns"
language: "cpp"
artifact-id: "ZHFT_MMAP_FILES"
---
## Key Learning Points

- mmap maps a file directly into virtual address space, avoiding
- MAP_SHARED: writes go back to file (shared across processes).
- File-backed mmap for persistent storage of order state across
- Crash consistency requires checksums (CRC32C) and append-only
- Recovery scanner re-traverses the journal from a known good

## Usage

MappedOrderJournal journal("orders.jrn", 64 << 20);  // 64 MB
journal.append(order);
// ... crash recovery ...
journal.recover([](const Order& o) { /* replay */ });

## Source Code

```cpp
*
 * PERFORMANCE TARGET:
 *   mmap file open  (64 MB):           ~2-5µs
 *   Append to journal (64-byte write):  ~30ns
 *   Sequential scan (CRC verify, 1 GB): ~500ms
 *   fsync (single entry):               ~2-10µs
 * ====================================================================
 */

#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>
#include <span>
#include <stdexcept>
#include <system_error>
#include <filesystem>
#include <fcntl.h>
#include <unistd.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <immintrin.h>  // _mm_crc32_u64 / _mm_crc32_u8

// ---------------------------------------------------------------------------
// CRC32C (hardware-accelerated via SSE 4.2)
// ---------------------------------------------------------------------------
class CRC32C {
public:
    static uint32_t compute(const void* data, size_t len, uint32_t crc = 0) {
        crc = ~crc;
        const uint8_t* buf = static_cast<const uint8_t*>(data);
        size_t i = 0;

        // Process 8 bytes at a time
        for (; i + 8 <= len; i += 8) {
            uint64_t word;
            std::memcpy(&word, buf + i, 8);
            crc = static_cast<uint32_t>(_mm_crc32_u64(crc, word));
        }

        // Remaining bytes
        for (; i < len; ++i)
            crc = _mm_crc32_u8(crc, buf[i]);

        return ~crc;
    }
};

// ---------------------------------------------------------------------------
// Append-only order journal (memory-mapped, with CRC protection)
// ---------------------------------------------------------------------------
#pragma pack(push, 1)
struct JournalEntryHeader {
    uint64_t  timestamp_ns;
    uint32_t  entry_size;    // size of payload (excludes header and CRC)
    uint32_t  crc32;         // CRC of (header without crc + payload)
    uint8_t   type;          // entry type
    uint8_t   flags;
};
#pragma pack(pop)

struct OrderEntry {
    JournalEntryHeader header;
    uint8_t            payload[256]; // flexible in practice
};

class MappedOrderJournal {
public:
    MappedOrderJournal(const std::string& path, size_t capacity)
        : path_(path), capacity_(capacity) {
        // Open or create file
        fd_ = ::open(path.c_str(), O_RDWR | O_CREAT, 0644);
        if (fd_ < 0)
            throw std::system_error(errno, std::generic_category(),
                                    "open journal");

        // Ensure file is large enough
        struct stat st;
        if (::fstat(fd_, &st) < 0)
            throw std::system_error(errno, std::generic_category(),
                                    "fstat journal");

        // If file is smaller than capacity, extend it
        if (static_cast<size_t>(st.st_size) < capacity) {
            if (::ftruncate(fd_, capacity) < 0)
                throw std::system_error(errno, std::generic_category(),
                                        "ftruncate journal");
        }

        // Map file
        map_ = static_cast<uint8_t*>(::mmap(
            nullptr, capacity,
            PROT_READ | PROT_WRITE,
            MAP_SHARED,        // shared: writes go back to file
            fd_, 0));

        if (map_ == MAP_FAILED)
            throw std::system_error(errno, std::generic_category(),
                                    "mmap journal");

        ::close(fd_);  // fd no longer needed after mmap
        fd_ = -1;

        // Find write position (recover last valid entry)
        write_pos_ = findWritePosition();
    }

    ~MappedOrderJournal() {
        if (map_ && map_ != MAP_FAILED) {
            ::munmap(map_, capacity_);
        }
    }

    MappedOrderJournal(const MappedOrderJournal&) = delete;
    MappedOrderJournal& operator=(const MappedOrderJournal&) = delete;

    // Append an entry to the journal
    // Returns offset where entry was written
    size_t append(const void* data, size_t data_len, uint8_t type,
                   uint64_t timestamp) {
        size_t entry_size = sizeof(JournalEntryHeader) + data_len;
        if (write_pos_ + entry_size + sizeof(uint32_t) > capacity_)
            return SIZE_MAX;  // journal full

        uint8_t* dest = map_ + write_pos_;

        JournalEntryHeader header;
        header.timestamp_ns = timestamp;
        header.entry_size   = static_cast<uint32_t>(data_len);
        header.type         = type;
        header.flags        = 0;

        // Compute CRC over header (excluding crc field) + payload
        // Write header without CRC first, then CRC
        header.crc32 = computeEntryCRC(header, data, data_len);
        std::memcpy(dest, &header, sizeof(header));
        std::memcpy(dest + sizeof(header), data, data_len);

        // Write CRC32 after payload (for double verification on recovery)
        uint32_t payload_crc = CRC32C::compute(data, data_len);
        std::memcpy(dest + sizeof(header) + data_len, &payload_crc,
                    sizeof(payload_crc));

        size_t offset = write_pos_;
        write_pos_ += entry_size + sizeof(uint32_t);

        return offset;
    }

    // Ensure durability (fsync via msync)
    void commit() {
        if (::msync(map_, capacity_, MS_SYNC) < 0)
            throw std::system_error(errno, std::generic_category(),
                                    "msync journal");
    }

    // Recovery scanner: traverses journal, verifies CRC, invokes callback
    template <typename Callback>
    size_t recover(Callback on_entry) {
        size_t offset = 0;
        size_t entries_recovered = 0;

        while (offset + sizeof(JournalEntryHeader) <= write_pos_) {
            JournalEntryHeader header;
            std::memcpy(&header, map_ + offset, sizeof(header));

            // Sanity check
            if (header.entry_size == 0 ||
                header.entry_size > 256 ||
                header.timestamp_ns == 0) {
                break;  // likely end of valid data
            }

            size_t entry_total = sizeof(JournalEntryHeader) +
                                 header.entry_size + sizeof(uint32_t);
            if (offset + entry_total > write_pos_)
                break;

            // Verify CRC
            uint32_t expected_crc = header.crc32;
            uint32_t computed_crc = computeEntryCRC(header,
                map_ + offset + sizeof(header), header.entry_size);

            if (expected_crc != computed_crc) {
                // CRC mismatch — stop (corruption or partial write)
                break;
            }

            // Verify payload CRC
            uint32_t stored_payload_crc;
            std::memcpy(&stored_payload_crc,
                        map_ + offset + sizeof(header) + header.entry_size,
                        sizeof(stored_payload_crc));
            uint32_t actual_payload_crc = CRC32C::compute(
                map_ + offset + sizeof(header), header.entry_size);

            if (stored_payload_crc != actual_payload_crc)
                break;

            // Valid entry — invoke callback
            on_entry(map_ + offset + sizeof(header), header.entry_size,
                     header.type, header.timestamp_ns);

            offset += entry_total;
            ++entries_recovered;
        }

        write_pos_ = offset;  // reset write position to end of valid data
        return entries_recovered;
    }

    // Snapshot current state (checkpoint) to a new position
    // Freezes the journal up to current write_pos_ for crash recovery
    size_t checkpoint() {
        commit();
        checkpoint_pos_ = write_pos_;
        return checkpoint_pos_;
    }

    // Accessors
    uint8_t* data() { return map_; }
    size_t size() const { return capacity_; }
    size_t used() const { return write_pos_; }
    const std::string& path() const { return path_; }

private:
    std::string path_;
    int    fd_ = -1;
    size_t capacity_;
    uint8_t* map_ = nullptr;
    size_t write_pos_ = 0;
    size_t checkpoint_pos_ = 0;

    static uint32_t computeEntryCRC(const JournalEntryHeader& header,
                                     const void* payload, size_t payload_len) {
        // CRC over header (with crc32 field zeroed) + payload
        JournalEntryHeader h = header;
        h.crc32 = 0;
        uint32_t crc = CRC32C::compute(&h, sizeof(h));
        crc = CRC32C::compute(payload, payload_len, crc);
        return crc;
    }

    size_t findWritePosition() {
        // Scan for end of valid entries
        size_t best = 0;
        recover([&best](const void*, size_t, uint8_t, uint64_t) {});
        best = write_pos_;  // set by recover
        return best;
    }
};

// ---------------------------------------------------------------------------
// Lightweight order journal with fixed-size entries
// ---------------------------------------------------------------------------
template <typename T>
class FixedEntryJournal {
    static_assert(std::is_trivially_copyable_v<T>);

public:
    FixedEntryJournal(const std::string& path, size_t max_entries)
        : file_path_(path) {
        size_t size = max_entries * entrySize();
        fd_ = ::open(path.c_str(), O_RDWR | O_CREAT, 0644);
        if (fd_ < 0) throw std::system_error(errno, std::generic_category());

        if (::ftruncate(fd_, static_cast<off_t>(size)) < 0)
            throw std::system_error(errno, std::generic_category());

        map_ = static_cast<uint8_t*>(::mmap(
            nullptr, size, PROT_READ | PROT_WRITE,
            MAP_SHARED, fd_, 0));
        if (map_ == MAP_FAILED)
            throw std::system_error(errno, std::generic_category());

        ::close(fd_);
        fd_ = -1;
        max_entries_ = max_entries;
        count_ = 0;
    }

    ~FixedEntryJournal() {
        if (map_ && map_ != MAP_FAILED)
            ::munmap(map_, max_entries_ * entrySize());
    }

    bool append(uint64_t seq, const T& data) {
        if (count_ >= max_entries_) return false;
        size_t offset = count_ * entrySize();

        // Write sequence number + CRC + data atomically (via memcpy)
        std::memcpy(map_ + offset, &seq, sizeof(seq));
        uint32_t crc = CRC32C::compute(&data, sizeof(data));
        std::memcpy(map_ + offset + sizeof(seq), &crc, sizeof(crc));
        std::memcpy(map_ + offset + sizeof(seq) + sizeof(crc),
                    &data, sizeof(data));

        ++count_;
        return true;
    }

    bool read(size_t index, uint64_t& seq, T& data) const {
        if (index >= count_) return false;
        size_t offset = index * entrySize();

        std::memcpy(&seq, map_ + offset, sizeof(seq));
        uint32_t stored_crc;
        std::memcpy(&stored_crc, map_ + offset + sizeof(seq), sizeof(stored_crc));
        std::memcpy(&data, map_ + offset + sizeof(seq) + sizeof(stored_crc),
                    sizeof(T));

        uint32_t computed_crc = CRC32C::compute(&data, sizeof(T));
        return stored_crc == computed_crc;
    }

    size_t count() const { return count_; }
    size_t capacity() const { return max_entries_; }

private:
    std::string file_path_;
    int    fd_ = -1;
    uint8_t* map_ = nullptr;
    size_t max_entries_ = 0;
    size_t count_ = 0;

    static constexpr size_t entrySize() {
        return sizeof(uint64_t) + sizeof(uint32_t) + sizeof(T);
    }
};

// ---------------------------------------------------------------------------
// Anonymous mmap for large pre-allocated heap
// ---------------------------------------------------------------------------
class AnonymousHeap {
public:
    AnonymousHeap(size_t size)
        : size_(size) {
        ptr_ = ::mmap(nullptr, size_, PROT_READ | PROT_WRITE,
                      MAP_PRIVATE | MAP_ANONYMOUS | MAP_POPULATE,
                      -1, 0);
        if (ptr_ == MAP_FAILED)
            throw std::system_error(errno, std::generic_category());
    }

    ~AnonymousHeap() {
        if (ptr_ && ptr_ != MAP_FAILED)
            ::munmap(ptr_, size_);
    }

    template <typename T>
    T* alloc(size_t count = 1) {
        size_t bytes = count * sizeof(T);
        if (used_ + bytes > size_) return nullptr;
        T* result = reinterpret_cast<T*>(static_cast<uint8_t*>(ptr_) + used_);
        used_ += bytes;
        return result;
    }

    void reset() { used_ = 0; }

private:
    void*  ptr_ = nullptr;
    size_t size_;
    size_t used_ = 0;
};

void example() {
    MappedOrderJournal journal("/tmp/orders.jrn", 64 * 1024 * 1024);

    // Append some entries
    const char* payload = "{\"symbol\":\"AAPL\",\"qty\":100}";
    journal.append(payload, std::strlen(payload), 1, 1234567890);
    journal.commit();

    // Recover
    size_t recovered = journal.recover(
        [](const void* data, size_t len, uint8_t type, uint64_t ts) {
            (void)data; (void)len; (void)type; (void)ts;
        });

    (void)recovered;
}
```
