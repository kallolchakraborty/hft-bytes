---
type: reference
title: "Compile Time"
description: "constexpr/consteval enables computation at compile time:. Template metaprogramming (TMP) performs type-level computation;"
tags: ["time-series"]
timestamp: "2026-06-27T03:06:09.406Z"
phase: 3
phaseName: "C++ Low-Latency Patterns"
category: "C++ Low-Latency Patterns"
subcategory: "cpp-patterns"
language: "cpp"
artifact-id: "ZHFT_COMPILE_TIME"
---
## Key Learning Points

- constexpr/consteval enables computation at compile time:
- Template metaprogramming (TMP) performs type-level computation;
- CRTP (Curiously Recurring Template Pattern) provides static
- Type traits + SFINAE (Substitution Failure Is Not An Error) or
- static_assert with meaningful messages catches configuration

## Usage

// constexpr latency table
constexpr double lat_ns = LatencyTable::lookup("NYSE", "FIX_4.2");
// CRTP: exchange protocol handler
struct NasdaqHandler : ProtocolHandler<NasdaqHandler> {
static constexpr const char* name = "NASDAQ_ITCH";
uint64_t parse(const uint8_t* msg) { ... }
};
// Concept-constrained order router
template <Exchange E> requires ExchangeConcept<E>
void route(Order& o) { E::send(o); }

## Source Code

