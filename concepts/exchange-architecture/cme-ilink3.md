---
type: reference
title: "Cme Ilink3"
description: "SBE (Simple Binary Encoding) schema: message templates defined. Packet structure: SBE header (8 bytes: BlockLength, TemplateID,"
tags: ["phase-8"]
timestamp: "2026-06-27T03:06:09.429Z"
phase: 8
phaseName: "Exchange Architecture"
category: "Phase 8 - Exchange Architecture"
subcategory: "exchange-architecture"
language: "cpp"
artifact-id: "ZHFT_CME_iLINK3"
---
## Key Learning Points

- SBE (Simple Binary Encoding) schema: message templates defined
- Packet structure: SBE header (8 bytes: BlockLength, TemplateID,
- Session login: encrypted variant uses RSA-encrypted session key
- Sequencing: per-session sequence numbers (tag 34 in iLink FIX),
- Retransmission: GapFill messages (template 1102) fill seq gaps;
- Mass quote: template 1012 (MassQuote), up to 5-10 legs per quote.
- Tag 9726 (SecurityReqID): used in SecurityDefinitionRequest for

## Usage

// ILink3Session session;
// session.login(encrypted_key);
// session.sendMassQuote(quotes);
// auto fills = session.recv();

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
// SBE message header (iLink 3)
// ---------------------------------------------------------------------------
struct alignas(8) ILink3SbeHeader {
  uint16_t block_length;    // Body length
  uint16_t template_id;     // Message type
  uint16_t schema_id;       // Schema version
  uint16_t version;
};

static_assert(sizeof(ILink3SbeHeader) == 8);

// ---------------------------------------------------------------------------
// iLink 3 message templates (simplified)
// ---------------------------------------------------------------------------
struct alignas(8) ILink3LoginRequest {
  static constexpr uint16_t kTemplateId = 100;

  ILink3SbeHeader header{kTemplateId, kTemplateId, 1, 0};
  char username[20];
  char password[20];
  uint64_t request_timestamp; // nanoseconds since epoch
  uint8_t  encrypted;         // 0 = plain, 1 = RSA encrypted
};

struct alignas(8) ILink3LoginResponse {
  static constexpr uint16_t kTemplateId = 101;

  ILink3SbeHeader header{32, kTemplateId, 1, 0};
  char     session_id[16];
  uint64_t server_timestamp;
  uint32_t heartbeat_interval_ms;
  uint8_t  status; // 0=success
};

struct alignas(8) ILink3NewOrder {
  static constexpr uint16_t kTemplateId = 200;

  ILink3SbeHeader header{48, kTemplateId, 1, 0};
  char     cl_ord_id[20];
  char     symbol[8];
  uint64_t quantity;
  double   price;
  uint8_t  side;         // 1=buy, 2=sell
  uint8_t  ord_type;     // 2=limit, 1=market
  uint8_t  time_in_force;// 0=day, 3=IOC, 4=FOK
  uint64_t transact_time;
};

struct alignas(8) ILink3MassQuote {
  static constexpr uint16_t kTemplateId = 1012;

  ILink3SbeHeader header{64, kTemplateId, 1, 0};
  char     quote_req_id[20];
  uint32_t num_legs;       // 1-10
  uint64_t transact_time;
  // Repeating group of legs follows
};

struct ILink3MassQuoteLeg {
  char     symbol[8];
  uint64_t bid_qty;
  double   bid_price;
  uint64_t ask_qty;
  double   ask_price;
};

// ---------------------------------------------------------------------------
// iLink 3 session
// ---------------------------------------------------------------------------
class ILink3Session {
public:
  void login(const uint8_t *rsa_key, size_t key_len) {
    // Encrypted login: RSA-encrypt credentials with CME's public key
    ILink3LoginRequest req;
    // ... build and send
  }

  std::vector<uint8_t> encodeNewOrder(const ILink3NewOrder &ord) {
    std::vector<uint8_t> buf(sizeof(ILink3SbeHeader) + 48);
    std::memcpy(buf.data(), &ord, sizeof(ord));
    // TRADEOFF: SBE encode is a memcpy — no serialization overhead.
    // But schema changes require recompilation.
    return buf;
  }

  ILink3NewOrder decodeNewOrder(std::span<const uint8_t> data) {
    ILink3NewOrder ord;
    std::memcpy(&ord, data.data(), sizeof(ILink3NewOrder));
    return ord;
  }

  void sendMassQuote(const std::vector<ILink3MassQuoteLeg> &legs) {
    ILink3MassQuote quote;
    quote.num_legs = static_cast<uint32_t>(legs.size());
    // Encode header + repeating group
    // CRITICAL: mass quotes have strict rate limits — ~1 per 100us
  }

private:
  int fd_ = -1;
  uint64_t seq_send_ = 1;

  // SBE encoding: direct memory write to pre-allocated buffer
  // No field validation at encode time — schema checks at compile time
};
```
