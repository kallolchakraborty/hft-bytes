---
type: reference
title: "FIX Protocol"
description: "FIX session layer (FIXT.1.1) defines connection establishment,. Session state machine: Disconnected → Connecting → Connected →"
tags: ["protocols"]
timestamp: "2026-06-27T03:06:09.414Z"
phase: 5
phaseName: "Kernel Bypass & Protocols"
category: "Phase 5 - Kernel Bypass & Protocols"
subcategory: "kernel-bypass"
language: "cpp"
artifact-id: "ZHFT_FIX_PROTOCOL"
---
## Key Learning Points

- FIX session layer (FIXT.1.1) defines connection establishment,
- Session state machine: Disconnected → Connecting → Connected →
- FIX message format: tag=value|SOH, where SOH = 0x01. Parsing
- FAST (FIX Adapted for Streaming) compresses FIX messages using
- FAST stop-bit encoding: each byte uses 7 bits for data, bit 7
- Session connect/logout/resend: logon (35=A) includes HeartBtInt,

## Usage

// g++ -O3 -std=c++20 ZHFT_FIX_PROTOCOL.txt -o fix_proto
// ./fix_proto

## Source Code

```cpp
#include <algorithm>
#include <array>
#include <bit>
#include <chrono>
#include <charconv>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <iostream>
#include <optional>
#include <span>
#include <string_view>
#include <unordered_map>
#include <vector>

// ====================================================================
// Key FIX tags (subset for HFT).
// ====================================================================
enum class FixTag : int {
    BeginString     = 8,
    BodyLength      = 9,
    MsgType         = 35,
    MsgSeqNum       = 34,
    SenderCompID    = 49,
    TargetCompID    = 56,
    SendingTime     = 52,
    HeartBtInt      = 108,
    ApplVerID       = 1128,
    PossDupFlag     = 43,
    PossResend      = 97,
    EncryptMethod   = 98,
    GapFillFlag     = 123,
    RefSeqNum       = 45,
    NewSeqNo        = 36,
    Text            = 58,
    Username        = 553,
    Password        = 554,
    ResetSeqNumFlag = 141,
    CheckSum        = 10,
};

// -------------------------------------------------------------------
// Tag-value encoding/decoding with fast lookup table.
// -------------------------------------------------------------------

// Tag lookup table: maps tag int -> short name (for debugging).
static constexpr auto MakeTagTable() {
    std::array<std::string_view, 600> table{};
    auto add = [&](FixTag t, std::string_view name) {
        table[static_cast<int>(t)] = name;
    };
    add(FixTag::BeginString,    "BeginString");
    add(FixTag::BodyLength,     "BodyLength");
    add(FixTag::MsgType,        "MsgType");
    add(FixTag::MsgSeqNum,      "MsgSeqNum");
    add(FixTag::SenderCompID,   "SenderCompID");
    add(FixTag::TargetCompID,   "TargetCompID");
    add(FixTag::SendingTime,    "SendingTime");
    add(FixTag::HeartBtInt,     "HeartBtInt");
    add(FixTag::ApplVerID,      "ApplVerID");
    add(FixTag::PossDupFlag,    "PossDupFlag");
    add(FixTag::CheckSum,       "CheckSum");
    return table;
}
static constexpr auto kTagNames = MakeTagTable();

auto TagName(int tag) -> std::string_view {
    if (tag >= 0 && tag < static_cast<int>(kTagNames.size()) && !kTagNames[tag].empty())
        return kTagNames[tag];
    return "UNKNOWN";
}

// ====================================================================
// Fast FIX encoder — builds a tag=value|SOH message.
// Uses std::to_chars for integer formatting (no sprintf).
// ====================================================================
class FixEncoder {
public:
    explicit FixEncoder(std::span<char> buf) : buf_{buf}, pos_{0} {}

    auto Remaining() const -> std::size_t { return buf_.size() - pos_; }

    // Append a tag=value pair.
    void AddTag(int tag, std::string_view value) {
        auto [p, ec] = std::to_chars(buf_.data() + pos_,
                                     buf_.data() + buf_.size(), tag);
        if (ec != std::errc{}) return;
        pos_ = static_cast<std::size_t>(p - buf_.data());
        buf_[pos_++] = '=';
        auto len = std::min(value.size(), Remaining());
        std::memcpy(buf_.data() + pos_, value.data(), len);
        pos_ += len;
        buf_[pos_++] = '\x01';          // SOH delimiter
    }

    void AddTag(int tag, int value) {
        char tmp[32];
        auto [p, ec] = std::to_chars(tmp, tmp + 32, value);
        if (ec != std::errc{}) return;
        AddTag(tag, std::string_view{tmp, static_cast<std::size_t>(p - tmp)});
    }

    // Finalise: write BodyLength (tag 9) and CheckSum (tag 10).
    auto Finalise(int msg_seq_num, std::string_view sender, std::string_view target,
                  std::string_view sending_time) -> std::string_view {
        // BodyLength = everything between tag 9 and checksum.
        // For simplicity, we precompute and inject.
        // Real implementation would compute checksum as mod 256 of all bytes.
        int body_len = static_cast<int>(pos_);
        // Prepend BodyLength and append CheckSum (omitted for brevity).
        (void)body_len;
        return {buf_.data(), pos_};
    }

    auto View() const -> std::string_view { return {buf_.data(), pos_}; }

private:
    std::span<char> buf_;
    std::size_t     pos_ = 0;
};

// ====================================================================
// FIX decoder — fast, low-allocation, line-by-line.
// ====================================================================
class FixDecoder {
public:
    using Field = std::pair<int, std::string_view>;   // tag, value

    explicit FixDecoder(std::string_view msg) : msg_{msg} {}

    // Iterator: yields (tag, value) pairs.
    class Iterator {
    public:
        explicit Iterator(std::string_view msg) : remaining_{msg}, done_{false} {
            Advance();
        }
        auto operator*() const -> Field { return current_; }
        auto operator++() -> Iterator& { Advance(); return *this; }
        auto operator!=(const Iterator& other) const -> bool {
            return done_ != other.done_;
        }

    private:
        void Advance() {
            if (remaining_.empty()) { done_ = true; return; }
            // Parse "tag=value\x01"
            auto eq_pos = remaining_.find('=');
            auto soh_pos = remaining_.find('\x01');
            if (eq_pos == std::string_view::npos ||
                soh_pos == std::string_view::npos ||
                eq_pos > soh_pos) {
                done_ = true;
                return;
            }
            int tag = 0;
            std::from_chars(remaining_.data(),
                           remaining_.data() + eq_pos, tag);
            current_ = {tag, remaining_.substr(eq_pos + 1,
                                               soh_pos - eq_pos - 1)};
            remaining_ = remaining_.substr(soh_pos + 1);
        }

        std::string_view remaining_;
        Field           current_{};
        bool            done_ = false;
    };

    auto begin() const -> Iterator { return Iterator{msg_}; }
    auto end() const -> Iterator { return Iterator{std::string_view{}}; }

private:
    std::string_view msg_;
};

// ====================================================================
// FIX Session State Machine (minimal).
// ====================================================================
enum class SessionState {
    Disconnected,
    Connecting,
    LogonSent,
    LogonReceived,
    Active,
    LogoutSent,
    LogoutReceived,
};

struct FixSession {
    SessionState    state               = SessionState::Disconnected;
    std::string     sender_comp_id      = "HFT_TRADER";
    std::string     target_comp_id      = "EXCHANGE";
    int             next_send_seq       = 1;
    int             next_recv_seq       = 1;
    int             heart_bt_interval_s = 10;

    // Logon message builder.
    auto BuildLogon() -> std::string {
        std::array<char, 512> buf{};
        FixEncoder enc{buf};
        enc.AddTag(static_cast<int>(FixTag::BeginString), "FIXT.1.1");
        enc.AddTag(static_cast<int>(FixTag::MsgType), "A");
        enc.AddTag(static_cast<int>(FixTag::SenderCompID), sender_comp_id);
        enc.AddTag(static_cast<int>(FixTag::TargetCompID), target_comp_id);
        enc.AddTag(static_cast<int>(FixTag::MsgSeqNum), next_send_seq++);
        enc.AddTag(static_cast<int>(FixTag::SendingTime), "20260101-00:00:00.000");
        enc.AddTag(static_cast<int>(FixTag::HeartBtInt), heart_bt_interval_s);
        enc.AddTag(static_cast<int>(FixTag::EncryptMethod), 0);
        enc.AddTag(static_cast<int>(FixTag::ApplVerID), "9");   // FIX 5.0SP2
        // Checksum omitted for brevity.
        return std::string{enc.View()};
    }

    // Heartbeat.
    auto BuildHeartbeat() -> std::string {
        std::array<char, 256> buf{};
        FixEncoder enc{buf};
        enc.AddTag(static_cast<int>(FixTag::BeginString), "FIXT.1.1");
        enc.AddTag(static_cast<int>(FixTag::MsgType), "0");
        enc.AddTag(static_cast<int>(FixTag::SenderCompID), sender_comp_id);
        enc.AddTag(static_cast<int>(FixTag::TargetCompID), target_comp_id);
        enc.AddTag(static_cast<int>(FixTag::MsgSeqNum), next_send_seq++);
        return std::string{enc.View()};
    }

    // Handle incoming message (simplified).
    auto HandleMessage(std::string_view msg) -> void {
        for (auto [tag, value] : FixDecoder{msg}) {
            switch (static_cast<FixTag>(tag)) {
            case FixTag::MsgType:
                HandleMsgType(value);
                break;
            case FixTag::MsgSeqNum:
                int seq;
                std::from_chars(value.data(), value.data() + value.size(), seq);
                HandleSeqNum(seq);
                break;
            default:
                break;
            }
        }
    }

    void HandleMsgType(std::string_view type) {
        if (type == "A") state = SessionState::LogonReceived;
        else if (type == "5") state = SessionState::LogoutReceived;
    }

    void HandleSeqNum(int seq) {
        if (seq != next_recv_seq) {
            std::cerr << "SeqNum gap: expected " << next_recv_seq
                      << ", got " << seq << "\n";
            // Would send ResendRequest (35=2).
        }
        next_recv_seq = seq + 1;
    }
};

// ====================================================================
// FAST encoding / decoding (compressed FIX via templates).
// ====================================================================
// FAST principle:
//   - A template defines fields in order: type, presence, value.
//   - Stop bit: each byte has bit 7 as stop bit (1 = end of value).
//   - Presence map: a bitmask indicates which optional fields follow.
// ====================================================================

// Minimal FAST decoder — reads stop-bit encoded integers.
auto DecodeFASTInt(std::string_view& data) -> std::optional<int64_t> {
    if (data.empty()) return std::nullopt;
    uint64_t val = 0;
    int shift = 0;
    std::size_t i = 0;
    while (i < data.size()) {
        uint8_t byte = static_cast<uint8_t>(data[i++]);
        val |= static_cast<uint64_t>(byte & 0x7F) << shift;
        shift += 7;
        if (byte & 0x80) {
            // Stop bit set — end of value.
            data = data.substr(i);
            return static_cast<int64_t>(val);
        }
    }
    data = data.substr(i);
    return static_cast<int64_t>(val);
}

// -------------------------------------------------------------------
// Demonstration: encode/decode a FIX Logon message + FAST benchmark.
// -------------------------------------------------------------------
auto main() -> int {
    FixSession session;
    auto logon = session.BuildLogon();

    std::cout << "=== FIX Protocol Fundamentals ===\n\n";
    std::cout << "FIX Logon message (" << logon.size() << " B):\n";
    std::cout << "  " << logon << "\n\n";

    std::cout << "Decoded fields:\n";
    for (auto [tag, value] : FixDecoder{logon}) {
        std::cout << "  Tag " << tag << " (" << TagName(tag)
                  << ") = '" << value << "'\n";
    }
    std::cout << "\n";

    // FAST benchmark: encode a price (10-digit integer) as stop-bit.
    std::cout << "FAST stop-bit encoding example:\n";
    int64_t price = 1500000000;   // $1500.00000000 in fixed-point
    std::array<uint8_t, 16> fast_buf{};
    std::size_t fast_len = 0;
    // Encode: write 7-bit chunks with stop bit set on last.
    uint64_t val = static_cast<uint64_t>(price);
    do {
        uint8_t byte = val & 0x7F;
        val >>= 7;
        if (val == 0) byte |= 0x80;     // stop bit
        fast_buf[fast_len++] = byte;
    } while (val != 0);

    std::string_view fast_data{reinterpret_cast<const char*>(fast_buf.data()), fast_len};
    auto decoded = DecodeFASTInt(fast_data);

    std::cout << "  Price:      " << price << "\n";
    std::cout << "  FAST bytes: " << fast_len << " (vs ~10 in ASCII FIX)\n";
    std::cout << "  Decoded:    " << decoded.value_or(-1) << "\n\n";

    // Benchmark: decode 100K FIX messages.
    constexpr int kIter = 100'000;
    auto t0 = std::chrono::steady_clock::now();
    for (int i = 0; i < kIter; ++i) {
        for (auto [tag, value] : FixDecoder{logon}) {
            volatile auto t = tag;
            volatile auto v = value.data();
            (void)t; (void)v;
        }
    }
    auto t1 = std::chrono::steady_clock::now();
    auto ns = std::chrono::duration_cast<std::chrono::nanoseconds>(t1 - t0).count();
    std::cout << "Decode " << kIter << " FIX msgs: " << (ns / 1'000'000) << " ms ("
              << (ns / kIter) << " ns/msg)\n";

    return 0;
}
```
