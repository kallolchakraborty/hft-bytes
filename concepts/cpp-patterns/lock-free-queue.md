---
type: reference
title: "Lock Free Queue"
description: "SPSC (single-producer single-consumer) queues are the simplest. MPMC (multiple-producer multiple-consumer) requires atomic CAS on"
tags: ["queue-dynamics"]
timestamp: "2026-06-27T03:06:09.408Z"
phase: 3
phaseName: "C++ Low-Latency Patterns"
category: "C++ Low-Latency Patterns"
subcategory: "cpp-patterns"
language: "cpp"
artifact-id: "ZHFT_LOCK_FREE_QUEUE"
---
## Key Learning Points

- SPSC (single-producer single-consumer) queues are the simplest
- MPMC (multiple-producer multiple-consumer) requires atomic CAS on
- Cache-line padding (alignas(64)) separates producer/consumer indices
- ABA problem: a pointer can change, then change back, fooling CAS.
- Memory ordering: SPSC needs only acquire/release; MPMC typically

## Usage

SPSCQueue<Order, 1024> queue;    // 1024-element SPSC
queue.push(Order{...});          // producer
Order o; bool ok = queue.pop(o); // consumer
MPMCQueue<Order, 1024> mpmc;     // 1024-element MPMC
mpmc.push(...);   mpmc.pop(...);

## Source Code