```cpp
#include <cstdint>
#include <cstddef>
#include <array>
#include <string_view>
#include <type_traits>
#include <concepts>
#include <utility>
#include <algorithm>

// ---------------------------------------------------------------------------
// constexpr latency table (exchange → protocol → latency)
// ---------------------------------------------------------------------------
struct LatencyEntry {
    std::string_view exchange;
    std::string_view protocol;
    double           latency_ns;  // round-trip in nanoseconds
};

class LatencyTable {
public:
    static constexpr std::array<LatencyEntry, 6> table = {{
        {"NYSE",     "FIX_4.2",   7500.0},
        {"NYSE",     "NSC",       3200.0},
        {"NASDAQ",   "FIX_4.2",   8100.0},
        {"NASDAQ",   "ITCH_5.0",  1800.0},
        {"CME",      "FIX_4.4",   5600.0},
        {"CME",      "MDP_3.0",   1200.0},
    }};

    [[nodiscard]] static constexpr double lookup(
        std::string_view exchange, std::string_view protocol) {
        for (const auto& entry : table)
            if (entry.exchange == exchange && entry.protocol == protocol)
                return entry.latency_ns;
        return 999999.0;  // unknown
    }

    // Compile-time assertion that all entries are sorted (binary search ready)
    static_assert(table.size() > 0, "Latency table cannot be empty");
};

// Verify at compile time
static_assert(LatencyTable::lookup("NASDAQ", "ITCH_5.0") == 1800.0);
static_assert(LatencyTable::lookup("NYSE", "FIX_4.2") == 7500.0);

// ---------------------------------------------------------------------------
// constexpr order type dispatch (no runtime overhead)
// ---------------------------------------------------------------------------
enum class OrderType : uint8_t {
    Limit,
    Market,
    Stop,
    StopLimit,
    Peg,
    Iceberg
};

// Compile-time function to get order type name
[[nodiscard]] constexpr std::string_view orderTypeName(OrderType t) {
    switch (t) {
        case OrderType::Limit:     return "LIMIT";
        case OrderType::Market:    return "MARKET";
        case OrderType::Stop:      return "STOP";
        case OrderType::StopLimit: return "STOP_LIMIT";
        case OrderType::Peg:       return "PEG";
        case OrderType::Iceberg:   return "ICEBERG";
    }
    return "UNKNOWN";
}

static_assert(orderTypeName(OrderType::Limit)    == "LIMIT");
static_assert(orderTypeName(OrderType::Iceberg)  == "ICEBERG");

// ---------------------------------------------------------------------------
// CRTP: static polymorphism for exchange protocol handlers
// ---------------------------------------------------------------------------
template <typename Derived>
class ProtocolHandler {
public:
    // Static interface: Derived must implement parse() and serialize()
    uint64_t parseMessage(const uint8_t* msg, size_t len) {
        return static_cast<Derived*>(this)->parse(msg, len);
    }

    size_t serialize(uint64_t order_id, uint8_t* out, size_t cap) {
        return static_cast<Derived*>(this)->serialize(order_id, out, cap);
    }

    static constexpr std::string_view name() {
        return Derived::protocol_name;
    }

protected:
    ~ProtocolHandler() = default;
};

// Concrete implementations
struct FIXHandler : ProtocolHandler<FIXHandler> {
    static constexpr std::string_view protocol_name = "FIX_4.2";

    uint64_t parse(const uint8_t* msg, size_t len) {
        // Parse FIX message, extract order ID
        // (simplified)
        (void)msg;
        (void)len;
        return 42;
    }

    size_t serialize(uint64_t order_id, uint8_t* out, size_t cap) {
        (void)order_id; (void)out; (void)cap;
        return 0;
    }
};

struct ITCHHandler : ProtocolHandler<ITCHHandler> {
    static constexpr std::string_view protocol_name = "ITCH_5.0";

    uint64_t parse(const uint8_t* msg, size_t len) {
        (void)msg; (void)len;
        return 100;
    }

    size_t serialize(uint64_t order_id, uint8_t* out, size_t cap) {
        (void)order_id; (void)out; (void)cap;
        return 0;
    }
};

// ---------------------------------------------------------------------------
// C++20 Concepts for exchange protocols
// ---------------------------------------------------------------------------
template <typename T>
concept ExchangeProtocol = requires(T& handler,
                                    const uint8_t* msg,
                                    size_t len,
                                    uint64_t oid,
                                    uint8_t* out,
                                    size_t cap) {
    { T::protocol_name } -> std::convertible_to<std::string_view>;
    { handler.parse(msg, len) } -> std::same_as<uint64_t>;
    { handler.serialize(oid, out, cap) } -> std::same_as<size_t>;
};

static_assert(ExchangeProtocol<FIXHandler>);
static_assert(ExchangeProtocol<ITCHHandler>);

// Generic router constrained by concept
template <ExchangeProtocol P>
class OrderRouter {
public:
    void sendOrder(P& handler, uint64_t order_id,
                   uint8_t* buffer, size_t capacity) {
        size_t written = handler.serialize(order_id, buffer, capacity);
        // transmit...
        (void)written;
    }
};

// ---------------------------------------------------------------------------
// constexpr map via sorted array (compile-time key-value lookup)
// ---------------------------------------------------------------------------
template <typename Key, typename Value, size_t N>
class ConstexprMap {
public:
    struct Entry {
        Key   key;
        Value value;
    };

    constexpr ConstexprMap(const Entry (&entries)[N]) : entries_(entries) {
        // Sort at compile time (insertion sort for small N)
        for (size_t i = 1; i < N; ++i) {
            Entry tmp = entries_[i];
            size_t j = i;
            while (j > 0 && entries_[j - 1].key > tmp.key) {
                entries_[j] = entries_[j - 1];
                --j;
            }
            entries_[j] = tmp;
        }
    }

    [[nodiscard]] constexpr Value at(const Key& key) const {
        auto it = find(key);
        return (it != end()) ? it->value : Value{};
    }

    [[nodiscard]] constexpr bool contains(const Key& key) const {
        return find(key) != end();
    }

private:
    mutable Entry entries_[N];  // mutable for compile-time sort in ctor

    constexpr const Entry* begin() const { return entries_; }
    constexpr const Entry* end() const { return entries_ + N; }

    [[nodiscard]] constexpr const Entry* find(const Key& key) const {
        // Binary search (sorted)
        size_t lo = 0, hi = N;
        while (lo < hi) {
            size_t mid = lo + (hi - lo) / 2;
            if (entries_[mid].key < key)
                lo = mid + 1;
            else if (key < entries_[mid].key)
                hi = mid;
            else
                return &entries_[mid];
        }
        return end();
    }
};

// Usage
constexpr ConstexprMap<std::string_view, double, 3> fee_table({
    {"NYSE",    0.0003},
    {"NASDAQ",  0.00025},
    {"CME",     0.00035}
});

static_assert(fee_table.at("NYSE") == 0.0003);
static_assert(fee_table.contains("NASDAQ"));
static_assert(!fee_table.contains("LSE"));

// ---------------------------------------------------------------------------
// Template metaprogramming: type list and compile-time dispatch
// ---------------------------------------------------------------------------
template <typename... Ts>
struct TypeList {};

// Find index of a type in a TypeList
template <typename T, typename List>
struct IndexOf;

template <typename T, typename First, typename... Rest>
struct IndexOf<T, TypeList<First, Rest...>> {
    static constexpr size_t value = std::is_same_v<T, First>
        ? 0 : 1 + IndexOf<T, TypeList<Rest...>>::value;
};

template <typename T>
struct IndexOf<T, TypeList<>> {
    static constexpr size_t value = SIZE_MAX;
};

static_assert(IndexOf<int, TypeList<double, int, float>>::value == 1);
static_assert(IndexOf<char, TypeList<double, int, float>>::value == SIZE_MAX);

// ---------------------------------------------------------------------------
// SFINAE: enable_if for conditional overloads
// ---------------------------------------------------------------------------
template <typename T>
std::enable_if_t<std::is_integral_v<T>, double>
orderToPrice(T raw) {
    return static_cast<double>(raw) / 10000.0;  // fixed-point to decimal
}

template <typename T>
std::enable_if_t<std::is_floating_point_v<T>, double>
orderToPrice(T raw) {
    return raw;
}

static_assert(orderToPrice(100500) == 10.05);
static_assert(orderToPrice(10.05) == 10.05);

// ---------------------------------------------------------------------------
// Compile-time selection of exchange-specific order transformation
// ---------------------------------------------------------------------------
template <typename Exchange>
struct OrderTransform;

template <>
struct OrderTransform<struct NYSE> {
    static constexpr uint64_t transform(uint64_t raw) {
        return raw ^ 0xABCD;  // XOR obfuscation
    }
};

template <>
struct OrderTransform<struct NASDAQ> {
    static constexpr uint64_t transform(uint64_t raw) {
        return __builtin_bswap64(raw);  // byte swap
    }
};

// ---------------------------------------------------------------------------
// constexpr FIX tag lookup table (tag number → string)
// ---------------------------------------------------------------------------
struct FIXTagEntry {
    uint16_t    tag;
    std::string_view name;
};

class FIXTagTable {
public:
    static constexpr std::array<FIXTagEntry, 6> tags = {{
        {8,   "BeginString"},
        {35,  "MsgType"},
        {49,  "SenderCompID"},
        {56,  "TargetCompID"},
        {38,  "OrderQty"},
        {44,  "Price"},
    }};

    [[nodiscard]] static constexpr std::string_view lookup(uint16_t tag) {
        for (auto& t : tags)
            if (t.tag == tag) return t.name;
        return "UNKNOWN";
    }
};

static_assert(FIXTagTable::lookup(38) == "OrderQty");
static_assert(FIXTagTable::lookup(44) == "Price");

// ---------------------------------------------------------------------------
// Type traits for latency-critical alignment
// ---------------------------------------------------------------------------
template <typename T>
struct CacheAligned {
    using type = std::aligned_storage_t<sizeof(T), 64>;
};

template <typename T>
using CacheAlignedT = typename CacheAligned<T>::type;

// Verify
struct alignas(64) Order64 {
    uint64_t id;
    double price;
};
static_assert(sizeof(Order64) == 64);
static_assert(alignof(Order64) == 64);

// ---------------------------------------------------------------------------
// Example: complete compile-time dispatch
// ---------------------------------------------------------------------------
template <ExchangeProtocol P>
[[nodiscard]] constexpr double roundTripLatency() {
    return LatencyTable::lookup(P::protocol_name.substr(0, 4),
                                 P::protocol_name);
}

void example() {
    // CRTP dispatch (zero overhead)
    FIXHandler fix;
    ITCHHandler itch;

    uint64_t id1 = fix.parseMessage(nullptr, 0);
    uint64_t id2 = itch.parseMessage(nullptr, 0);
    (void)id1; (void)id2;

    // Concept-constrained router
    OrderRouter<FIXHandler> router;
    uint8_t buf[256];
    router.sendOrder(fix, 100, buf, sizeof(buf));

    // constexpr lookups
    constexpr double nasdaq_lat = roundTripLatency<ITCHHandler>();
    static_assert(nasdaq_lat > 0);
}
```
