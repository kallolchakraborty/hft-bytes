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

- q language: tables as columnar lists, k-syntax for vectors
- As-of join (aj): real-time best bid/ask at event time (key insight)
- Splayed tables: column stored as individual files, good for HDB
- Partitioned tables: date partitions for daily query pruning
- RDB (in-memory) + HDB (on-disk): chained queries with .u.sub
- Chained queries: select with each (') for time-decay operations

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