```cpp
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <new>
#include <type_traits>
#include <cassert>
#include <cstring>
#include <span>
#include <array>
#include <optional>

// ---------------------------------------------------------------------------
// Cache line size constant
// ---------------------------------------------------------------------------
constexpr size_t CACHE_LINE = 64;

// ---------------------------------------------------------------------------
// SPSC Queue (bounded ring buffer)
// Producer writes at head; consumer reads at tail.
// No CAS needed — only atomic loads/stores with ordering.
// ---------------------------------------------------------------------------
template <typename T, size_t Capacity>
    requires (Capacity > 0 && (Capacity & (Capacity - 1)) == 0)
class SPSCQueue {
    static_assert(Capacity > 1, "Capacity must be at least 2");
    static_assert((Capacity & (Capacity - 1)) == 0,
                  "Capacity must be power of 2");

    // Use a slot wrapper to handle non-trivial types safely
    struct Slot {
        alignas(CACHE_LINE) T data;
    };

public:
    SPSCQueue() : head_(0), tail_(0) {
        if constexpr (!std::is_trivially_constructible_v<T>) {
            for (auto& slot : buffer_)
                std::construct_at(&slot.data);
        }
    }

    ~SPSCQueue() {
        // Drain remaining items
        while (size() > 0) {
            T tmp;
            pop(tmp);
        }
        if constexpr (!std::is_trivially_destructible_v<T>) {
            for (auto& slot : buffer_)
                std::destroy_at(&slot.data);
        }
    }

    SPSCQueue(const SPSCQueue&) = delete;
    SPSCQueue& operator=(const SPSCQueue&) = delete;

    // Push by producer (single producer)
    template <typename U>
    bool push(U&& item) {
        size_t h = head_.load(std::memory_order_relaxed);
        size_t t = tail_.load(std::memory_order_acquire);
        size_t next_h = (h + 1) & mask_;

        if (next_h == t) [[unlikely]]
            return false;  // queue full

        // writer has exclusive access to slot h
        buffer_[h & mask_].data = std::forward<U>(item);
        head_.store(next_h, std::memory_order_release);
        return true;
    }

    // Pop by consumer (single consumer)
    bool pop(T& item) {
        size_t t = tail_.load(std::memory_order_relaxed);
        size_t h = head_.load(std::memory_order_acquire);

        if (t == h) [[unlikely]]
            return false;  // empty

        item = std::move(buffer_[t & mask_].data);
        tail_.store((t + 1) & mask_, std::memory_order_release);
        return true;
    }

    // Non-blocking peek (copy without consuming)
    std::optional<T> front() const {
        size_t t = tail_.load(std::memory_order_relaxed);
        size_t h = head_.load(std::memory_order_acquire);
        if (t == h) return std::nullopt;
        return buffer_[t & mask_].data;
    }

    size_t size() const {
        size_t h = head_.load(std::memory_order_relaxed);
        size_t t = tail_.load(std::memory_order_relaxed);
        return (h - t) & mask_full_;
    }

    bool empty() const { return size() == 0; }
    bool full() const {
        size_t h = head_.load(std::memory_order_relaxed);
        size_t t = tail_.load(std::memory_order_acquire);
        return ((h + 1) & mask_) == t;
    }

    static constexpr size_t capacity() { return Capacity; }

private:
    // Alignment: false-sharing isolation between producer and consumer indices
    alignas(CACHE_LINE) std::atomic<size_t> head_;  // producer writes here
    alignas(CACHE_LINE) std::atomic<size_t> tail_;  // consumer writes here
    alignas(CACHE_LINE) std::array<Slot, Capacity> buffer_;

    static constexpr size_t mask_     = Capacity - 1;
    static constexpr size_t mask_full_ = (Capacity << 1) - 1;  // for size calc
};

// ---------------------------------------------------------------------------
// MPMC Queue (bounded, multi-producer multi-consumer)
// Uses atomic CAS for concurrent slot claiming.
// Each slot has a sequence number to avoid ABA.
// ---------------------------------------------------------------------------
template <typename T, size_t Capacity>
    requires (Capacity > 0 && (Capacity & (Capacity - 1)) == 0)
class MPMCQueue {
    struct Slot {
        alignas(CACHE_LINE) std::atomic<size_t> sequence{0};
        T data;
    };

public:
    MPMCQueue() : enqueue_pos_(0), dequeue_pos_(0) {
        for (size_t i = 0; i < Capacity; ++i)
            buffer_[i].sequence.store(i, std::memory_order_relaxed);
    }

    ~MPMCQueue() {
        // Drain
        T tmp;
        while (pop(tmp));
    }

    MPMCQueue(const MPMCQueue&) = delete;
    MPMCQueue& operator=(const MPMCQueue&) = delete;

    template <typename U>
    bool push(U&& item) {
        size_t pos = enqueue_pos_.load(std::memory_order_relaxed);

        for (;;) {
            auto& slot = buffer_[pos & mask_];
            size_t seq = slot.sequence.load(std::memory_order_acquire);
            intptr_t diff = static_cast<intptr_t>(seq) -
                            static_cast<intptr_t>(pos);

            if (diff == 0) {
                // Slot is ours — try to claim
                if (enqueue_pos_.compare_exchange_weak(pos, pos + 1,
                        std::memory_order_relaxed)) {
                    // Successfully claimed position `pos`
                    slot.data = std::forward<U>(item);
                    slot.sequence.store(pos + 1, std::memory_order_release);
                    return true;
                }
                // CAS failed, another producer claimed it; retry
            } else if (diff < 0) {
                // Queue full
                return false;
            } else {
                // diff > 0: someone else is ahead, spin
                pos = enqueue_pos_.load(std::memory_order_relaxed);
            }
        }
    }

    bool pop(T& item) {
        size_t pos = dequeue_pos_.load(std::memory_order_relaxed);

        for (;;) {
            auto& slot = buffer_[pos & mask_];
            size_t seq = slot.sequence.load(std::memory_order_acquire);
            intptr_t diff = static_cast<intptr_t>(seq) -
                            static_cast<intptr_t>(pos + 1);

            if (diff == 0) {
                // Slot is ours to read
                if (dequeue_pos_.compare_exchange_weak(pos, pos + 1,
                        std::memory_order_relaxed)) {
                    item = std::move(slot.data);
                    slot.sequence.store(pos + Capacity,
                                        std::memory_order_release);
                    return true;
                }
            } else if (diff < 0) {
                // Queue empty
                return false;
            } else {
                pos = dequeue_pos_.load(std::memory_order_relaxed);
            }
        }
    }

    size_t size() const {
        size_t ep = enqueue_pos_.load(std::memory_order_relaxed);
        size_t dp = dequeue_pos_.load(std::memory_order_relaxed);
        return ep - dp;
    }

    bool empty() const { return size() == 0; }

private:
    alignas(CACHE_LINE) std::atomic<size_t> enqueue_pos_;
    alignas(CACHE_LINE) std::atomic<size_t> dequeue_pos_;
    alignas(CACHE_LINE) std::array<Slot, Capacity> buffer_;

    static constexpr size_t mask_ = Capacity - 1;
};

// ---------------------------------------------------------------------------
// Tagged pointer for ABA prevention (hazard-pointer alternative)
// ---------------------------------------------------------------------------
template <typename T>
class TaggedPointer {
    using TagType = uint64_t;
    struct alignas(16) Packed {
        T*    ptr;
        TagType tag;
    };

public:
    TaggedPointer() : ptr_(nullptr, 0) {}

    explicit TaggedPointer(T* p) : ptr_(p, nextTag(0)) {}

    T* loadPtr(std::memory_order order = std::memory_order_seq_cst) const {
        auto packed = ptr_.load(order);
        return packed.ptr;
    }

    bool compare_exchange(T*& expected, T* desired,
                           std::memory_order succ = std::memory_order_seq_cst,
                           std::memory_order fail = std::memory_order_seq_cst) {
        Packed exp{expected, 0};
        Packed des{desired, nextTag(exp.tag)};
        // Trick: need to get the current tag from the stored value
        auto cur = ptr_.load(std::memory_order_relaxed);
        exp.tag = cur.tag;
        des.tag = nextTag(cur.tag);

        bool result = ptr_.compare_exchange_strong(exp, des, succ, fail);
        if (!result) expected = exp.ptr;  // update expected on failure
        return result;
    }

private:
    std::atomic<Packed> ptr_;

    static TagType nextTag(TagType tag) {
        return (tag + 1) & ((1ULL << 48) - 1);
    }
};

// Ensure TaggedPointer is lock-free (should be on 64-bit)
static_assert(std::atomic<TaggedPointer<int>>::is_always_lock_free ||
              !"TaggedPointer not lock-free on this platform");

// ---------------------------------------------------------------------------
// Hazard Pointer (simplified) for safe memory reclamation
// ---------------------------------------------------------------------------
class HazardPointer {
public:
    void protect(const void* ptr) {
        ptr_.store(reinterpret_cast<uintptr_t>(ptr),
                   std::memory_order_release);
    }

    void unprotect() {
        ptr_.store(0, std::memory_order_release);
    }

    bool isProtected(const void* ptr) const {
        return ptr_.load(std::memory_order_acquire) ==
               reinterpret_cast<uintptr_t>(ptr);
    }

private:
    alignas(CACHE_LINE) std::atomic<uintptr_t> ptr_{0};
};

// ---------------------------------------------------------------------------
// Example
// ---------------------------------------------------------------------------
void example() {
    // SPSC
    SPSCQueue<int, 1024> spsc;
    spsc.push(42);
    int val;
    bool ok = spsc.pop(val);
    assert(ok && val == 42);

    // MPMC
    MPMCQueue<int, 256> mpmc;
    mpmc.push(1);
    mpmc.push(2);
    int a, b;
    mpmc.pop(a);
    mpmc.pop(b);
    assert(a == 1 && b == 2);
}
```
