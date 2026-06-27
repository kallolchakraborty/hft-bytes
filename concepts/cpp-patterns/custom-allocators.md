---
type: reference
title: "Custom Allocators"
description: "Arena (bump) allocator: single pointer bump, no per-object free,. Pool allocator: fixed-size blocks, free list recycles nodes"
tags: ["memory-management"]
timestamp: "2026-06-27T03:06:09.407Z"
phase: 3
phaseName: "C++ Low-Latency Patterns"
category: "C++ Low-Latency Patterns"
subcategory: "cpp-patterns"
language: "cpp"
artifact-id: "ZHFT_CUSTOM_ALLOCATORS"
---
## Key Learning Points

- Arena (bump) allocator: single pointer bump, no per-object free,
- Pool allocator: fixed-size blocks, free list recycles nodes
- Region allocator: multiple arenas with nested lifetimes; supports
- Stack allocator: LIFO with marker-based rollback; useful for
- Slab allocator: per-size-class pools for variable-sized objects

## Usage

Arena arena(1 << 20);   // 1 MB arena
int* p = arena.allocate<int>(100);  // aligned
arena.reset();          // frees all at once
PoolAllocator<Order> pool(1024);   // pool of 1024 Orders
Order* o = pool.allocate("AAPL", 100, Side::Buy);
pool.deallocate(o);

## Source Code

