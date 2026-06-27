---
type: reference
title: "Eurex T7"
description: "EBS (Enhanced Broadcast Solution): market data publish-subscribe.. Packet structure: SBE header (8 bytes: BlockLength, TemplateID,"
tags: ["phase-8"]
timestamp: "2026-06-27T03:06:09.429Z"
phase: 8
phaseName: "Exchange Architecture"
category: "Phase 8 - Exchange Architecture"
subcategory: "exchange-architecture"
language: "cpp"
artifact-id: "ZHFT_EUREX_T7"
---
## Key Learning Points

- EBS (Enhanced Broadcast Solution): market data publish-subscribe.
- Packet structure: SBE header (8 bytes: BlockLength, TemplateID,
- Nanosecond timestamps: TransactTime field is nanoseconds since
- Mass quote: only for market makers. Max leg count: 50 per quote
- Session recovery: Eurex uses sequence numbers per message stream.
- Enter order / modify order / delete order / mass cancel: all

## Usage

// T7Session t7;
// t7.connect("10.0.0.2", 9200);
// t7.login("user", "pass");
// t7.enterOrder({...});
// auto exec = t7.receive();

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
// T7 SBE message header
// ---------------------------------------------------------------------------
struct alignas(8) T7SbeHeader {
  uint16_t block_length;
  uint16_t template_id;
  uint16_t schema_id;
  uint16_t version;
};

static_assert(sizeof(T7SbeHeader) == 8);

// ---------------------------------------------------------------------------
// Key T7 message templates
// ---------------------------------------------------------------------------

// Logon (template 100)
struct alignas(8) T7LogonRequest {
  static constexpr uint16_t kTemplateId = 100;
  T7SbeHeader header{40, kTemplateId, 1, 0};
  char    username[20];
  char    password_hash[32]; // SHA-256 hash
  uint8_t session_mode;      // 0=normal, 1=recovery
  uint64_t request_time;
};

// Enter New Order (template 1002)
struct alignas(8) T7EnterOrder {
  static constexpr uint16_t kTemplateId = 1002;
  T7SbeHeader header{56, kTemplateId, 1, 0};
  char     cl_ord_id[20];
  uint64_t order_id;         // 0 = exchange assigns
  char     symbol[12];
  uint64_t quantity;
  uint64_t display_qty;      // Iceberg: displayed portion
  uint64_t min_qty;          // Minimum acceptable fill qty
  double   price;            // 0 for market order
  double   stop_price;       // 0 if not stop
  uint8_t  side;             // 1=buy, 2=sell
  uint8_t  ord_type;         // 1=market, 2=limit, 3=stop, 4=stop_limit
  uint8_t  time_in_force;    // 0=day, 1=GTC, 3=IOC, 4=FOK, 6=GTD
  uint64_t transact_time;    // Nanoseconds since epoch
  uint32_t maturity_date;    // For futures (YYYYMMDD packed)
  uint8_t  cancel_on_disconnect; // 0=no, 1=yes
};

// Modify Order (template 1003)
struct alignas(8) T7ModifyOrder {
  static constexpr uint16_t kTemplateId = 1003;
  T7SbeHeader header{40, kTemplateId, 1, 0};
  uint64_t order_id;
  uint64_t quantity;
  uint64_t display_qty;
  double   price;
  double   stop_price;
  uint8_t  time_in_force;
  uint64_t transact_time;
};

// Delete Order (template 1004)
struct alignas(8) T7DeleteOrder {
  static constexpr uint16_t kTemplateId = 1004;
  T7SbeHeader header{16, kTemplateId, 1, 0};
  uint64_t order_id;
  uint64_t transact_time;
};

// Mass Cancel (template 1005)
struct alignas(8) T7MassCancel {
  static constexpr uint16_t kTemplateId = 1005;
  T7SbeHeader header{24, kTemplateId, 1, 0};
  uint8_t  cancel_type; // 0=symbol, 1=side, 2=all, 3=strategy
  char     symbol[12];  // empty if cancel_type=2
  uint8_t  side;        // 0=both, 1=buy, 2=sell
  uint64_t transact_time;
};

// ---------------------------------------------------------------------------
// T7 Session
// ---------------------------------------------------------------------------
class T7Session {
public:
  void connect(const char *host, uint16_t port) {
    // TCP connect with TCP_NODELAY, SO_KEEPALIVE
  }

  void login(const char *user, const char *password) {
    T7LogonRequest req;
    std::memcpy(req.username, user, std::min(strlen(user), size_t(19)));
    // SHA-256 password hash
    req.request_time = getNanoseconds();
    send(reinterpret_cast<const uint8_t *>(&req), sizeof(req));
  }

  void enterOrder(const T7EnterOrder &ord) {
    send(reinterpret_cast<const uint8_t *>(&ord), sizeof(ord));
  }

  void modifyOrder(const T7ModifyOrder &mod) {
    send(reinterpret_cast<const uint8_t *>(&mod), sizeof(mod));
  }

  void deleteOrder(uint64_t order_id) {
    T7DeleteOrder del;
    del.order_id = order_id;
    del.transact_time = getNanoseconds();
    send(reinterpret_cast<const uint8_t *>(&del), sizeof(del));
  }

  void massCancel(uint8_t type, std::string_view symbol = {}) {
    T7MassCancel mc;
    mc.cancel_type = type;
    if (!symbol.empty())
      std::memcpy(mc.symbol, symbol.data(), std::min(symbol.size(), size_t(11)));
    mc.transact_time = getNanoseconds();
    send(reinterpret_cast<const uint8_t *>(&mc), sizeof(mc));
  }

private:
  int fd_ = -1;
  uint64_t seq_ = 1;

  void send(const uint8_t *data, size_t len) {
    // Write with sequence number tracking
    // TRADEOFF: use writev() for zero-copy when combining
    // header + body from non-contiguous memory
    ::write(fd_, data, len);
  }

  static uint64_t getNanoseconds() {
    struct timespec ts;
    ::clock_gettime(CLOCK_REALTIME, &ts);
    return ts.tv_sec * 1'000'000'000ULL + ts.tv_nsec;
  }
};
```
