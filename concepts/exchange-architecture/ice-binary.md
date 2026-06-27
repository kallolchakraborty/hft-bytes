---
type: reference
title: "Ice Binary"
description: "ICE binary message format: fixed-length header (16 bytes) with. Message types: Login (0x01), LoginAccepted (0x02), NewOrder (0x10),"
tags: ["protocols"]
timestamp: "2026-06-27T03:06:09.431Z"
phase: 8
phaseName: "Exchange Architecture"
category: "Phase 8 - Exchange Architecture"
subcategory: "exchange-architecture"
language: "cpp"
artifact-id: "ZHFT_ICE_BINARY"
---
## Key Learning Points

- ICE binary message format: fixed-length header (16 bytes) with
- Message types: Login (0x01), LoginAccepted (0x02), NewOrder (0x10),
- Sequence numbers: per-session, incremental. Gap detection uses
- Block trades: negotiated off-screen, reported to ICE via
- EFRP (Exchange for Related Positions): physical vs futures
- Recovery: on reconnect, send RetransmitRequest with start seq;

## Usage

// IceBinarySession ice;
// ice.login("user", "pass");
// ice.newOrder("CL", Side::BUY, 1000, 75.50);
// auto msg = ice.receive();

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
// ICE binary header
// ---------------------------------------------------------------------------
struct alignas(8) IceBinaryHeader {
  uint16_t message_length;  // Total length including header
  uint8_t  message_type;    // 0x01-0x31
  uint8_t  flags;           // Bit 0: retransmission, Bit 1: poss_dup
  uint32_t sequence_number;
  uint32_t session_id;
};

static_assert(sizeof(IceBinaryHeader) == 16);

// ---------------------------------------------------------------------------
// ICE message types
// ---------------------------------------------------------------------------
enum IceMsgType : uint8_t {
  ICE_LOGIN            = 0x01,
  ICE_LOGIN_ACCEPTED   = 0x02,
  ICE_LOGIN_REJECTED   = 0x03,
  ICE_LOGOUT           = 0x05,
  ICE_HEARTBEAT        = 0x06,
  ICE_NEW_ORDER        = 0x10,
  ICE_ORDER_ACCEPTED   = 0x11,
  ICE_ORDER_REJECTED   = 0x12,
  ICE_FILL             = 0x13,
  ICE_CANCEL           = 0x14,
  ICE_CANCEL_REJECTED  = 0x15,
  ICE_ORDER_STATUS     = 0x16,
  ICE_RETRANSMIT_REQ   = 0x20,
  ICE_RETRANSMIT_REPLY = 0x21,
  ICE_BLOCK_TRADE      = 0x30,
  ICE_EFRP             = 0x31,
};

// ---------------------------------------------------------------------------
// Message bodies (fixed layout)
// ---------------------------------------------------------------------------
struct IceLoginBody {
  char username[20];
  char password_hash[32];
  uint32_t session_id; // 0 for initial login
};

struct IceNewOrderBody {
  char     cl_ord_id[20];
  char     symbol[8];
  uint32_t quantity;
  double   price;
  uint8_t  side;      // 1=buy, 2=sell
  uint8_t  ord_type;  // 1=market, 2=limit
  uint8_t  tif;       // 0=day, 3=IOC, 4=FOK
};

struct IceFillBody {
  char     exec_id[20];
  char     cl_ord_id[20];
  uint64_t order_id;
  uint32_t fill_qty;
  double   fill_price;
  uint8_t  side;
  uint32_t remaining_qty;
};

struct IceBlockTradeBody {
  char     block_id[20];
  char     symbol[8];
  uint32_t quantity;
  double   price;
  uint8_t  side;
  char     counterparty[20];
  uint64_t trade_time;
};

struct IceRetransmitRequestBody {
  uint32_t from_seq;
  uint32_t to_seq; // 0 = all
};

