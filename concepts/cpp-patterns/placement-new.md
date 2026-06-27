---
type: reference
title: "Placement New"
description: "Placement new constructs an object in pre-allocated memory,. Object pooling reuses fixed-size slots to eliminate malloc/free"
tags: ["phase-3"]
difficulty: intermediate
timestamp: "2026-06-27T03:06:09.409Z"
phase: 3
phaseName: "C++ Low-Latency Patterns"
category: "C++ Low-Latency Patterns"
subcategory: "cpp-patterns"
language: "cpp"
artifact-id: "ZHFT_PLACEMENT_NEW"
---
## Key Learning Points

- Placement new constructs an object in pre-allocated memory,
- Object pooling reuses fixed-size slots to eliminate malloc/free
- Free list management: allocate by popping from linked list of
- Lock-free free list enables concurrent object recycling without
- Timestamp-based reuse: track when a slot was last freed and

## Usage

OrderPool pool(4096);  // pool of 4096 Order objects
Order* o = pool.create(1, 100.50, 200, Side::Buy);
pool.destroy(o);       // destructor + return to pool
// Lock-free version (concurrent producers)
LockFreeOrderPool lf_pool(4096);
Order* o2 = lf_pool.create(...);
lf_pool.destroy(o2);

## Source Code

```cpp
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <new>
#include <atomic>
#include <chrono>
#include <cassert>
#include <bit>

// ---------------------------------------------------------------------------
// Example Order type (trivial for maximum speed)
// ---------------------------------------------------------------------------
struct alignas(64) Order {
    uint64_t order_id;
    double   price;
    uint32_t qty;
    uint8_t  side;   // 0=buy, 1=sell
    uint8_t  type;   // 0=limit, 1=market

    Order() = default;

    Order(uint64_t id, double px, uint32_t q, uint8_t s, uint8_t t)
        : order_id(id), price(px), qty(q), side(s), type(t) {}
};

// ---------------------------------------------------------------------------
// Object Pool with free list (lock-free for single-producer scenarios)
// ---------------------------------------------------------------------------
template <typename T>
class ObjectPool {
    static_assert(sizeof(T) >= sizeof(void*),
                  "Minimum object size must fit a pointer");

    union Slot {
        Slot* next;   // free list linkage
        T     obj;    // actual object (constructed via placement new)
        Slot() : next(nullptr) {}
    };

public:
    explicit ObjectPool(size_t capacity)
        : capacity_(capacity), storage_(nullptr), free_head_(nullptr) {

        storage_ = static_cast<Slot*>(alignedAlloc(alignof(Slot),
                    capacity_ * sizeof(Slot)));
        if (!storage_) throw std::bad_alloc();

        // Build free list: chain all slots
        for (size_t i = 0; i < capacity_; ++i) {
            storage_[i].next = free_head_;
            free_head_ = &storage_[i];
        }
    }

    ~ObjectPool() {
        // Destroy all live objects (iterate and call destructor if needed)
        // In a real pool, you'd track allocated slots; for simplicity
        // we assume all are returned before destruction.
        std::free(storage_);
    }

    ObjectPool(const ObjectPool&) = delete;
    ObjectPool& operator=(const ObjectPool&) = delete;

    // Construct an object in pooled memory
    template <typename... Args>
    T* create(Args&&... args) {
        Slot* slot = free_head_;
        if (!slot) return nullptr;  // pool exhausted

        free_head_ = slot->next;
        T* obj = ::new (&slot->obj) T(std::forward<Args>(args)...);
        return obj;
    }

    // Destruct and return to pool
    void destroy(T* obj) {
        obj->~T();
        Slot* slot = reinterpret_cast<Slot*>(obj);
        slot->next = free_head_;
        free_head_ = slot;
    }

    size_t capacity() const { return capacity_; }
    size_t available() const {
        size_t count = 0;
        Slot* cur = free_head_;
        while (cur) { ++count; cur = cur->next; }
        return count;
    }

private:
    size_t capacity_;
    Slot*  storage_;
    Slot*  free_head_;

    static void* alignedAlloc(size_t align, size_t size) {
        void* ptr = nullptr;
        if (posix_memalign(&ptr, align, size) != 0)
            throw std::bad_alloc();
        return ptr;
    }
};

// ---------------------------------------------------------------------------
// Lock-Free Object Pool (concurrent create/destroy)
// Uses atomic tagged pointer for ABA protection
// ---------------------------------------------------------------------------
template <typename T>
class LockFreeObjectPool {
    union Slot {
        std::atomic<Slot*> next;
        T obj;
        Slot() : next(nullptr) {}
    };

    struct alignas(16) TaggedHead {
        Slot*  ptr;
        size_t tag;
    };

public:
    explicit LockFreeObjectPool(size_t capacity)
        : storage_(nullptr), head_{nullptr, 0} {
        auto* raw = static_cast<Slot*>(alignedAlloc(alignof(Slot),
                    capacity * sizeof(Slot)));
        storage_ = raw;

        // Build free list
        Slot* cur = nullptr;
        for (size_t i = 0; i < capacity; ++i) {
            raw[i].next.store(cur, std::memory_order_relaxed);
            cur = &raw[i];
        }
        head_.ptr = cur;
        head_.tag = 0;
    }

    ~LockFreeObjectPool() {
        std::free(storage_);
    }

    template <typename... Args>
    T* create(Args&&... args) {
        TaggedHead old_head = head_.load(std::memory_order_acquire);
        TaggedHead new_head;

        for (;;) {
            if (!old_head.ptr) return nullptr;

            new_head.ptr = old_head.ptr->next.load(std::memory_order_relaxed);
            new_head.tag = old_head.tag + 1;

            if (head_.compare_exchange_weak(old_head, new_head,
                    std::memory_order_acq_rel, std::memory_order_relaxed))
                break;
        }

        return ::new (&old_head.ptr->obj) T(std::forward<Args>(args)...);
    }

    void destroy(T* obj) {
        obj->~T();
        Slot* slot = reinterpret_cast<Slot*>(obj);
        TaggedHead old_head = head_.load(std::memory_order_acquire);
        TaggedHead new_head;

        for (;;) {
            slot->next.store(old_head.ptr, std::memory_order_relaxed);
            new_head.ptr = slot;
            new_head.tag = old_head.tag + 1;

            if (head_.compare_exchange_weak(old_head, new_head,
                    std::memory_order_acq_rel, std::memory_order_relaxed))
                break;
        }
    }

private:
    Slot* storage_;
    std::atomic<TaggedHead> head_;

    static void* alignedAlloc(size_t align, size_t size) {
        void* ptr = nullptr;
        if (posix_memalign(&ptr, align, size) != 0)
            throw std::bad_alloc();
        return ptr;
    }
};

// ---------------------------------------------------------------------------
// Ring Buffer of Objects (pre-allocated, circular reuse)
// ---------------------------------------------------------------------------
template <typename T, size_t Capacity>
class RingObjectBuffer {
public:
    RingObjectBuffer() : head_(0), tail_(0) {
        for (size_t i = 0; i < Capacity; ++i)
            ::new (&buffer_[i]) T();
    }

    ~RingObjectBuffer() {
        for (size_t i = 0; i < Capacity; ++i)
            buffer_[i].~T();
    }

    template <typename... Args>
    T* next(Args&&... args) {
        size_t idx = head_.load(std::memory_order_relaxed);
        size_t next_idx = (idx + 1) % Capacity;

        if (next_idx == tail_.load(std::memory_order_acquire))
            return nullptr;  // full

        T* obj = &buffer_[idx];
        // Destroy old state, reconstruct in-place
        obj->~T();
        ::new (obj) T(std::forward<Args>(args)...);

        head_.store(next_idx, std::memory_order_release);
        return obj;
    }

    void advance() {
        // Consumer signals done with oldest slot
        tail_.store((tail_.load(std::memory_order_relaxed) + 1) % Capacity,
                     std::memory_order_release);
    }

    bool empty() const {
        return head_.load(std::memory_order_acquire) ==
               tail_.load(std::memory_order_acquire);
    }

private:
    alignas(64) std::atomic<size_t> head_{0};
    alignas(64) std::atomic<size_t> tail_{0};
    T buffer_[Capacity];
};

// ---------------------------------------------------------------------------
// Timestamp-based reuse guard
// ---------------------------------------------------------------------------
class TimestampGuard {
public:
    void markFreed() {
        freed_at_ = currentTime();
    }

    bool canReuse(uint64_t min_age_ns = 100) const {
        if (freed_at_ == 0) return true;  // never used
        return (currentTime() - freed_at_) >= min_age_ns;
    }

private:
    uint64_t freed_at_ = 0;

    static uint64_t currentTime() {
        return std::chrono::steady_clock::now()
               .time_since_epoch().count();
    }
};

// ---------------------------------------------------------------------------
// Usage example
// ---------------------------------------------------------------------------
void example() {
    // Basic pool
    ObjectPool<Order> pool(1024);

    Order* o = pool.create(1, 100.50, 200, 0, 0);
    assert(o != nullptr);
    pool.destroy(o);

    // Lock-free pool
    LockFreeObjectPool<Order> lf_pool(1024);
    Order* o2 = lf_pool.create(2, 99.50, 100, 1, 0);
    lf_pool.destroy(o2);

    // Ring buffer
    RingObjectBuffer<Order, 256> ring;
    Order* o3 = ring.next(3, 101.0, 500, 0, 0);
    ring.advance();

    (void)o3;
}
```
