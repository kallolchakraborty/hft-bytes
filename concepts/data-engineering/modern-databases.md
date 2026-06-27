---
type: decision-matrix
title: "Modern Databases"
description: "ClickHouse: columnar, MergeTree engine, materialized views for pre-aggregation. InfluxDB: time-structured merge tree (TSM), continuous queries"
tags: ["data-engineering"]
difficulty: intermediate
timestamp: "2026-06-27T03:06:09.444Z"
phase: 12
phaseName: "Data Engineering"
category: "Phase 12 - Data Engineering"
subcategory: "data-engineering"
language: "cpp"
artifact-id: "ZHFT_MODERN_DATABASES"
---
## Key Learning Points

- ClickHouse: columnar, MergeTree engine, materialized views for pre-aggregation
- InfluxDB: time-structured merge tree (TSM), continuous queries
- TimescaleDB: hypertables, chunked time partitions, full SQL
- kdb+ vs ClickHouse vs InfluxDB — tradeoffs for HFT workloads
- Use case fit: real-time tick → kdb+, analytics → ClickHouse, IoT → InfluxDB

## Source Code

```cpp
/*
 *
 * USAGE:

 */
 *   ClickHouseConnector ch("localhost:8123");
 *   ch.execute("INSERT INTO market_data VALUES ...");
 *
 * PERFORMANCE TARGET:
 *   ClickHouse insert batch > 1M rows/sec
 * ====================================================================
 */

#include <string>
#include <vector>
#include <curl/curl.h>  // HTTP-based ClickHouse interface

// --------------------------------------------------------------------
// ClickHouse HTTP Connector

class ClickHouseConnector {
    std::string url_;

public:
    explicit ClickHouseConnector(const std::string& host)
        : url_("http://" + host + ":8123/") {}

    bool execute(const std::string& query) {
        CURL* curl = curl_easy_init();
        if (!curl) return false;
        curl_easy_setopt(curl, CURLOPT_URL, url_.c_str());
        curl_easy_setopt(curl, CURLOPT_POSTFIELDS, query.c_str());

        // tradeoff: HTTP overhead (~100μs) vs ClickHouse native TCP (10μs)
        // For HFT, Native TCP (port 9000) is preferable
        curl_easy_setopt(curl, CURLOPT_TIMEOUT, 5L);

        CURLcode res = curl_easy_perform(curl);
        curl_easy_cleanup(curl);
        return res == CURLE_OK;
    }

    // Create MergeTree table for market data
    static std::string createTableQuery() {
        return R"(
            CREATE TABLE IF NOT EXISTS market_data (
                symbol     String,
                timestamp  DateTime64(9),  -- nanosecond precision
                bid        Float64,
                ask        Float64,
                last       Float64,
                volume     UInt64
            ) ENGINE = MergeTree()
            PARTITION BY toYYYYMM(timestamp)
            ORDER BY (symbol, timestamp)
        )";
    }

    // Materialized view for pre-computed mid-price (1-min bars)
    // tradeoff: storage cost vs query speed
    static std::string materializedMidView() {
        return R"(
            CREATE MATERIALIZED VIEW mid_1min
            ENGINE = AggregatingMergeTree()
            PARTITION BY toYYYYMM(time)
            ORDER BY (symbol, time)
            AS SELECT
                symbol,
                toStartOfMinute(timestamp) AS time,
                avg((bid + ask) / 2) AS mid_avg,
                min((bid + ask) / 2) AS mid_low,
                max((bid + ask) / 2) AS mid_high
            FROM market_data
            GROUP BY symbol, time
        )";
    }
};

// --------------------------------------------------------------------
// InfluxDB Line Protocol Writer

class InfluxDBWriter {
    std::string url_;
    std::string bucket_;
    std::string org_;

public:
    // tradeoff: InfluxDB line protocol vs v2 JSON API
    // line protocol is 5x more compact → higher throughput
    void writePoint(const std::string& measurement,
                    const std::string& tags,
                    const std::string& fields,
                    int64_t timestamp_ns) {
        // format: measurement,tag1=val1 field1=1.0 1234567890
        // InfluxDB struggles with nanosecond precision at scale
        // HFT note: kdb+ still dominates for tick-level data
    }
};
```

## Decision Matrix

| DIMENSION | kdb+/q | ClickHouse | InfluxDB | TimescaleDB |
| --- | --- | --- | --- | --- |
| Ingestion (rows/sec) | 10M+ | 5M+ | 1M+ | 500K+ |
| Query Latency (1B rows) | < 1ms | < 10ms | < 100ms | < 50ms |
| Joins | as-of join | limited | none | full SQL |
| Time-Window Aggregation | built-in | +Aggregating | +Continuous | +Continuous |
| Schema-less | no | no | yes | no |
| SQL Compatibility | q only | SQL-like | Flux/InfluxQL | PostgreSQL |
| Concurrency | single/multi | multi | multi | multi |
| Replication | RDB only | distributed | enterprise | streaming |
| Pricing | $$$ (commercial) | free | free+cloud | free+cloud |
| HFT Popularity | STANDARD | growing | low | niche |
| MATRIX |