// ---------------------------------------------------------------------------
// ICE binary session
// ---------------------------------------------------------------------------
class IceBinarySession {
public:
  bool login(const char *user, const char *pass) {
    uint8_t buf[sizeof(IceBinaryHeader) + sizeof(IceLoginBody)];
    auto &hdr = *reinterpret_cast<IceBinaryHeader *>(buf);
    hdr.message_length = sizeof(buf);
    hdr.message_type = ICE_LOGIN;
    hdr.flags = 0;
    hdr.sequence_number = seq_++;
    hdr.session_id = 0;

    auto &body = *reinterpret_cast<IceLoginBody *>(buf + sizeof(IceBinaryHeader));
    std::memset(&body, 0, sizeof(body));
    std::strncpy(body.username, user, 19);
    // In production: SHA-256 hash password
    std::strncpy(body.password_hash, pass, 31);

    return send(buf, sizeof(buf));
  }

  void newOrder(std::string_view symbol, uint8_t side,
                uint32_t qty, double price) {
    uint8_t buf[sizeof(IceBinaryHeader) + sizeof(IceNewOrderBody)];
    auto &hdr = *reinterpret_cast<IceBinaryHeader *>(buf);
    hdr.message_length = sizeof(buf);
    hdr.message_type = ICE_NEW_ORDER;
    hdr.flags = 0;
    hdr.sequence_number = seq_++;
    hdr.session_id = session_id_;

    auto &body = *reinterpret_cast<IceNewOrderBody *>(buf + sizeof(IceBinaryHeader));
    std::memset(&body, 0, sizeof(body));
    std::strncpy(body.symbol, symbol.data(), 7);
    body.side = side;
    body.quantity = qty;
    body.price = price;
    body.ord_type = 2;
    body.tif = 0;

    send(buf, sizeof(buf));
  }

  // Message dispatch
  void onReceive(std::span<const uint8_t> data) {
    const auto &hdr = *reinterpret_cast<const IceBinaryHeader *>(data.data());

    // Sequence number check
    if (hdr.sequence_number != expected_seq_) {
      // Gap detected
      requestRetransmit(expected_seq_, 0);
      return;
    }
    expected_seq_ = hdr.sequence_number + 1;

    // Check retransmission flag
    bool is_retransmission = (hdr.flags & 0x01);
    if (is_retransmission) {
      // CRITICAL: check if we already processed this message
      if (processed_seq_.count(hdr.sequence_number)) return;
      processed_seq_.insert(hdr.sequence_number);
    }

    switch (hdr.message_type) {
    case ICE_LOGIN_ACCEPTED:
      session_id_ = hdr.session_id;
      state_ = 1; // logged in
      break;
    case ICE_HEARTBEAT:
      break;
    case ICE_ORDER_ACCEPTED:
      // route to OMS
      break;
    case ICE_FILL:
      handleFill(data);
      break;
    case ICE_RETRANSMIT_REPLY:
      handleRetransmitReply(data);
      break;
    case ICE_LOGOUT:
      state_ = 0;
      break;
    }
  }

  void requestRetransmit(uint32_t from, uint32_t to) {
    uint8_t buf[sizeof(IceBinaryHeader) + sizeof(IceRetransmitRequestBody)];
    auto &hdr = *reinterpret_cast<IceBinaryHeader *>(buf);
    hdr.message_length = sizeof(buf);
    hdr.message_type = ICE_RETRANSMIT_REQ;
    hdr.sequence_number = seq_++;
    hdr.session_id = session_id_;

    auto &body = *reinterpret_cast<IceRetransmitRequestBody *>(
        buf + sizeof(IceBinaryHeader));
    body.from_seq = from;
    body.to_seq = to;

    send(buf, sizeof(buf));
  }

private:
  int fd_ = -1;
  uint64_t seq_ = 1;
  uint64_t expected_seq_ = 1;
  uint32_t session_id_ = 0;
  uint8_t state_ = 0; // 0=disconnected, 1=logged in
  std::unordered_set<uint64_t> processed_seq_;

  bool send(const uint8_t *data, size_t len) {
    return ::write(fd_, data, len) > 0;
  }

  void handleFill(std::span<const uint8_t> data) {
    const auto &fill = *reinterpret_cast<const IceFillBody *>(
        data.data() + sizeof(IceBinaryHeader));
    // route fill to OMS
  }

  void handleRetransmitReply(std::span<const uint8_t> data) {
    // Contains one or more retransmitted messages
    // Process each, marking as retransmitted (skip duplicate check)
  }
};
```
