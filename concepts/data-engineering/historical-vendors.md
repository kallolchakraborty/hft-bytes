---
type: reference
title: "Historical Data Vendors & Quality"
description: "TickData, OneTick, Dukascopy, Polygon, QuantHouse historical, Kibot — data quality differences, normalization, survivorship bias, corporate action adjustments, tick vs OHLCV tradeoffs for reliable HFT backtesting research."
tags: ["data-engineering"]
timestamp: "2026-06-27T04:00:00.000Z"
phase: 12
phaseName: "Data Engineering"
category: "Data Engineering"
subcategory: "data-engineering"
language: "python"
artifact-id: "ZHFT_HISTORICAL_VENDORS"
---
## Key Learning Points

- TickData (US equities): best raw tick coverage since 2003; NBBO, trades, quotes in native TH5 format; export to CSV/Parquet; survivorship bias present — delisted securities dropped from monthly files unless explicitly requested (full corporate actions DB)
- OneTick: kdb+ compatible tick database; MS SQL backend; PQL query language inspired by q; used by top systematic funds; one-time license fee + annual maintenance; Python/PHP/REST APIs; can store thousands of symbols in a single database
- Dukascopy (forex): raw tick data for 50+ FX pairs; JForex API; 1-min bar granularity available; free 24-hr delayed, live requires funded account; known issue: tick data has occasional gaps during low-liquidity Asian session
- Polygon.io: REST & gRPC streaming; covers equities, options, futures, forex; corporate actions (splits/dividends) included in `aggs/bars` endpoint; real-time + historical with single API; gRPC for low-latency data access without WebSocket complexity
- Surveyorship bias: vendors remove delisted stocks from monthly snapshots; backtests that use current S&P 500 look fantastic but fail on historical constituents; must subscribe to full universe files + CRSP delisting returns
- Corporate action adjustments: split adjustment (multiply/dividide prices), dividend adjustment (subtract cash div from prev close), rights offering (dilution factor); unadjusted data introduces false arbitrage signals; split adjustment error of 1 tick per event compounds to 100+ ticks over 10 years
- Tick vs OHLCV: raw tick preserves every quote/trade (orders of magnitude larger), enables microstructure analysis; OHLCV bars (1-min, 5-min, daily) miss intrabar volatility and order-flow dynamics; use tick for strategy research, OHLCV for portfolio-level backtesting

## Usage

```python
# Polygon historical data query (gRPC)
import grpc
from polygon.grpc import aggs_pb2, aggs_pb2_grpc

channel = grpc.insecure_channel("grpc.polygon.io:443")
stub = aggs_pb2_grpc.AggsStub(channel)
req = aggs_pb2.AggsRequest(
    ticker="AAPL",
    multiplier=1,
    timespan="minute",
    from_="2026-01-01",
    to="2026-06-01"
)
for bar in stub.GetAggs(req):
    # bar.open, bar.high, bar.low, bar.close, bar.volume
    # bar.vwap, bar.transactions, bar.otc
    pass

# Survivorship bias check: compare backtest PnL using current SPX vs historical constituents
def asset_universe_at(date, vendor="tickdata"):
    # Query TickData for all securities listed on date
    pass

# Corporate action adjustment rule:
# adjusted_close = close * split_factor - dividend_adjustment
# split_factor = post_split_shares / pre_split_shares (e.g., 4-for-1 → 0.25)
```

## Source Code

```python
# Detect and correct survivorship bias in backtesting
import pandas as pd
from datetime import date

def load_delisted_returns(start: date, end: date) -> pd.DataFrame:
    """Load CRSP delisting returns for vanished tickers."""
    pass

def adjust_for_corp_actions(raw_df: pd.DataFrame) -> pd.DataFrame:
    """Apply split and dividend adjustments to price series."""
    for event in raw_df.corp_actions:
        if event.type == "SPLIT":
            ratio = float(event.data.split("/")[0]) / float(event.data.split("/")[1])
            raw_df.loc[:event.date, ["open","high","low","close"]] /= ratio
            raw_df.loc[:event.date, "volume"] *= ratio
        elif event.type == "DIVIDEND":
            raw_df.loc[:event.date, ["open","high","low","close"]] -= event.amount
    return raw_df
```
