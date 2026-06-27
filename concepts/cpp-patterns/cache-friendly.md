---
type: reference
title: "Cache Friendly"
description: "AoS (Array of Structs) iterates poorly when only some fields are. Hot/cold splitting separates frequently-accessed fields (price,"
tags: ["cache-coherency"]
difficulty: intermediate
timestamp: "2026-06-27T03:06:09.405Z"
phase: 3
phaseName: "C++ Low-Latency Patterns"
category: "C++ Low-Latency Patterns"
subcategory: "cpp-patterns"
language: "cpp"
artifact-id: "ZHFT_CACHE_FRIENDLY"
---
## Key Learning Points

- AoS (Array of Structs) iterates poorly when only some fields are
- Hot/cold splitting separates frequently-accessed fields (price,
- Intrusive containers eliminate per-element allocation overhead
- Prefetching (__builtin_prefetch) hides DRAM latency (~100ns) by
- Branch prediction hints (__builtin_expect, [[likely]]/[[unlikely]])

## Usage

```bash

SoA layout
```
struct OrderBookSoA {
std::vector<double> price;
std::vector<uint32_t> qty;
// ... side, type stored separately
};
// Hot/cold split
struct OrderHot   { double price; uint32_t qty; uint8_t side; };
struct OrderCold  { uint64_t id; uint64_t ts; char cl_ord_id[20]; };

## Source Code

```cpp
#include <vector>
#include <cstdint>
#include <cstddef>
#include <cstring>
#include <algorithm>
#include <span>
#include <numeric>
#include <cassert>
#include <iostream>

// ---------------------------------------------------------------------------
// AoS (Array of Structs) — baseline layout
// ---------------------------------------------------------------------------
struct OrderAoS {
    uint64_t order_id;
    uint64_t timestamp;
    double   price;
    uint32_t qty;
    uint8_t  side;    // 0=buy, 1=sell
    uint8_t  type;    // 0=limit, 1=market
    char     cl_ord_id[20];
    double   stop_price;
    uint32_t exec_qty;
    double   avg_price;
    uint8_t  status;
    uint8_t  padding[7]{};
};

static_assert(sizeof(OrderAoS) == 88);

// ---------------------------------------------------------------------------
// SoA (Struct of Arrays) — cache-optimized layout
// ---------------------------------------------------------------------------
struct OrderBookSoA {
    std::vector<double>   price;
    std::vector<uint32_t> qty;
    std::vector<uint8_t>  side;
    std::vector<uint8_t>  type;
    // Cold fields are stored separately or only when needed
    std::vector<uint64_t> order_id;
    std::vector<uint64_t> timestamp;

    size_t size() const { return price.size(); }

    void reserve(size_t n) {
        price.reserve(n); qty.reserve(n); side.reserve(n);
        type.reserve(n); order_id.reserve(n); timestamp.reserve(n);
    }

    void addOrder(double p, uint32_t q, uint8_t s, uint8_t t,
                  uint64_t id, uint64_t ts) {
        price.push_back(p);
        qty.push_back(q);
        side.push_back(s);
        type.push_back(t);
        order_id.push_back(id);
        timestamp.push_back(ts);
    }
};

// ---------------------------------------------------------------------------
// Benchmark: sum all prices in AoS vs SoA
// ---------------------------------------------------------------------------
template <typename Func>
double benchmark(size_t iterations, Func f) {
    auto start = __builtin_ia32_rdtsc();
    for (size_t i = 0; i < iterations; ++i)
        f();
    auto end = __builtin_ia32_rdtsc();
    return static_cast<double>(end - start) / iterations;
}

double sumAoS(std::span<const OrderAoS> orders) {
    double sum = 0;
    for (auto& o : orders)
        sum += o.price;
    return sum;
}

double sumSoA(const OrderBookSoA& book) {
    double sum = 0;
    for (auto p : book.price)
        sum += p;
    return sum;
}

// ---------------------------------------------------------------------------
// Hot/Cold split
// ---------------------------------------------------------------------------
// Hot: accessed on every order book update
struct alignas(64) OrderHot {
    double   price;
    uint32_t qty;
    uint8_t  side;
    uint8_t  type;
    uint16_t padding;  // fill to 16 bytes
};
static_assert(sizeof(OrderHot) == 16);

// Cold: accessed only during trade reporting or audit
struct OrderCold {
    uint64_t order_id;
    uint64_t timestamp;
    uint64_t fill_time;
    double   avg_price;
    uint32_t exec_qty;
    char     cl_ord_id[20];
    char     trader_id[8];
};

// Combined split storage
class OrderBookSplit {
public:
    OrderHot*  hot  = nullptr;
    OrderCold* cold = nullptr;
    size_t     cap  = 0;
    size_t     len  = 0;

    void init(size_t capacity) {
        cap = capacity;
        hot  = static_cast<OrderHot*>(
            std::aligned_alloc(64, capacity * sizeof(OrderHot)));
        cold = static_cast<OrderCold*>(
            std::aligned_alloc(64, capacity * sizeof(OrderCold)));
        if (!hot || !cold) throw std::bad_alloc();
    }

    void add(const OrderHot& h, const OrderCold& c) {
        hot[len]  = h;
        cold[len] = c;
        ++len;
    }

    // Fast iteration over hot fields only
    double sumHotPrices() const {
        double s = 0;
        for (size_t i = 0; i < len; ++i)
            s += hot[i].price;
        return s;
    }

    ~OrderBookSplit() {
        std::free(hot);
        std::free(cold);
    }
};

// ---------------------------------------------------------------------------
// Intrusive container (intrusive singly-linked list)
// ---------------------------------------------------------------------------
struct IntrusiveOrder : OrderHot {
    IntrusiveOrder* next = nullptr;
    IntrusiveOrder* prev = nullptr;

    // No separate allocation needed for container links
};

class IntrusiveOrderList {
public:
    void push_front(IntrusiveOrder* o) {
        o->next = head_;
        o->prev = nullptr;
        if (head_) head_->prev = o;
        head_ = o;
    }

    void remove(IntrusiveOrder* o) {
        if (o->prev) o->prev->next = o->next;
        else head_ = o->next;
        if (o->next) o->next->prev = o->prev;
    }

    IntrusiveOrder* front() const { return head_; }

private:
    IntrusiveOrder* head_ = nullptr;
};

// ---------------------------------------------------------------------------
// Prefetching helper
// ---------------------------------------------------------------------------
void prefetchRange(const void* addr, size_t count, size_t stride = 64) {
    const char* p = static_cast<const char*>(addr);
    for (size_t i = 0; i < count; ++i) {
        __builtin_prefetch(p + i * stride, 0, 3);  // read, high locality
    }
}

// ---------------------------------------------------------------------------
// Branch prediction hints
// ---------------------------------------------------------------------------
inline bool likely(bool x)  { return __builtin_expect(x, 1); }
inline bool unlikely(bool x) { return __builtin_expect(x, 0); }

// Usage in hot path:
double conditionalSum(std::span<const OrderAoS> orders, bool use_advanced) {
    double sum = 0;
    for (auto& o : orders) {
        if (likely(o.side == 0)) {  // most orders are buys
            sum += o.price;
        } else {
            sum -= o.price;
        }
        if (unlikely(use_advanced)) {
            sum += o.stop_price * 0.01;  // rare path
        }
    }
    return sum;
}

// ---------------------------------------------------------------------------
// Data-oriented design: process hot fields, then cold fields in batch
// ---------------------------------------------------------------------------
class DataOrientedProcessor {
public:
    struct HotFrame {
        double price;
        uint32_t qty;
        uint8_t  side;
    };

    struct ColdFrame {
        uint64_t timestamp;
        double   avg_exec_price;
    };

    // Batch process: first pass on hot, second pass on cold
    void processBatch(std::span<const HotFrame> hot,
                      std::span<const ColdFrame> cold) {
        // Pass 1: only hot data (fits in L1 ~32KB = 2048 * 16)
        for (auto& h : hot) {
            // process price action
            (void)h.price;
        }

        // Pass 2: only cold data (cache-cold, but we prefetch)
        for (size_t i = 0; i < cold.size(); i += 4) {
            __builtin_prefetch(&cold[i + 8], 0, 1);
            (void)cold[i].timestamp;
        }
    }
};

// ---------------------------------------------------------------------------
// Example
// ---------------------------------------------------------------------------
void example() {
    // Compare AoS vs SoA
    std::vector<OrderAoS> aos(1000000);
    OrderBookSoA soa;
    soa.reserve(1000000);

    // Fill with same data...
    for (size_t i = 0; i < 1000000; ++i) {
        aos[i] = {uint64_t(i), uint64_t(i), double(i) * 0.01,
                  uint32_t(i * 10), 0, 0, {}, 0.0, 0, 0.0, 0, {}};
        soa.addOrder(double(i) * 0.01, uint32_t(i * 10), 0, 0,
                     uint64_t(i), uint64_t(i));
    }

    // Hot split storage
    OrderBookSplit split;
    split.init(1000000);
    for (size_t i = 0; i < 1000000; ++i) {
        split.add(OrderHot{double(i) * 0.01, uint32_t(i * 10), 0, 0},
                  OrderCold{uint64_t(i), uint64_t(i), 0, 0.0, 0, {}, {}});
    }

    // Branch prediction
    double result = conditionalSum(aos, false);
    (void)result;
}
```
