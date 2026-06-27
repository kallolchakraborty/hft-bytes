---
type: reference
title: "PnL Attribution & Trade Reconciliation"
description: "Trade-level vs position-level PnL calculation, FIFO/LIFO/specific identification cost basis, mark-to-market, accruals (dividends, financing), reconciliation breaks between OMS and clearing, and break investigation workflow."
tags: ["trading-strategies"]
difficulty: staff
timestamp: "2026-06-27T06:00:00.000Z"
phase: 10
phaseName: "Trading Strategies"
category: "Trading Strategies"
subcategory: "trading-strategies"
language: "python"
artifact-id: "ZHFT_PNL_ATTRIBUTION"
---
## Key Learning Points

- **Trade-level vs position-level PnL**: trade-level PnL = Σ(sell_price × qty) – Σ(buy_price × qty) for closed positions; position-level PnL = current_position × (last_price – avg_cost); distinction matters for intraday vs EOD reporting. Trade-level PnL is only meaningful when the position is closed (flat) — for open positions, it's incomplete. Position-level PnL includes unrealized gains/losses from mark-to-market. For HFT: trade-level PnL is your real-time fill quality metric — measure slippage against arrival price (Implementation Shortfall). Position-level PnL is your risk metric — it tells you your current exposure. Report both: trade-level for execution analysis, position-level for risk management
- **Cost basis methods**: FIFO (first-in-first-out) is default for most regulators; LIFO (last-in-first-out) defers tax in rising markets; specific identification allows selecting which lots to close — requires lot-level tracking in OMS. FIFO matches the oldest entry against the newest exit — this is the simplest and most common. LIFO matches the newest entry against the newest exit — in a rising market, LIFO sells the most expensive lots first, deferring tax. Specific identification: you choose which lot to sell — useful for tax-loss harvesting (sell the lot with the highest loss). For HFT: FIFO is the only practical choice for high-frequency trading (you can't meaningfully track individual lots at microsecond resolution). LIFO and specific identification are for position traders and portfolio managers
- **Mark-to-market**: value open positions at last traded price (intraday), settlement price (EOD), or mid-market; unrealized PnL is mark-to-market − cost basis; realized PnL occurs on fill. Mark-to-market methodology matters: last traded price is noisy (last trade could be an outlier), settlement price is the official EOD price (used for regulatory reporting), mid-market is the theoretical fair value (average of bid and ask). For HFT: use last traded price for real-time risk calculations (it's the most current). Use settlement price for EOD PnL reporting (regulatory requirement). Use mid-market for internal performance measurement (it's the most accurate reflection of fair value)
- **Accruals**: dividends (long positions accrue dividend on ex-date), financing (short pays rebate, long pays borrow cost), carry costs for futures (basis = spot − future × e^(−rT)); these accrue daily but settle monthly. For HFT: accruals are small for short-duration trades (seconds to minutes) but significant for overnight positions. Dividend accruals: on the ex-date, subtract the dividend from your long position's PnL (you're not entitled to the dividend if you buy on or after the ex-date). Financing: short positions pay borrow cost (typically 0.5-5% annualized), long positions receive rebate (typically 0.1-1% annualized). The carry cost for futures: basis = spot − future × e^(−rT), where r = risk-free rate, T = time to expiry. For HFT: accruals are a rounding error for intraday trades but must be tracked for overnight positions

```html
<div class="ad-wrapper">
  <div class="ad-title">PnL Reconciliation — OMS vs Clearing</div>
  <div class="ad-flow">
    <div class="ad-stage active"><span class="ad-stage-icon">📋</span><span class="ad-stage-label">OMS Trade Log</span></div>
    <div class="ad-arrow"><span class="material-symbols-outlined">chevron_right</span><span class="ad-packet"></span></div>
    <div class="ad-stage"><span class="ad-stage-icon">🔄</span><span class="ad-stage-label">Match &amp; Reconcile</span></div>
    <div class="ad-arrow"><span class="material-symbols-outlined">chevron_right</span><span class="ad-packet"></span></div>
    <div class="ad-stage"><span class="ad-stage-icon">🏦</span><span class="ad-stage-label">Clearing Report</span></div>
  </div>
  <div class="ad-legend" style="margin-top:0.5rem">
    <span class="ad-legend-item"><span class="ad-legend-swatch" style="background:#22c55e"></span>Matched</span>
    <span class="ad-legend-item"><span class="ad-legend-swatch" style="background:#ef4444"></span>Break</span>
  </div>
</div>
```

## Usage

```python
class Position:
    def __init__(self):
        self.lots = []  # FIFO queue of (qty, price)
        self.total_qty = 0

    def buy(self, qty, price):
        self.lots.append((qty, price))
        self.total_qty += qty

    def sell(self, qty, price):
        realized = 0
        while qty > 0 and self.lots:
            lot_qty, lot_price = self.lots[0]
            close_qty = min(qty, lot_qty)
            realized += close_qty * (price - lot_price)
            if close_qty == lot_qty:
                self.lots.pop(0)
            else:
                self.lots[0] = (lot_qty - close_qty, lot_price)
            qty -= close_qty
            self.total_qty -= close_qty
        return realized

    def mtm(self, last_price):
        unrealized = sum(q * (last_price - p) for q, p in self.lots)
        return unrealized
```

## Source Code

```python
# Reconciliation break detection
def reconcile_oms_vs_clearing(oms_trades, clearing_trades):
    oms_set = {(t["id"], t["qty"], t["price"]) for t in oms_trades}
    clearing_set = {(t["id"], t["qty"], t["price"]) for t in clearing_trades}
    missing_in_clearing = oms_set - clearing_set
    extra_in_clearing = clearing_set - oms_set
    if missing_in_clearing or extra_in_clearing:
        print(f"BREAK: {len(missing_in_clearing)} trades missing in clearing")
        print(f"BREAK: {len(extra_in_clearing)} extra trades in clearing")
    else:
        print("RECONCILED OK")
```
