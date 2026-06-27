---
type: reference
title: "Trading Desk Tools & GUIs"
description: "Position blotter architecture, real-time P&L screens, risk monitor dashboards, order management interfaces, FIX drop-crop processing for desk display, NBBO/ladder visualization, and WebSocket push for GUI data distribution."
tags: ["trading"]
difficulty: intermediate
timestamp: "2026-06-27T04:00:00.000Z"
phase: 7
phaseName: "Order Entry & Execution"
category: "Order Entry"
subcategory: "order-entry"
language: "cpp"
artifact-id: "ZHFT_DESK_TOOLS"
---
## Key Learning Points

- Position blotter: real-time table of all open positions per symbol/strategy/trader; columns: symbol, side, qty, avg price, mTM P&L, delta, gamma, theta; updated on every fill via OMS event stream
- P&L screens (screamers): color-coded display of position-level P&L; green for profitable, red for losing, intensity proportional to magnitude; sound alerts on P&L thresholds; sub-second refresh from market-data feed
- Risk monitor dashboard: real-time VaR per portfolio, position limits utilization, credit usage, exchange gateway health, kill-switch status; red/amber/green traffic-light indicators
- Order management GUI: display active orders, cancel/replace functionality, order history, fill report viewer; must handle high order churn (hundreds of cancels/sec) without UI freeze
- FIX drop-copy: exchange sends a copy of all fills/orders to a dedicated FIX session; desk tools consume drop-copy feed to reconcile blotter with exchange confirmations
- NBBO/ladder display: real-time best bid/offer with cumulative depth, time & sales tape, order flow imbalance indicator; ASCII grid for terminal-based tools, HTML5 canvas for browser-based
- Data distribution: OMS publishes position/risk events to internal pub-sub (OpenDDS, Aeron, or WebSocket); GUIs are decoupled consumers; target latency from fill to GUI < 10ms

## Usage

```cpp
// Position blotter row
struct PositionRow {
    std::string symbol_;
    long qty_;              // positive = long, negative = short
    double avg_price_;
    double last_price_;
    double mtm_pnl() const { return qty_ * (last_price_ - avg_price_); }
    double delta() const;   // from greeks engine
};

// Risk monitor status
struct RiskStatus {
    std::string symbol_;
    double var_usd_;
    double max_var_;
    double position_limit_used_;  // 0.0 to 1.0
    bool gateway_healthy_;
    bool kill_switch_armed_;
    TrafficLight status() const {
        if (kill_switch_armed_) return RED;
        if (var_usd_ > max_var_ || position_limit_used_ > 0.95) return AMBER;
        return GREEN;
    }
};

// GUI data distribution (WebSocket JSON)
struct DeskEvent {
    enum Type { POSITION_UPDATE, FILL, RISK_ALERT, GATEWAY_STATUS };
    Type type_;
    std::string json_payload_;
    uint64_t ts_ns_;
};
```

## Source Code

```cpp
// Terminal-based NBBO display (ncurses/ASCII)
// ┌─────────────┬──────────┬──────────┬──────────┐
// │   AAPL      │  BID     │  ASK     │  LAST    │
// │  10:01:32   │  189.20  │  189.23  │  189.21  │
// │  Depth:     │  (4.2k)  │  (3.8k)  │          │
// │  Imbalance: │  +400    │          │  ↑0.02   │
// └─────────────┴──────────┴──────────┴──────────┘

// WebSocket message format for desk GUI:
// {
//   "type": "pnl_update",
//   "strategy": "es-mm",
//   "pnl_gross": 12450.00,
//   "pnl_net": 11200.00,
//   "positions": [
//     {"symbol": "ESH7", "qty": 45, "avg_px": 4521.50, "last": 4523.00}
//   ]
// }
```
