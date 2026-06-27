---
type: reference
title: "Exchange Connect"
description: "CME iLink 3: TCP session establishment, encrypted (RSA) vs. Eurex T7: TCP with SBE binary encoding, EntitlementCheckResponse"
tags: ["exchange-protocols"]
difficulty: advanced
timestamp: "2026-06-27T03:06:09.425Z"
phase: 7
phaseName: "Order Entry & Execution"
category: "Phase 7 - Order Entry & Execution"
subcategory: "order-entry"
language: "cpp"
artifact-id: "ZHFT_EXCHANGE_CONNECT"
---
## Key Learning Points

- CME iLink 3: TCP session establishment, encrypted (RSA) vs
- Eurex T7: TCP with SBE binary encoding, EntitlementCheckResponse
- ICE: Binary protocol over TCP, fixed-length headers,
- Session keepalive: application-level heartbeats (FIX 35=0 or
- Sequence number persistence: commit to mmap journal before send;

## Usage

// ExchangeSessionMgr mgr;
// mgr.addSession("CME", "10.0.0.1", 9100, SessionProtocol::ILink3);
// mgr.connectAll();
// mgr.send("CME", order_msg);

## Source Code

```cpp
#include <array>
#include <bit>
#include <chrono>
#include <cstdint>
#include <cstring>
#include <functional>
#include <map>
#include <string_view>
#include <sys/socket.h>
#include <unistd.h>
#include <vector>

// ---------------------------------------------------------------------------
// Protocol types
// ---------------------------------------------------------------------------
enum class SessionProtocol : uint8_t {
  ILink3,
  T7_EBS,
  ICE_Binary,
  FIX_4_4,
};

enum class SessionState : uint8_t {
  Disconnected,
  Connecting,
  LoggingIn,
  LoggedIn,
  Reconnecting,
};

// ---------------------------------------------------------------------------
// Sequence number journal (mmap-backed)
// ---------------------------------------------------------------------------
class SeqJournal {
public:
  SeqJournal(const char *path) {
    fd_ = ::open(path, O_RDWR | O_CREAT, 0644);
    if (fd_ < 0) return;
    ::ftruncate(fd_, 4096);
    base_ = static_cast<uint64_t *>(
        ::mmap(nullptr, 4096, PROT_READ | PROT_WRITE, MAP_SHARED, fd_, 0));
    if (base_ == MAP_FAILED) base_ = nullptr;
  }

  uint64_t read(uint32_t session_id) {
    if (!base_) return 1;
    return base_[session_id % 512];
  }

  void write(uint32_t session_id, uint64_t seq) {
    if (!base_) return;
    base_[session_id % 512] = seq;
    // TRADEOFF: no msync here — let OS flush. For crash safety,
    // periodic msync or use MAP_SYNC on DAX.
  }

private:
  int fd_ = -1;
  uint64_t *base_ = nullptr;
};

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------
struct Session {
  char     name[16];
  char     host[64];
  uint16_t port;
  SessionProtocol proto;
  SessionState state = SessionState::Disconnected;
  int fd = -1;
  uint64_t seq_send;
  uint64_t seq_recv;
  std::chrono::steady_clock::time_point last_heartbeat;
};

// ---------------------------------------------------------------------------
// Exchange session manager
// ---------------------------------------------------------------------------
class ExchangeSessionMgr {
public:
  using OnMessageFn = std::function<void(std::string_view session,
                                         std::string_view msg)>;

  explicit ExchangeSessionMgr(OnMessageFn on_msg)
      : on_message_(std::move(on_msg)) {}

  uint32_t addSession(std::string_view name, std::string_view host,
                      uint16_t port, SessionProtocol proto) {
    uint32_t id = next_id_++;
    auto &s = sessions_[id];
    std::memcpy(s.name, name.data(), std::min(name.size(), size_t(15)));
    std::memcpy(s.host, host.data(), std::min(host.size(), size_t(63)));
    s.port = port;
    s.proto = proto;
    s.seq_send = journal_.read(id);
    s.seq_recv = 1;
    return id;
  }

  void connect(uint32_t id) {
    auto &s = sessions_[id];
    s.fd = ::socket(AF_INET, SOCK_STREAM, 0);
    if (s.fd < 0) return;

    // CRITICAL: set TCP_NODELAY, disable Nagle
    int one = 1;
    ::setsockopt(s.fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof(one));

    // SO_KEEPALIVE as backup
    ::setsockopt(s.fd, SOL_SOCKET, SO_KEEPALIVE, &one, sizeof(one));
    int idle = 5, intvl = 1, cnt = 3;
    ::setsockopt(s.fd, IPPROTO_TCP, TCP_KEEPIDLE, &idle, sizeof(idle));
    ::setsockopt(s.fd, IPPROTO_TCP, TCP_KEEPINTVL, &intvl, sizeof(intvl));
    ::setsockopt(s.fd, IPPROTO_TCP, TCP_KEEPCNT, &cnt, sizeof(cnt));

    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_port = htons(s.port);
    // ::inet_pton for production
    if (::connect(s.fd, (sockaddr *)&addr, sizeof(addr)) < 0) {
      s.state = SessionState::Disconnected;
      return;
    }
    s.state = SessionState::Connecting;
    s.last_heartbeat = std::chrono::steady_clock::now();
    performLogin(s);
  }

  void reconnect(uint32_t id) {
    auto &s = sessions_[id];
    s.state = SessionState::Reconnecting;
    if (s.fd >= 0) ::close(s.fd);
    // TRADEOFF: exponential backoff: 100ms, 500ms, 1s, 5s max
    static const uint64_t backoff_ms[] = {100, 500, 1000, 2000, 5000};
    static size_t attempt = 0;
    usleep(backoff_ms[std::min(attempt++, size_t(4))] * 1000);
    connect(id);
  }

  void send(uint32_t id, std::string_view msg) {
    auto &s = sessions_[id];
    if (s.fd < 0 || s.state != SessionState::LoggedIn) return;

    // Write seq journal before send (crash safety)
    journal_.write(id, s.seq_send);
    s.seq_send++;

    ::write(s.fd, msg.data(), msg.size());
  }

  void poll(int timeout_ms = 10) {
    fd_set read_fds;
    FD_ZERO(&read_fds);
    int max_fd = -1;

    for (auto &[id, s] : sessions_) {
      if (s.fd >= 0 && s.state == SessionState::LoggedIn) {
        FD_SET(s.fd, &read_fds);
        max_fd = std::max(max_fd, s.fd);
      }
    }

    struct timeval tv{timeout_ms / 1000, (timeout_ms % 1000) * 1000};
    if (::select(max_fd + 1, &read_fds, nullptr, nullptr, &tv) > 0) {
      for (auto &[id, s] : sessions_) {
        if (FD_ISSET(s.fd, &read_fds)) {
          uint8_t buf[4096];
          auto n = ::read(s.fd, buf, sizeof(buf));
          if (n > 0) {
            on_message_(s.name, {(const char *)buf, (size_t)n});
            s.last_heartbeat = std::chrono::steady_clock::now();
          } else {
            reconnect(id);
          }
        }
      }
    }

    // Heartbeat check
    auto now = std::chrono::steady_clock::now();
    for (auto &[id, s] : sessions_) {
      if (s.state == SessionState::LoggedIn) {
        auto elapsed = std::chrono::duration_cast<std::chrono::seconds>(
            now - s.last_heartbeat).count();
        if (elapsed > 5) sendHeartbeat(s);
        if (elapsed > 30) reconnect(id); // stale
      }
    }
  }

private:
  std::map<uint32_t, Session> sessions_;
  SeqJournal journal_{"/dev/shm/seq_journal.dat"};
  uint32_t next_id_ = 1;
  OnMessageFn on_message_;

  void performLogin(Session &s) {
    s.state = SessionState::LoggingIn;
    switch (s.proto) {
    case SessionProtocol::ILink3:
      // Send iLink 3 logon: SBE-encoded "LoginRequest" (template 100)
      // Encrypted variant uses RSA-encrypted credentials in payload
      break;
    case SessionProtocol::T7_EBS:
      // Eurex: send LogonRequest (template 100) with credentials
      break;
    case SessionProtocol::ICE_Binary:
      // ICE: send login message with username/password hash
      break;
    default: break;
    }
    s.state = SessionState::LoggedIn;
  }

  void sendHeartbeat(Session &s) {
    switch (s.proto) {
    case SessionProtocol::ILink3: {
      // iLink 3 heartbeat: SBE template 1 (Heartbeat)
      break;
    }
    default: break;
    }
  }
};
```
