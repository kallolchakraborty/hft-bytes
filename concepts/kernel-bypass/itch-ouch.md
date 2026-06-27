---
type: reference
title: "Itch Ouch"
description: "NASDAQ ITCH (market data) and OUCH (order entry) are binary. ITCH packet structure: a Unit Header (2 bytes msg_type, 2 bytes"
tags: ["exchange-protocols", "protocols"]
difficulty: advanced
timestamp: "2026-06-27T03:06:09.415Z"
phase: 5
phaseName: "Kernel Bypass & Protocols"
category: "Phase 5 - Kernel Bypass & Protocols"
subcategory: "kernel-bypass"
language: "cpp"
artifact-id: "ZHFT_ITCH_OUCH"
---
## Key Learning Points

- NASDAQ ITCH (market data) and OUCH (order entry) are binary
- ITCH packet structure: a Unit Header (2 bytes msg_type, 2 bytes
- OUCH is the order entry protocol: Enter Order (O), Replace (U),
- ITCH message types: System Event ('S'), Stock Trading Action ('H'),
- Parsing ITCH at line rate requires a message type dispatch table
- ITCH message grouping: multiple messages may be packed into a single
- Sequence numbers: ITCH has a session-level seq num in the packet

## Usage

```bash

g++ -O3 -std=c++20 ZHFT_ITCH_OUCH.txt -o itch_ouch
./itch_ouch < sample_itch.bin
```

## Source Code

```cpp
#include <algorithm>
#include <array>
#include <bit>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <iostream>
#include <span>
#include <string_view>
#include <vector>

// ====================================================================
// ITCH message type constants (NASDAQ TotalView-ITCH 5.0).
// ====================================================================
enum ItchMsgType : uint8_t {
    ITCH_SYSTEM_EVENT          = 'S',
    ITCH_STOCK_TRADING_ACTION  = 'H',
    ITCH_REG_SHO              = 'Y',
    ITCH_MWCB_DECLINE         = 'V',
    ITCH_MARKET_PART_STATE    = 'L',
    ITCH_ADD_ORDER            = 'A',     // non-displayable
    ITCH_ADD_ORDER_MPID       = 'F',
    ITCH_EXECUTED             = 'E',
    ITCH_EXECUTED_PRICE       = 'C',
    ITCH_CANCEL               = 'X',
    ITCH_DELETE               = 'D',
    ITCH_REPLACE              = 'U',
    ITCH_TRADE                = 'P',
    ITCH_TRADE_MPID           = 'Q',
};

// ====================================================================
// ITCH message structs (packed, no alignment padding).
// In production, these would be more complete.
// ====================================================================

#pragma pack(push, 1)

struct ItchSystemEvent {
    // msg_type 'S' is implied by context.
    uint8_t  msg_type;
    uint16_t stock_locate;
    uint16_t tracking_number;
    uint16_t timestamp_offset;       // nanoseconds from start of day
    uint8_t  event_code;
};
static_assert(sizeof(ItchSystemEvent) == 8);

struct ItchAddOrder {
    uint8_t  msg_type;               // 'A'
    uint16_t stock_locate;
    uint16_t tracking_number;
    uint16_t timestamp_offset;
    uint64_t order_ref;
    uint8_t  buy_sell_indicator;
    uint32_t shares;
    uint8_t  stock[8];               // padded
    uint32_t price;                  // fixed-point, 4 decimal places
};
static_assert(sizeof(ItchAddOrder) == 28);

struct ItchTrade {
    uint8_t  msg_type;               // 'P'
    uint16_t stock_locate;
    uint16_t tracking_number;
    uint16_t timestamp_offset;
    uint64_t order_ref;
    uint8_t  buy_sell_indicator;
    uint32_t shares;
    uint8_t  stock[8];
    uint32_t price;
    uint64_t match_number;
};
static_assert(sizeof(ItchTrade) == 36);

struct ItchCancel {
    uint8_t  msg_type;               // 'X'
    uint16_t stock_locate;
    uint16_t tracking_number;
    uint16_t timestamp_offset;
    uint64_t order_ref;
    uint32_t cancelled_shares;
};
static_assert(sizeof(ItchCancel) == 18);

#pragma pack(pop)

// ====================================================================
// ITCH message dispatch table.
// Each entry: bytes_to_skip (0 = unknown) + handler function.
// ====================================================================
struct ItchDispatchEntry {
    uint16_t                message_size;
    const char*             name;
};

// Handler type: processes a raw ITCH message at the given pointer.
using ItchHandler = void (*)(const uint8_t* msg);

// Dispatch table indexed by message type byte.
// Unknown types map to size 0.
static constexpr int kItchTableSize = 256;
static std::array<ItchDispatchEntry, kItchTableSize> MakeItchDispatchTable() {
    std::array<ItchDispatchEntry, kItchTableSize> table{};
    auto add = [&](uint8_t type, uint16_t size, const char* name) {
        table[type] = {size, name};
    };
    add(ITCH_SYSTEM_EVENT,         sizeof(ItchSystemEvent),  "SystemEvent");
    add(ITCH_ADD_ORDER,            sizeof(ItchAddOrder),     "AddOrder");
    add(ITCH_TRADE,                sizeof(ItchTrade),        "Trade");
    add(ITCH_CANCEL,               sizeof(ItchCancel),       "Cancel");
    // ... more entries for all message types.
    return table;
}
static constexpr auto kItchDispatch = MakeItchDispatchTable();

// ====================================================================
// ITCH parser: reads a buffer containing one or more messages.
// ====================================================================
class ItchParser {
public:
    explicit ItchParser(std::span<const uint8_t> buf) : buf_{buf}, pos_{0} {}

    // Iterate over all messages in the buffer.
    // Returns false when the buffer is fully consumed.
    struct Message {
        std::span<const uint8_t> raw;       // full message bytes
        uint8_t                  type;      // first byte
        const ItchDispatchEntry* entry;     // dispatch info
    };

    auto Next() -> std::optional<Message> {
        if (pos_ >= buf_.size()) return std::nullopt;

        const uint8_t* start = buf_.data() + pos_;
        uint8_t type = start[0];
        const auto& entry = kItchDispatch[type];
        if (entry.message_size == 0) {
            // Unknown type — skip 1 byte and continue.
            // In production, log the error and the raw bytes.
            pos_ += 1;
            return Next();      // skip unknown
        }
        if (pos_ + entry.message_size > buf_.size()) {
            // Truncated message — stop.
            return std::nullopt;
        }
        Message msg;
        msg.raw   = buf_.subspan(pos_, entry.message_size);
        msg.type  = type;
        msg.entry = &entry;
        pos_ += entry.message_size;
        return msg;
    }

private:
    std::span<const uint8_t> buf_;
    std::size_t              pos_ = 0;
};

// ====================================================================
// OUCH order entry message types.
// ====================================================================
enum OuchMsgType : uint8_t {
    OUCH_ENTER_ORDER      = 'O',
    OUCH_ENTER_ORDER_EXT  = 'T',
    OUCH_REPLACE_ORDER    = 'U',
    OUCH_CANCEL_ORDER     = 'X',
    OUCH_ACCEPTED         = 'A',
    OUCH_REJECTED         = 'J',
    OUCH_CANCELED         = 'C',
    OUCH_REPLACED         = 'R',
    OUCH_BROKEN_TRADE     = 'B',
    OUCH_FILL             = 'P',
};

// OUCH Enter Order message.
#pragma pack(push, 1)
struct OuchEnterOrder {
    uint8_t  msg_type;             // 'O'
    uint8_t  order_token[14];      // client-assigned identifier
    uint8_t  buy_sell;
    uint32_t shares;
    uint8_t  stock[8];
    uint32_t price;
    uint16_t time_in_force;
    uint8_t  firm_id[4];
    uint8_t  display_indicator;
    uint8_t  capacity;
    uint8_t  minimum_qty;
    uint16_t cross_id;
    uint8_t  customer_firm_flag;
};
static_assert(sizeof(OuchEnterOrder) == 41);
#pragma pack(pop)

// ====================================================================
// OUCH order builder: constructs raw OUCH messages in a buffer.
// ====================================================================
class OuchOrderBuilder {
public:
    explicit OuchOrderBuilder(std::span<uint8_t> buf) : buf_{buf} {}

    auto BuildEnterOrder(const char* token, char side, uint32_t shares,
                         const char* symbol, uint32_t price) -> std::span<const uint8_t> {
        auto* msg = reinterpret_cast<OuchEnterOrder*>(buf_.data());
        std::memset(msg, 0, sizeof(OuchEnterOrder));
        msg->msg_type = OUCH_ENTER_ORDER;
        std::memcpy(msg->order_token, token, std::min(std::strlen(token), size_t{14}));
        msg->buy_sell = (side == 'B') ? 'B' : 'S';
        msg->shares   = shares;
        std::memcpy(msg->stock, symbol, std::min(std::strlen(symbol), size_t{8}));
        msg->price    = price;
        // ... fill remaining fields.
        return {buf_.data(), sizeof(OuchEnterOrder)};
    }

private:
    std::span<uint8_t> buf_;
};

// ====================================================================
// Benchmark: parse 1M ITCH messages from synthetic data.
// ====================================================================
auto main() -> int {
    // Generate synthetic ITCH data: alternating add / cancel / trade.
    std::vector<uint8_t> data;
    data.reserve(1'000'000 * sizeof(ItchAddOrder));

    for (int i = 0; i < 200'000; ++i) {
        ItchAddOrder add{};
        add.msg_type = ITCH_ADD_ORDER;
        add.order_ref = i;
        add.price     = 100000000;   // $100.0000
        add.shares    = 100;
        std::memcpy(add.stock, "AAPL    ", 8);
        auto* bytes = reinterpret_cast<const uint8_t*>(&add);
        data.insert(data.end(), bytes, bytes + sizeof(add));

        ItchCancel del{};
        del.msg_type = ITCH_CANCEL;
        del.order_ref = i;
        del.cancelled_shares = 50;
        bytes = reinterpret_cast<const uint8_t*>(&del);
        data.insert(data.end(), bytes, bytes + sizeof(del));

        ItchTrade trd{};
        trd.msg_type = ITCH_TRADE;
        trd.order_ref = i;
        trd.price = 100050000;
        trd.shares = 25;
        bytes = reinterpret_cast<const uint8_t*>(&trd);
        data.insert(data.end(), bytes, bytes + sizeof(trd));
    }

    std::cout << "=== ITCH/OUCH Protocol Parsing ===\n\n";
    std::cout << "Synthetic data size: " << data.size() << " bytes ("
              << (data.size() / sizeof(ItchAddOrder)) << " msgs approx)\n\n";

    // Warm up (parse once).
    ItchParser warmup{data};
    int warmup_count = 0;
    while (warmup.Next()) ++warmup_count;
    std::cout << "Messages parsed (warmup): " << warmup_count << "\n\n";

    // Benchmark: parse 10 times.
    constexpr int kRuns = 10;
    auto t0 = std::chrono::steady_clock::now();
    int total_msgs = 0;
    for (int run = 0; run < kRuns; ++run) {
        ItchParser parser{data};
        int count = 0;
        while (parser.Next()) ++count;
        total_msgs += count;
    }
    auto t1 = std::chrono::steady_clock::now();
    auto ns = std::chrono::duration_cast<std::chrono::nanoseconds>(t1 - t0).count();

    std::cout << "Benchmark (" << kRuns << " runs):\n";
    std::cout << "  Total msgs: " << total_msgs << "\n";
    std::cout << "  Avg time/msg: " << (ns / total_msgs) << " ns\n";
    std::cout << "  Throughput: " << (static_cast<double>(total_msgs) * 1e9 / ns)
              << " msg/s\n\n";

    std::cout << "=== Dispatch Table ===\n";
    std::cout << "Type  Size  Name\n";
    std::cout << "----------------\n";
    for (int i = 0; i < kItchTableSize; ++i) {
        if (kItchDispatch[i].message_size > 0) {
            std::cout << static_cast<char>(i) << "     "
                      << kItchDispatch[i].message_size << "    "
                      << kItchDispatch[i].name << "\n";
        }
    }

    std::cout << "\n=== OUCH Order Builder ===\n";
    std::array<uint8_t, 256> ouch_buf{};
    OuchOrderBuilder builder{ouch_buf};
    auto ouch_msg = builder.BuildEnterOrder("TOKEN001", 'B', 100, "AAPL", 100000000);
    std::cout << "Built OUCH Enter Order: " << ouch_msg.size() << " bytes\n";

    return 0;
}
```
