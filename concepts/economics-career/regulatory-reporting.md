---
type: reference
title: "Regulatory Reporting Engineering"
description: "CAT (US Consolidated Audit Trail), MiFID II transaction reporting (EU), EMIR trade reporting — file format specs, submission deadlines, error handling/corrections, reconciliation processes, and the engineering architecture required for regulatory compliance."
tags: ["economics-career"]
difficulty: intermediate
timestamp: "2026-06-27T06:00:00.000Z"
phase: 16
phaseName: "HFT Economics & Career"
category: "Career"
subcategory: "economics-career"
language: "python"
artifact-id: "ZHFT_REGULATORY_REPORTING"
---
## Key Learning Points

- CAT (Consolidated Audit Trail, US): FINRA requires order-event reporting (New, Route, Fill, Cancel, Modify) in daily files per OATS-like spec; fields include OrderID, CustomerID, RouteID, Timestamps (nanosecond), Side, Symbol, Qty, Price; files submitted via CAT Reporter Gateway; correction files must be sent within T+3
- MiFID II transaction reporting (EU): report within T+1 to National Competent Authority via Approved Reporting Mechanism (ARM) or directly; fields: LEI, ISIN, trading capacity (DEAL/MTCH), price, quantity, venue, country of venue, date/time, counterparty; complex instruments require delta-equivalent reporting
- EMIR trade reporting (derivatives): report to Trade Repository (DTCC, REGIS-TR, UnaVista) within T+1 for all derivatives (exchange-traded and OTC); includes valuation, collateral, counterparty LEI; lifetime updates required until termination
- Error handling: validation failures (schema, field format, reference data) → correct and resubmit within cutoff; late submissions incur fines (MiFID II: up to €5M or 10% of turnover); reconciliation between reporting system and exchange confirms is critical
- Engineering architecture: trade capture → enrichment (LEI lookup, ISIN validation) → batch generation (hourly/daily) → submission via SFTP/API → reconciliation with exchange drop-copy → correction pipeline

```html
<div class="ad-wrapper">
  <div class="ad-title">Regulatory Reporting Pipeline</div>
  <div class="ad-flow">
    <div class="ad-stage active"><span class="ad-stage-icon">📥</span><span class="ad-stage-label">Trade Capture</span></div>
    <div class="ad-arrow"><span class="material-symbols-outlined">chevron_right</span><span class="ad-packet"></span></div>
    <div class="ad-stage"><span class="ad-stage-icon">🏷️</span><span class="ad-stage-label">Enrichment</span></div>
    <div class="ad-arrow"><span class="material-symbols-outlined">chevron_right</span><span class="ad-packet"></span></div>
    <div class="ad-stage"><span class="ad-stage-icon">📄</span><span class="ad-stage-label">File Generation</span></div>
    <div class="ad-arrow"><span class="material-symbols-outlined">chevron_right</span><span class="ad-packet"></span></div>
    <div class="ad-stage"><span class="ad-stage-icon">📤</span><span class="ad-stage-label">Submission</span></div>
    <div class="ad-arrow"><span class="material-symbols-outlined">chevron_right</span><span class="ad-packet"></span></div>
    <div class="ad-stage"><span class="ad-stage-icon">✅</span><span class="ad-stage-label">Reconciliation</span></div>
  </div>
</div>
```

## Usage

```python
# CAT event file row format (CSV)
# Header: OrderID|CustomerID|RouteID|EventType|Timestamp|Side|Symbol|Qty|Price
# Sample: ORD001|CUST001|ROUTE01|NEW|20260627-10:01:32.123456789|B|AAPL|100|189.23

# MiFID II transaction report fields (ISO 20022 XML)
# <TxRpt>
#   <Rpt>
#     <FinInstrmId><ISIN>US0378331005</ISIN></FinInstrmId>
#     <TradgCpcty>DEAL</TradgCpcty>
#     <Pric>189.23</Pric>
#     <Qty>100</Qty>
#     <ExctnDtTm>2026-06-27T10:01:32.123Z</ExctnDtTm>
#     <Venue>XNAS</Venue>
#   </Rpt>
# </TxRpt>
```

## Source Code

```python
import csv, hashlib
from datetime import datetime, timedelta

def build_cat_events(order_log: list, output_path: str):
    """Generate CAT-compliant event file from OMS order log."""
    with open(output_path, 'w', newline='') as f:
        w = csv.writer(f, delimiter='|')
        w.writerow(["OrderID", "CustomerID", "EventType", "Timestamp", "Side", "Symbol", "Qty", "Price"])
        for o in order_log:
            ts = o["timestamp"].strftime("%Y%m%d-%H:%M:%S.%f")
            w.writerow([o["id"], o.get("customer", "CUST001"),
                        o["event"], ts, o["side"], o["symbol"],
                        o["qty"], f"{o['price']:.2f}"])

def reconcile_reports(report_file: str, clearing_file: str):
    """Flag mismatches between generated report and clearing records."""
    # Returns list of unmatched entries
    pass
```