```cpp
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <new>
#include <stdexcept>
#include <cassert>
#include <atomic>
#include <vector>
#include <type_traits>
#include <bit>

// ---------------------------------------------------------------------------
// Arena (Bump) Allocator — linear allocation, no deallocation
// ---------------------------------------------------------------------------
class ArenaAllocator {
public:
    explicit ArenaAllocator(size_t capacity)
        : capacity_(capacity) {
        // Align to cache line for false-sharing avoidance
        size_t align = 64;
        size_t alloc_size = capacity_ + align;
        raw_ = static_cast<std::byte*>(std::aligned_alloc(align, alloc_size));
        if (!raw_) throw std::bad_alloc();
        ptr_ = raw_;
        end_ = raw_ + capacity_;
    }

    ~ArenaAllocator() {
        std::free(raw_);
    }

    ArenaAllocator(const ArenaAllocator&) = delete;
    ArenaAllocator& operator=(const ArenaAllocator&) = delete;

    ArenaAllocator(ArenaAllocator&& other) noexcept
        : raw_(other.raw_), ptr_(other.ptr_), end_(other.end_),
          capacity_(other.capacity_) {
        other.raw_ = nullptr;
        other.ptr_ = nullptr;
        other.end_ = nullptr;
        other.capacity_ = 0;
    }

    // Allocate with alignment (default: alignof(max_align_t))
    void* allocate(size_t size, size_t alignment = alignof(std::max_align_t)) {
        // Align ptr_ up
        uintptr_t current = reinterpret_cast<uintptr_t>(ptr_);
        uintptr_t misalign = current & (alignment - 1);
        uintptr_t adjust = (misalign == 0) ? 0 : alignment - misalign;
        uintptr_t aligned = current + adjust;

        if (aligned + size > reinterpret_cast<uintptr_t>(end_))
            throw std::bad_alloc();

        ptr_ = reinterpret_cast<std::byte*>(aligned + size);
        return reinterpret_cast<void*>(aligned);
    }

    template <typename T>
    T* allocate(size_t count = 1) {
        return static_cast<T*>(allocate(count * sizeof(T), alignof(T)));
    }

    // Reset (free all).  Does NOT call destructors.
    void reset() {
        ptr_ = raw_;
    }

    size_t used() const {
        return static_cast<size_t>(ptr_ - raw_);
    }

    size_t capacity() const { return capacity_; }
    size_t remaining() const { return capacity_ - used(); }

private:
    std::byte* raw_;
    std::byte* ptr_;
    std::byte* end_;
    size_t capacity_;
};

// ---------------------------------------------------------------------------
// Pool Allocator — fixed-size object pool with free list
// ---------------------------------------------------------------------------
template <typename T>
class PoolAllocator {
    static_assert(sizeof(T) >= sizeof(void*),
                  "Object too small; free list node needs pointer space");

    struct Node {
        Node* next;
    };

public:
    explicit PoolAllocator(size_t capacity)
        : capacity_(capacity), free_head_(nullptr),
          storage_(nullptr), block_size_(sizeof(T)) {
        // Allocate contiguous block
        storage_ = static_cast<std::byte*>(std::aligned_alloc(
            alignof(T), capacity_ * block_size_));
        if (!storage_) throw std::bad_alloc();

        // Initialize free list
        char* p = reinterpret_cast<char*>(storage_);
        for (size_t i = 0; i < capacity_; ++i) {
            Node* node = reinterpret_cast<Node*>(p + i * block_size_);
            node->next = free_head_;
            free_head_ = node;
        }
    }

    ~PoolAllocator() {
        std::free(storage_);
    }

    PoolAllocator(const PoolAllocator&) = delete;
    PoolAllocator& operator=(const PoolAllocator&) = delete;

    // Construct an object in pooled memory
    template <typename... Args>
    T* allocate(Args&&... args) {
        Node* node = free_head_;
        if (!node) return nullptr;  // pool exhausted

        free_head_ = node->next;
        T* obj = reinterpret_cast<T*>(node);
        ::new (obj) T(std::forward<Args>(args)...);
        return obj;
    }

    // Destruct and return to pool
    void deallocate(T* obj) {
        obj->~T();
        Node* node = reinterpret_cast<Node*>(obj);
        node->next = free_head_;
        free_head_ = node;
    }

    size_t capacity() const { return capacity_; }
    size_t available() const {
        size_t count = 0;
        Node* cur = free_head_;
        while (cur) { ++count; cur = cur->next; }
        return count;
    }

private:
    size_t capacity_;
    Node* free_head_;
    std::byte* storage_;
    size_t block_size_;
};

// ---------------------------------------------------------------------------
// Lock-Free Free List (for concurrent pool)
// ---------------------------------------------------------------------------
class LockFreeFreeList {
    struct Node {
        std::atomic<Node*> next{nullptr};
    };

public:
    void push(Node* node) {
        Node* expected = head_.load(std::memory_order_relaxed);
        do {
            node->next.store(expected, std::memory_order_relaxed);
        } while (!head_.compare_exchange_weak(expected, node,
                 std::memory_order_release, std::memory_order_relaxed));
    }

    Node* pop() {
        Node* expected = head_.load(std::memory_order_acquire);
        while (expected) {
            Node* next = expected->next.load(std::memory_order_relaxed);
            if (head_.compare_exchange_weak(expected, next,
                    std::memory_order_acquire, std::memory_order_relaxed))
                return expected;
        }
        return nullptr;
    }

private:
    std::atomic<Node*> head_{nullptr};
};

// ---------------------------------------------------------------------------
// Stack Allocator — LIFO with marker
// ---------------------------------------------------------------------------
class StackAllocator {
public:
    explicit StackAllocator(size_t capacity)
        : capacity_(capacity) {
        raw_ = static_cast<std::byte*>(std::aligned_alloc(64, capacity_));
        if (!raw_) throw std::bad_alloc();
        ptr_ = raw_;
    }

    ~StackAllocator() { std::free(raw_); }

    using Marker = size_t;

    Marker getMarker() const {
        return static_cast<size_t>(ptr_ - raw_);
    }

    void freeToMarker(Marker marker) {
        ptr_ = raw_ + marker;
    }

    void* alloc(size_t size, size_t align = alignof(std::max_align_t)) {
        uintptr_t p = reinterpret_cast<uintptr_t>(ptr_);
        uintptr_t misalign = p & (align - 1);
        uintptr_t adjusted = p + ((misalign == 0) ? 0 : align - misalign);
        if (adjusted + size > reinterpret_cast<uintptr_t>(raw_ + capacity_))
            throw std::bad_alloc();
        ptr_ = reinterpret_cast<std::byte*>(adjusted + size);
        return reinterpret_cast<void*>(adjusted);
    }

    template <typename T>
    T* alloc(size_t count = 1) {
        return static_cast<T*>(alloc(count * sizeof(T), alignof(T)));
    }

    void reset() { ptr_ = raw_; }

private:
    std::byte* raw_;
    std::byte* ptr_;
    size_t capacity_;
};

// ---------------------------------------------------------------------------
// Region Allocator — multiple nested arenas
// ---------------------------------------------------------------------------
class RegionAllocator {
    struct Region {
        std::byte* raw;
        std::byte* ptr;
        std::byte* end;
    };

public:
    explicit RegionAllocator(size_t region_capacity)
        : region_capacity_(region_capacity) {}

    ~RegionAllocator() {
        for (auto& r : regions_) std::free(r.raw);
    }

    void* allocate(size_t size, size_t align = alignof(std::max_align_t)) {
        if (regions_.empty() || !hasSpace(regions_.back(), size, align))
            newRegion();

        Region& r = regions_.back();
        uintptr_t p = reinterpret_cast<uintptr_t>(r.ptr);
        uintptr_t misalign = p & (align - 1);
        uintptr_t adjusted = p + ((misalign == 0) ? 0 : align - misalign);
        r.ptr = reinterpret_cast<std::byte*>(adjusted + size);
        return reinterpret_cast<void*>(adjusted);
    }

    template <typename T>
    T* allocate(size_t count = 1) {
        return static_cast<T*>(allocate(count * sizeof(T), alignof(T)));
    }

    void reset() {
        for (auto& r : regions_) r.ptr = r.raw;
    }

    void clear() {
        for (auto& r : regions_) std::free(r.raw);
        regions_.clear();
    }

private:
    size_t region_capacity_;
    std::vector<Region> regions_;

    bool hasSpace(const Region& r, size_t size, size_t align) {
        uintptr_t p = reinterpret_cast<uintptr_t>(r.ptr);
        uintptr_t adj = (p + align - 1) & ~(align - 1);
        return adj + size <= reinterpret_cast<uintptr_t>(r.end);
    }

    void newRegion() {
        auto* raw = static_cast<std::byte*>(
            std::aligned_alloc(64, region_capacity_));
        if (!raw) throw std::bad_alloc();
        regions_.push_back({raw, raw, raw + region_capacity_});
    }
};

// ---------------------------------------------------------------------------
// Benchmark helper (compile-time selection)
// ---------------------------------------------------------------------------
template <typename Alloc>
struct AllocatorBenchmark {
    static double measureAllocation(Alloc& alloc, size_t count,
                                    size_t obj_size) {
        auto start = __builtin_ia32_rdtsc();
        for (size_t i = 0; i < count; ++i)
            alloc.allocate(obj_size);
        auto end = __builtin_ia32_rdtsc();
        return static_cast<double>(end - start) / count;
    }
};

// ---------------------------------------------------------------------------
// Usage example: Order objects with pool allocator
// ---------------------------------------------------------------------------
struct alignas(64) Order {
    uint64_t order_id;
    uint64_t timestamp;
    double   price;
    uint32_t qty;
    uint8_t  side;   // 0=buy, 1=sell
    uint8_t  type;   // 0=limit, 1=market

    Order(uint64_t id, uint64_t ts, double px, uint32_t q,
          uint8_t s, uint8_t t)
        : order_id(id), timestamp(ts), price(px), qty(q),
          side(s), type(t) {}
};

void example() {
    // Arena — batch allocation
    ArenaAllocator arena(65536);
    double* prices = arena.allocate<double>(1000);
    Order* orders = arena.allocate<Order>(10);

    // Pool — fixed-size object cache
    PoolAllocator<Order> order_pool(256);
    Order* o1 = order_pool.allocate(1, 100, 99.50, 200, 0, 0);
    Order* o2 = order_pool.allocate(2, 101, 99.51, 100, 1, 0);
    order_pool.deallocate(o1);
    order_pool.deallocate(o2);

    // Stack — temporary computation
    StackAllocator stack(4096);
    auto marker = stack.getMarker();
    double* tmp = stack.alloc<double>(500);
    // ... use tmp ...
    stack.freeToMarker(marker);  // rollback

    // Region — multi-scope
    RegionAllocator region(65536);
    int* a = region.allocate<int>(100);
    // do something
    region.reset();
}
```
