---
type: reference
title: "KDB"
description: "q language: tables as columnar lists, k-syntax for vectors. As-of join (aj): real-time best bid/ask at event time (key insight)"
tags: ["phase-12"]
difficulty: intermediate
timestamp: "2026-06-27T03:06:09.444Z"
phase: 12
phaseName: "Data Engineering"
category: "Phase 12 - Data Engineering"
subcategory: "data-engineering"
language: "cpp"
artifact-id: "ZHFT_KDB"
---
## Key Learning Points

- **q language**: tables as columnar lists, k-syntax for vectors — q is a vector-oriented language where every operation applies to entire columns at once (no row-by-row loops). A table is a dictionary of column_name → column_vector. Example: `t:([]sym:`AAPL`GOOG;price:150.0 2800.0)` creates a 2-row table. Column operations are vectorized: `select avg price by sym from t` processes the entire column in one pass. For HFT: q's vectorized execution is 10-100x faster than row-by-row SQL for analytical queries. The tradeoff: q syntax is cryptic (k-syntax: `t%2` means "divide each element by 2") and debugging is painful. Invest in learning q — the performance payoff is enormous for time-series analytics
- **As-of join (aj)**: real-time best bid/ask at event time — the most important q operation for HFT. `aj[`sym`time; trade_table; quote_table]` matches each trade to the most recent quote at the time of the trade. This gives you the bid/ask spread at the moment of each trade — essential for slippage analysis, fill quality measurement, and execution cost attribution. For HFT: aj is the backbone of real-time position tracking. When you receive a fill, you need to know the current bid/ask to calculate slippage. aj gives you this in O(1) per trade (using the sorted-table binary search). Without aj, you'd need to iterate through the quote table for each trade — O(n²) for n trades
- **Splayed tables**: column stored as individual files, good for HDB (Historical DataBase) — each column is a separate file on disk (e.g., `sym`, `time`, `bid`, `ask`). Splayed tables enable column-oriented queries: if you only need `bid` and `ask`, you read only those two files, not the entire table. For HFT: splayed tables reduce I/O by 5-10x for column-select queries. The downside: insert performance is slower (must append to each column file separately). Use splayed tables for HDB (read-heavy) and in-memory tables for RDB (write-heavy)
- **Partitioned tables**: date partitions for daily query pruning — the HDB is partitioned by date (e.g., `2024.01.01/`, `2024.01.02/`). Queries with a `where date=...` clause only read the relevant partition, skipping all other dates. For HFT: date partitioning reduces query time from seconds (scan entire HDB) to milliseconds (scan one day). Partition pruning is automatic — q's query optimizer detects the date filter and skips non-matching partitions. The tradeoff: partitioning adds complexity to data management (ingestion, cleanup, backup)
- **RDB (in-memory) + HDB (on-disk)**: chained queries with `.u.sub` — the RDB holds today's data in memory (fast writes, fast queries), the HDB holds historical data on disk (slow writes, fast column-select queries). At end-of-day, the RDB is flushed to the HDB partition. `.u.sub` is the pub/sub mechanism that streams data from the RDB to subscribers. For HFT: the RDB is your real-time analytics engine — run position tracking, risk calculations, and slippage analysis on the RDB. At end-of-day, query the HDB for historical analysis (backtesting, parameter optimization). The chained query: `select from RDB where sym=x` UNION `select from HDB where date=today, sym=x`
- **Chained queries**: select with each (') for time-decay operations — `each` applies a function to each element of a list. Example: `{select avg price by time.minute from x}(/:tables)` runs the same query on multiple tables. For HFT: chained queries are used for cross-asset analytics (query the same time window across equity, futures, and options tables). The `each` operator is parallelized automatically across CPU cores — q handles the parallelism transparently. For large-scale analytics, chained queries on partitioned tables leverage both date pruning and multi-core parallelism

## Usage

q script: `\l feed.q` then `select mid:(bid+ask)%2 from quote where sym=`AAPL`
C++ via kdb+ C API: khp, k, exec from libk.h

## Source Code

```cpp
// kdb+ C API interface (simplified illustrative fragments)
// Compile: gcc -I$QHOME/l64 -L$QHOME/l64 -lkdb hf.cpp -o hf

extern "C" {
    #include <k.h>    // kdb+ C API type definitions (I, K, etc.)
    #include <kdb.h>  // khp, k, kR
}

#include <cstdio>
#include <cstdint>

// q schema:
//   quote:([sym:`symbol$(); time:`timestamp$()] bid:`float$(); ask:`float$(); bsz:`int$(); asz:`int$())
//   trade:([sym:`symbol$(); time:`timestamp$()] price:`float$(); size:`int$())

class KdbIngest {
    K conn_;  // kdb+ connection handle
    int port_{5010};
    const char* host_{"localhost"};

public:
    bool connect() {
        conn_ = khp(const_cast<char*>(host_), port_);
        return conn_ != nullptr;
    }

    // Bulk insert into kdb+ using vector attributes
    // tradeoff: single-row insert vs batch (batch is 100x faster)
    void insertQuotes(const std::vector<double>& bids,
                      const std::vector<double>& asks,
                      const std::vector<int>& bsizes,
                      const std::vector<int>& asizes) {
        // Build columnar q table
        // q: `quote insert (sym; time; bid; ask; bsz; asz)
        // tradeoff: kdb+ columnar engine thrives on vector inserts
        K cols = ktn(0, 6);  // list of 6 columns
        kK(cols)[0] = ktn(KG, bids.size());   // sym (symbol list, simplified)
        kK(cols)[1] = ktn(KP, bids.size());   // time (timestamp)
        kK(cols)[2] = kf(bids.data());        // bid
        kK(cols)[3] = kf(asks.data());        // ask
        kK(cols)[4] = ki(bsizes.data());      // bsz
        kK(cols)[5] = ki(asizes.data());      // asz

        // Synchronous q exec (tradeoff: sync vs async with .u.sub)
        K result = k(conn_, "insert", ki(0), kp(const_cast<char*>("quote")), cols, (K)0);
        if (result->t == -128) { // error type
            printf("kdb+ error: %s\n", result->s);
        }
        r0(result);  // release reference
    }

    // As-of join in C++: select mid from aj[`sym`time; trade; quote]
    double queryMidPrice(const char* sym, int64_t time_ns) {
        // q: aj[`sym`time; select from trade where sym=x;
        //     select from quote where sym=x]
        K sym_k = kp(const_cast<char*>(sym));
        K time_k = kp(const_cast<char*>("timestamp"));  // type cast
        // tradeoff: string query vs k construction (k() is simpler but slower)
        K q = k(conn_, "select mid:(0.5*bid+ask)%2 from aj[`sym`time;"
               "(select from trade where sym=$1);"
               "(select from quote where sym=$1)]"
               "where time=$2", sym_k, time_k, (K)0);
        if (q->t == 0) return -1;  // null
        double mid = kF(q);
        r0(q);
        return mid;
    }

    ~KdbIngest() {
        if (conn_) kclose(conn_);
    }
};
```
