---
type: reference
title: "Exchange Feed Protocol Internals"
description: "MoldUDP64 packet framing and recovery, SoupBinTCP session login and message framing, SLIP (CME) protocol, Linear Binary (ICE) format, retransmission request/reply, and sequence number management per protocol."
tags: ["exchange-protocols"]
timestamp: "2026-06-27T03:40:00.000Z"
phase: 5
phaseName: "Kernel Bypass & Protocols"
category: "Kernel Bypass"
subcategory: "kernel-bypass"
language: "cpp"
artifact-id: "ZHFT_FEED_PROTOCOLS_DEEP"
---
## Key Learning Points

- MoldUDP64 (Nasdaq): each packet has a 64-byte header (session ID, sequence number, message count, flags); payload contains concatenated messages; trailer has no CRC (recovery channel provides reliability)
- MoldUDP64 recovery: separate TCP channel requests retransmission of missed seqnos; `RetransmissionRequest(endpoint, seqno, count)` → `RetransmissionReply` with requested messages; gap detection via seqno gap in packet header
- SoupBinTCP (Nasdaq): login sequence (LogonRequest → LogonAccepted/Rejected); each message length-prefixed (2-byte big-endian length); no checksum (TCP provides reliability); uses heartbeat/packet interval to detect disconnection
- SLIP (CME Secure Line Interface Protocol): framing with STX/ETX bytes, CRC-16 at trailer; supports login/gap-fill/heartbeat sub-protocols; uses "logged-in" / "disconnected" session states
- Linear Binary (ICE): each message is a concatenation of fixed-width fields packed without delimiters; schema defined by template; header contains message type + sequence number + timestamp + symbol count
- Retransmission mechanics: MoldUDP64 uses separate TCP channel; SLIP uses inline resend request via control message; SoupBinTCP uses `SequencedData` with out-of-sequence reconnect
- Endpoint addressing: MoldUDP64 uses multicast groups + ports; SoupBinTCP uses TCP sessions per feed; SLIP uses TCP sessions per link; Linear Binary uses multicast + TCP recovery

## Usage

```cpp
// MoldUDP64 packet header
#pragma pack(push, 1)
struct MoldUDP64Header {
    uint64_t session_id_;
    uint64_t sequence_number_;  // first msg seqno in this packet
    uint16_t message_count_;
    uint16_t flags_;            // 0x0001 = end of session
    // Followed by message_count_ messages
    // Each message: 2-byte msg_length (big-endian) + payload
};

// SoupBinTCP login
struct SoupBinTCPLogin {
    char username_[6];     // padded with spaces
    char password_[10];    // padded with spaces
    char requested_session_[10];
    char requested_sequence_[20];  // numeric ASCII
};

// SLIP packet framing
struct SLIPPacket {
    uint8_t stx_ = 0x02;   // Start of Text
    char type_;              // 'L'=Logon, 'D'=Data, 'R'=Retrans, 'H'=Heartbeat
    uint16_t length_;        // payload length (big-endian)
    // payload (varies by type)
    uint16_t crc_;           // CRC-16 of type+length+payload
    uint8_t etx_ = 0x03;    // End of Text
};
#pragma pack(pop)

// MoldUDP64 recovery request (TCP)
struct RecoveryRequest {
    char request_type_ = 'R';
    uint64_t begin_seqno_;
    uint64_t end_seqno_;  // 0 = up to most recent
};
```

## Source Code

```cpp
// Protocol-to-common internal event mapping
// MoldUDP64 seqno       → internal seqno (session scoped)
// SoupBinTCP seqno      → internal seqno (session scoped)
// SLIP sequence number  → internal seqno
// Linear Binary seqno   → internal seqno

// Recovery channel connectivity matrix
// ┌────────────┬──────────────┬────────────┬──────────────┐
// │ Protocol   │ Primary      │ Recovery   │ Gap Fill     │
// ├────────────┼──────────────┼────────────┼──────────────┤
// │ MoldUDP64  │ Multicast    │ TCP         │ RetransReq   │
// │ SoupBinTCP │ TCP          │ N/A (TCP)  │ Reconnect    │
// │ SLIP       │ TCP          │ TCP (same) │ ResendReq    │
// │ LinearBin  │ Multicast+Tcp│ TCP         │ RetransReq   │
// └────────────┴──────────────┴────────────┴──────────────┘
```
