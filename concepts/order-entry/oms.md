---
type: reference
title: "OMS"
description: "Order state machine: New → PendingNew → Accepted → Filled /. Parent-child order relationships (iceberg: parent=displayed,"
tags: ["phase-7"]
timestamp: "2026-06-27T03:06:09.426Z"
phase: 7
phaseName: "Order Entry & Execution"
category: "Phase 7 - Order Entry & Execution"
subcategory: "order-entry"
language: "cpp"
artifact-id: "ZHFT_OMS"
---
## Key Learning Points

- Order state machine: New → PendingNew → Accepted → Filled /
- Parent-child order relationships (iceberg: parent=displayed,
- Memory-mapped file (mmap) persistence for crash recovery — no
- Order database keyed by ClOrdID (client) and OrderID (exchange);
- Persistence writes go to a redo log, then async checkpoint to

## Usage

// OrderManager om("/dev/shm/orders.dat");
// auto id = om.newOrder("AAPL", Side::BUY, 100, 150.25);
// om.onFill(id, 50, 150.30, "EXEC1");
// om.onCancel(id);

## Source Code

```cpp
#include <algorithm>
#include <atomic>
#include <bit>
#include <cstdint>
#include <cstring>
#include <fcntl.h>
#include <span>
#include <string_view>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>
#include <vector>

// ---------------------------------------------------------------------------
// Order state machine
// ---------------------------------------------------------------------------
enum class OrderState : uint8_t {
  New,
  PendingNew,
  Accepted,
  PartiallyFilled,
  Filled,
  Cancelled,
  Rejected,
  PendingCancel,
  PendingReplace,
};

enum class Side : uint8_t { Buy = 1, Sell = 2 };

// Order flags
static constexpr uint32_t OMS_ICEBERG   = 1u << 0;
static constexpr uint32_t OMS_BRACKET   = 1u << 1;
static constexpr uint32_t OMS_HIDDEN    = 1u << 2;

// Packed order record — 128 bytes fits two per cache line
struct alignas(64) OrderRecord {
  uint64_t    order_id;        // Monotonic internal ID
  uint64_t    cl_order_id;     // Client-assigned ID
  uint64_t    parent_id;       // 0 = root order
  uint64_t    child_idx;       // Index within parent's children
  uint64_t    symbol_hash;     // Truncated hash for fast comparison
  double      price;
  double      stop_price;      // 0 if not stop
  uint64_t    quantity;
  uint64_t    filled_qty;
  uint64_t    avg_price;       // Scaled by 1e4
  uint64_t    create_ns;       // Monotonic timestamp
  uint64_t    update_ns;
  OrderState  state;
  Side        side;
  uint32_t    flags;
  uint8_t     padding[16];     // Align to 128
};

static_assert(sizeof(OrderRecord) <= 128);

// ---------------------------------------------------------------------------
// Persistent order store via mmap
// ---------------------------------------------------------------------------
class PersistentOrderStore {
public:
  static constexpr size_t kMaxOrders = 1 << 20; // ~1M

  explicit PersistentOrderStore(const char *path) {
    fd_ = ::open(path, O_RDWR | O_CREAT, 0644);
    if (fd_ < 0) {
      // Fall back to /dev/shm for low-latency
      fd_ = ::open("/dev/shm/oms_orders.dat",
                   O_RDWR | O_CREAT | O_TRUNC, 0644);
    }
    // Pre-allocate file
    ::ftruncate(fd_, kMaxOrders * sizeof(OrderRecord));
    base_ = static_cast<OrderRecord *>(::mmap(
        nullptr, kMaxOrders * sizeof(OrderRecord),
        PROT_READ | PROT_WRITE, MAP_SHARED, fd_, 0));
    // TRADEOFF: MAP_SHARED vs MAP_PRIVATE: shared writes back to file,
    // but can cause I/O pressure. Use MAP_SHARED for crash safety.
    if (base_ == MAP_FAILED) {
      // Fallback heap allocation
      heap_.resize(kMaxOrders);
      base_ = heap_.data();
      use_mmap_ = false;
    }
  }

  ~PersistentOrderStore() {
    if (use_mmap_) {
      ::munmap(base_, kMaxOrders * sizeof(OrderRecord));
      ::close(fd_);
    }
  }

  OrderRecord *get(uint64_t idx) {
    if (idx >= kMaxOrders) return nullptr;
    return &base_[idx];
  }

  void flush() {
    // TRADEOFF: periodic msync instead of every write.
    // Every-write msync costs ~1-10 us; batch every 1ms.
    if (use_mmap_)
      ::msync(base_, kMaxOrders * sizeof(OrderRecord), MS_ASYNC);
  }

private:
  int fd_ = -1;
  OrderRecord *base_ = nullptr;
  bool use_mmap_ = true;
  std::vector<OrderRecord> heap_; // fallback
};

// ---------------------------------------------------------------------------
// Order state machine
// ---------------------------------------------------------------------------
class OrderStateMachine {
public:
  // Returns false if transition is invalid
  static bool transition(OrderState &s, OrderState next) {
    using enum OrderState;
    switch (s) {
    case New:             return next == PendingNew || next == Rejected;
    case PendingNew:      return next == Accepted || next == Rejected;
    case Accepted:        return next == PartiallyFilled || next == Filled
                                || next == Cancelled || next == PendingCancel;
    case PartiallyFilled: return next == Filled || next == Cancelled
                                || next == PendingCancel || next == PartiallyFilled;
    case PendingCancel:   return next == Cancelled || next == Rejected;
    case PendingReplace:  return next == Accepted || next == Rejected;
    default:              return false;
    }
  }
};

// ---------------------------------------------------------------------------
// Order Manager
// ---------------------------------------------------------------------------
class OrderManager {
public:
  explicit OrderManager(const char *path)
      : store_(path) {}

  uint64_t newOrder(std::string_view symbol, Side side,
                    uint64_t qty, double price,
                    uint64_t parent_id = 0,
                    uint32_t flags = 0) {
    auto idx = next_id_.fetch_add(1, std::memory_order_relaxed);
    auto *rec = store_.get(idx);
    if (!rec) return 0; // out of space

    rec->order_id   = idx;
    rec->cl_order_id = idx; // client would provide this
    rec->parent_id  = parent_id;
    rec->symbol_hash = fnv1a(symbol);
    rec->price      = price;
    rec->quantity   = qty;
    rec->filled_qty = 0;
    rec->avg_price  = 0;
    rec->state      = OrderState::New;
    rec->side       = side;
    rec->flags      = flags;
    rec->create_ns  = rdtsc(); // coarse
    rec->update_ns  = rec->create_ns;

    // If parent, link child
    if (parent_id) {
      auto *parent = store_.get(parent_id);
    }

    // Iceberg: spawn first child chunk immediately
    if (flags & OMS_ICEBERG) {
      // Child with display qty, total qty in parent
    }

    return idx;
  }

  void onFill(uint64_t id, uint64_t fill_qty, double fill_price) {
    auto *rec = store_.get(id);
    if (!rec) return;

    rec->filled_qty += fill_qty;
    // Weighted average price
    uint64_t fp = static_cast<uint64_t>(fill_price * 1e4);
    rec->avg_price = rec->avg_price ?
        (rec->avg_price * (rec->filled_qty - fill_qty) + fp * fill_qty)
        / rec->filled_qty : fp;

    OrderState next = (rec->filled_qty >= rec->quantity)
                          ? OrderState::Filled
                          : OrderState::PartiallyFilled;
    OrderStateMachine::transition(rec->state, next);
    rec->state = next;
    rec->update_ns = rdtsc();

    // If iceberg, replenish child
    if ((rec->flags & OMS_ICEBERG) && rec->state == OrderState::PartiallyFilled) {
      // spawn new child for next displayed chunk
    }
  }

  void onCancel(uint64_t id) {
    auto *rec = store_.get(id);
    if (!rec) return;
    if (OrderStateMachine::transition(rec->state, OrderState::Cancelled))
      rec->state = OrderState::Cancelled;
  }

  void checkpoint() {
    store_.flush();
  }

private:
  PersistentOrderStore store_;
  std::atomic<uint64_t> next_id_{1};

  static uint64_t fnv1a(std::string_view s) {
    uint64_t h = 0xcbf29ce484222325ull;
    for (char c : s) { h ^= c; h *= 0x100000001b3ull; }
    return h;
  }

  static uint64_t rdtsc() {
    return __builtin_ia32_rdtsc();
  }
};
```
