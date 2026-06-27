---
type: reference
title: "Order Reconstruction"
description: "Local state vs exchange state: after reconnection, request all. Resend request handling: FIX tag 35=2 with BeginSeqNo (tag 7)"
tags: ["order-types"]
timestamp: "2026-06-27T03:06:09.427Z"
phase: 7
phaseName: "Order Entry & Execution"
category: "Phase 7 - Order Entry & Execution"
subcategory: "order-entry"
language: "cpp"
artifact-id: "ZHFT_ORDER_RECON"
---
## Key Learning Points

- Local state vs exchange state: after reconnection, request all
- Resend request handling: FIX tag 35=2 with BeginSeqNo (tag 7)
- Gap fill processing: fill gaps in seq number history but do NOT
- Duplicate detection: PossDupFlag=Y means the message is a
- Recovery strategies: "recover" (resume from last seq) vs "reset"

## Usage

// OrderReconEngine recon(order_db, exchange_session);
// recon.reconcileAfterReconnect();

## Source Code

```cpp
#include <algorithm>
#include <bit>
#include <chrono>
#include <cstdint>
#include <cstring>
#include <map>
#include <string_view>
#include <unordered_map>
#include <vector>

// ---------------------------------------------------------------------------
// Order state (local copy)
// ---------------------------------------------------------------------------
struct LocalOrderState {
  uint64_t    cl_order_id;
  uint64_t    order_id;       // Exchange-assigned
  std::string symbol;
  uint64_t    quantity;
  uint64_t    filled_qty;
  double      price;
  double      avg_price;
  uint8_t     side;           // 1=buy, 2=sell
  uint8_t     status;         // 0=New, 1=PartiallyFilled, 2=Filled, etc.
  uint64_t    last_seq;       // Last sequence number from exchange
  uint64_t    last_exec_id;   // Last ExecID for dedup
};

// ---------------------------------------------------------------------------
// Exchange order state (from MassOrderStatusRequest response)
// ---------------------------------------------------------------------------
struct ExchangeOrderState {
  uint64_t    order_id;
  std::string cl_order_id;
  uint64_t    filled_qty;
  uint64_t    remaining_qty;
  uint8_t     status;
  double      avg_price;
};

// ---------------------------------------------------------------------------
// Gap fill handler
// ---------------------------------------------------------------------------
class GapFillHandler {
public:
  // Record all received messages by seq
  struct MsgRecord {
    uint64_t seq;
    uint64_t cl_order_id;
    uint64_t exec_id;
    uint8_t  exec_type;  // '0'=New, '1'=PartialFill, '2'=Fill, '4'=Cancel
    uint64_t last_qty;
    uint64_t last_px;
    bool     poss_dup;   // PossDupFlag
  };

  void insert(const MsgRecord &rec) {
    // CRITICAL: check for duplicates before inserting
    auto key = (rec.cl_order_id << 32) ^ rec.exec_id;
    if (seen_.count(key)) return; // already processed
    seen_.insert(key);

    messages_[rec.seq] = rec;
  }

  // Detect gaps
  std::vector<uint64_t> detectGaps(uint64_t expected_next) {
    std::vector<uint64_t> gaps;
    uint64_t expected = expected_next;
    for (auto &[seq, msg] : messages_) {
      // TRADEOFF: don't detect gaps for PossDup messages
      if (msg.poss_dup) continue;
      while (expected < seq) {
        gaps.push_back(expected++);
      }
      expected = seq + 1;
    }
    return gaps;
  }

  // Apply gap-filled messages to state
  void applyFill(uint64_t gap_seq, const MsgRecord &rec) {
    // Fill the gap with the retransmitted message
    messages_[gap_seq] = rec;
  }

private:
  std::map<uint64_t, MsgRecord> messages_;
  std::unordered_set<uint64_t> seen_;
};

// ---------------------------------------------------------------------------
// Order reconciliation engine
// ---------------------------------------------------------------------------
class OrderReconEngine {
public:
  OrderReconEngine(std::unordered_map<uint64_t, LocalOrderState> *local_db,
                   GapFillHandler *gap_handler)
      : local_db_(local_db), gap_handler_(gap_handler) {}

  // Main reconcile entry point after reconnection
  void reconcileAfterReconnect() {
    // Phase 1: Request mass order status from exchange
    auto exchange_orders = requestExchangeOrders();

    // Phase 2: Compare each local order with exchange state
    for (auto &[cl_id, local] : *local_db_) {
      auto it = exchange_orders.find(cl_id);
      if (it == exchange_orders.end()) {
        // Order exists locally but not on exchange — may have been
        // rejected or cancelled during network partition
        handleMissingOnExchange(local);
      } else {
        compareStates(local, it->second);
      }
    }

    // Phase 3: Orders on exchange but not local — may be from a
    // different session instance (stale)
    for (auto &[cl_id, exch] : exchange_orders) {
      if (!local_db_->count(cl_id)) {
        handleUnknownOnExchange(exch);
      }
    }

    // Phase 4: Process gap fill for any missed messages
    processGapFill();
  }

  // Handle resend request response
  void onResendMessage(const GapFillHandler::MsgRecord &rec) {
    gap_handler_->insert(rec);

    // Check if this fills a detected gap
    if (rec.poss_dup) {
      auto gaps = gap_handler_->detectGaps(rec.seq);
      for (auto g : gaps) {
        // Request specific retransmission for gap
        requestRetransmission(g);
      }
    }
  }

private:
  std::unordered_map<uint64_t, LocalOrderState> *local_db_;
  GapFillHandler *gap_handler_;

  std::unordered_map<uint64_t, ExchangeOrderState> requestExchangeOrders() {
    // Send MassOrderStatusRequest (tag 35=AF)
    // Parse response and build map by ClOrdID
    return {};
  }

  void compareStates(const LocalOrderState &local,
                     const ExchangeOrderState &exch) {
    if (local.filled_qty != exch.filled_qty) {
      // Fill mismatch — need to request detail via resend
      // CRITICAL: always trust exchange state for fills, not local
      // Local may have missed fill messages during partition
      requestFillDetail(local.cl_order_id, local.last_seq + 1);
    }

    if (local.status != exch.status) {
      // Status mismatch — reconcile
      if (exch.status == 2 && local.status != 2) {
        // Exchange says filled but local doesn't know
        // Request gap fill around that period
        requestRetransmission(local.last_seq);
      }
    }
  }

  void handleMissingOnExchange(const LocalOrderState &local) {
    // Order not on exchange — assume cancelled/rejected
    // Update local: mark as cancelled with reason "MissingOnExchange"
    auto &st = (*local_db_)[local.cl_order_id];
    st.status = 3; // Cancelled
  }

  void handleUnknownOnExchange(const ExchangeOrderState &exch) {
    // Exchange has order we don't know about — this is dangerous
    // Send cancel for that order
    sendCancel(exch.order_id);
  }

  void requestRetransmission(uint64_t seq) {
    // Send ResendRequest (tag 35=2) for seq
  }

  void requestFillDetail(uint64_t cl_ord_id, uint64_t from_seq) {
    // Request OrderMassStatusRequest or individual OrderStatusRequest
  }

  void processGapFill() {
    auto gaps = gap_handler_->detectGaps(0);
    for (auto g : gaps) {
      requestRetransmission(g);
    }
  }

  void sendCancel(uint64_t) {
    // Send OrderCancelRequest (tag 35=F)
  }
};
```
