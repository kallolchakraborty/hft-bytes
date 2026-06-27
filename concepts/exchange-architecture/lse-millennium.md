---
type: reference
title: "Lse Millennium"
description: "Millennium Gateway protocol: LSE's binary order entry protocol.. Instrument identification: MIC (Market Identifier Code, e.g., XLON)"
tags: ["phase-8"]
difficulty: intermediate
timestamp: "2026-06-27T03:06:09.431Z"
phase: 8
phaseName: "Exchange Architecture"
category: "Phase 8 - Exchange Architecture"
subcategory: "exchange-architecture"
language: "cpp"
artifact-id: "ZHFT_LSE_MILLENNIUM"
---
## Key Learning Points

- Millennium Gateway protocol: LSE's binary order entry protocol.
- Instrument identification: MIC (Market Identifier Code, e.g., XLON)
- Message structure: FIX-like tag-value but over TCP with length
- Order types: Limit, Market, Iceberg, Pegged (Midpoint, Primary),
- Session management: standard FIX session logon (35=A) with

## Usage

```bash

MillenniumSession ses;
ses.connect("10.0.0.3", 9300);
ses.logon("user", "pass");
ses.enterOrder("VOD.L", Side::BUY, 10000, 150.25, false);
auto exec = ses.receive();
```

## Source Code

```cpp
#include <algorithm>
#include <bit>
#include <cstdint>
#include <cstring>
#include <span>
#include <string_view>
#include <vector>

// ---------------------------------------------------------------------------
// Millennium Gateway header
// ---------------------------------------------------------------------------
struct MillenniumHeader {
  uint32_t message_length;  // Total length including header
  uint16_t message_type;    // Millennium-specific msg type code
  uint16_t segment_id;      // 0=SETS, 1=SETqx, 2=AIM, etc.
};

static_assert(sizeof(MillenniumHeader) == 8);

// ---------------------------------------------------------------------------
// Message type codes
// ---------------------------------------------------------------------------
enum MillenniumMsgType : uint16_t {
  MM_LOGON           = 0x0101,
  MM_LOGON_ACK       = 0x0102,
  MM_NEW_ORDER       = 0x0201,
  MM_ORDER_ACK       = 0x0202,
  MM_ORDER_REJECT    = 0x0203,
  MM_FILL            = 0x0204,
  MM_CANCEL          = 0x0205,
  MM_CANCEL_REJECT   = 0x0206,
  MM_REPLACE         = 0x0207,
  MM_REPLACE_ACK     = 0x0208,
  MM_TRADE_CANCEL    = 0x0209,
  MM_HEARTBEAT       = 0x0301,
  MM_LOGOUT          = 0x0302,
  MM_NEWS            = 0x0401,
};

// ---------------------------------------------------------------------------
// Millennium New Order
// ---------------------------------------------------------------------------
struct MillenniumNewOrder {
  char     cl_ord_id[20];       // Client order ID
  char     instrument[20];      // Mnemonic (e.g., "VOD")
  char     sedol[7];            // SEDOL code
  uint8_t  side;                // 1=buy, 2=sell
  uint64_t quantity;
  uint64_t display_quantity;    // Iceberg: visible portion (0 = full)
  double   price;               // 0 = market order
  double   stop_price;          // 0 = not stop
  uint8_t  order_type;          // 1=market, 2=limit, 3=iceberg, 4=pegged
  uint8_t  time_in_force;       // 0=day, 1=GTC, 3=IOC, 4=FOK
  uint8_t  peg_type;            // 0=none, 1=midpoint, 2=primary, 3=last
  uint8_t  peg_offset;          // Offset from peg in ticks
  uint8_t  anonymous;           // 0=display firm, 1=anonymous
  uint8_t  cancel_on_disconnect;// 0=no, 1=yes
  uint64_t transact_time;       // Nanoseconds since epoch
};

static_assert(sizeof(MillenniumNewOrder) == 96);

// ---------------------------------------------------------------------------
// Millennium Fill
// ---------------------------------------------------------------------------
struct MillenniumFill {
  char     exec_id[20];
  char     cl_ord_id[20];
  uint64_t order_id;
  uint32_t fill_quantity;
  double   fill_price;
  uint8_t  side;
  uint32_t remaining_quantity;
  uint8_t  liquidity_flag;  // 1=maker, 2=taker, 3=auction
  uint64_t transact_time;
};

static_assert(sizeof(MillenniumFill) == 72);

// ---------------------------------------------------------------------------
// Millennium message builder
// ---------------------------------------------------------------------------
class MillenniumMessageBuilder {
public:
  static std::vector<uint8_t> buildNewOrder(const MillenniumNewOrder &ord) {
    std::vector<uint8_t> buf(sizeof(MillenniumHeader) + sizeof(MillenniumNewOrder));

    auto &hdr = *reinterpret_cast<MillenniumHeader *>(buf.data());
    hdr.message_length = static_cast<uint32_t>(buf.size());
    hdr.message_type = MM_NEW_ORDER;
    hdr.segment_id = 0; // SETS

    auto *body = reinterpret_cast<MillenniumNewOrder *>(
        buf.data() + sizeof(MillenniumHeader));
    std::memcpy(body, &ord, sizeof(MillenniumNewOrder));

    return buf;
  }

  static MillenniumNewOrder parseNewOrder(std::span<const uint8_t> data) {
    MillenniumNewOrder ord;
    std::memcpy(&ord, data.data() + sizeof(MillenniumHeader),
                sizeof(MillenniumNewOrder));
    return ord;
  }
};

// ---------------------------------------------------------------------------
// Millennium parser
// ---------------------------------------------------------------------------
class MillenniumParser {
public:
  // Feed raw TCP data; returns parsed messages
  std::vector<uint16_t> feed(std::span<const uint8_t> data) {
    std::vector<uint16_t> types;
    size_t offset = 0;
    while (offset + sizeof(MillenniumHeader) <= data.size()) {
      const auto &hdr = *reinterpret_cast<const MillenniumHeader *>(
          data.data() + offset);
      if (offset + hdr.message_length > data.size()) break; // incomplete

      dispatch(hdr, data.subspan(offset, hdr.message_length));
      types.push_back(hdr.message_type);

      offset += hdr.message_length;
    }
    return types;
  }

private:
  void dispatch(const MillenniumHeader &hdr, std::span<const uint8_t> msg) {
    switch (hdr.message_type) {
    case MM_FILL: {
      auto &fill = *reinterpret_cast<const MillenniumFill *>(
          msg.data() + sizeof(MillenniumHeader));
      // route to OMS
      (void)fill;
      break;
    }
    // ... other message types
    default: break;
    }
  }
};
```
