---
type: reference
title: "Historical Data"
description: "Hot/Warm/Cold tiering: hot = RAM/SSD (latest 30d), warm = SSD (1yr),. Retention policies: SEC Rule 17a-4 (3yr for broker-dealers), MiFID II (5yr)"
tags: ["backtesting", "data-engineering"]
difficulty: intermediate
timestamp: "2026-06-27T03:06:09.443Z"
phase: 12
phaseName: "Data Engineering"
category: "Phase 12 - Data Engineering"
subcategory: "data-engineering"
language: "cpp"
artifact-id: "ZHFT_HISTORICAL_DATA"
---
## Key Learning Points

- **Hot/Warm/Cold tiering**: hot = RAM/SSD (latest 30d, sub-millisecond access), warm = SSD (1-5yr, ~100μs access), cold = object storage/S3 (5yr+, ~10ms access). Tiering is based on access frequency — recent data is accessed constantly (live trading, risk calculations), old data is accessed rarely (regulatory queries, historical research). For HFT: keep 30 days of tick data in RAM (mmap or preloaded into `std::vector<TickRecord>`). Use NVMe SSD for 1-5yr data (random access in ~100μs). Object storage for archived data (regulatory retention). The tiering decision is automatic — data older than 30 days is flushed to SSD, data older than 5 years is archived to S3
- **Retention policies**: SEC Rule 17a-4 (3yr for broker-dealers), MiFID II (5yr for all EU trading), CFTC (5yr for futures), Dodd-Frank (7yr for swaps). Non-compliance penalties: SEC fines up to $1M per violation, MiFID II criminal charges for intentional destruction. For HFT: build a retention engine that automatically tags data with its regulatory retention period (3yr for US equities, 5yr for EU futures, 7yr for swaps). The retention engine must prevent premature deletion — use WORM (Write Once Read Many) storage for the first 3 years. Data destruction requires documented approval from the compliance officer
- **Columnar formats**: Parquet (predicate pushdown, min/max stats, compression) — Parquet stores data by column, not by row. Predicate pushdown: if you query `where sym=AAPL`, Parquet skips columns that don't match the predicate (e.g., `GOOG` column files). Min/max stats in Parquet metadata enable further pruning — if a column's min > your query's max, skip the entire column file. Compression: columnar data compresses 3-5x better than row-oriented data (similar values are adjacent). For HFT: Parquet is ideal for historical analytics (backtesting, parameter optimization). Use Apache Arrow for in-memory representation (zero-copy from Parquet, vectorized operations). The tradeoff: Parquet writes are slower than row-oriented formats (column sorting overhead)
- **Data lake architecture**: raw → cleaned → derived → features. Raw: unmodified exchange data (binary recordings, FIX logs). Cleaned: normalized timestamps, validated prices, gap-filled. Derived: computed metrics (VWAP, spread, depth features). Features: strategy-specific inputs (momentum signals, order flow imbalance). For HFT: the raw layer is your audit trail — never modify raw data. The cleaned layer handles data quality issues (exchange bugs, recording gaps, timestamp misalignment). The derived layer is reusable across strategies (VWAP, spread, volatility are strategy-agnostic). The features layer is strategy-specific (each strategy has its own feature computation)
- **Data catalogs**: AWS Glue, Apache Atlas for discoverability — data catalogs store metadata (schema, lineage, quality metrics) and enable search across datasets. For HFT: the catalog answers "what data do I have?" and "where did this feature come from?" Use the catalog to track data lineage: which raw data produced which cleaned data, which derived metrics, which features. Lineage is critical for debugging — if a strategy produces anomalous signals, trace back through the catalog to find the root cause (bad raw data, incorrect cleaning, wrong feature computation). The catalog also tracks data freshness — alert if cleaned data is more than 1 hour stale

## Usage

DataLifecycleManager dlc("/data/market");
dlc.tier("2024-01-01", Tier::COLD);
auto ds = dlc.open("2024-06-15", "2024-06-16");

## Source Code

```cpp
#include <string>
#include <vector>
#include <chrono>
#include <fstream>

// --------------------------------------------------------------------
// Data Lifecycle Manager

class DataLifecycleManager {
    enum class Tier { HOT, WARM, COLD };
    std::string base_path_;

    struct RetentionRule {
        int retention_days;
        Tier target_tier;
        bool delete_after;
    };

    std::vector<RetentionRule> rules_;

public:
    explicit DataLifecycleManager(std::string base) : base_path_(std::move(base)) {
        // Default rules: 30d hot, 1y warm, then archive
        rules_ = {
            {30,  Tier::HOT,  false},
            {365, Tier::WARM, false},
            {1825, Tier::COLD, false},  // 5y for MiFID II
        };
    }

    void tier(const std::string& date, Tier target) {
        // Move date partition between storage tiers
        // tradeoff: symlink vs hardlink vs copy+delete
        // Hot: /data/ssd/2024/06/15/  →  Warm: /data/hdd/2024/06/15/
        std::string src = pathForTier(date, currentTier(date));
        std::string dst = pathForTier(date, target);
        // rename(src, dst);  // atomic within same filesystem
    }

    // Retention enforcement — delete or archive expired data
    void enforceRetention() {
        auto now = std::chrono::system_clock::now();
        for (auto& rule : rules_) {
            // iterates partitions older than rule.retention_days
            // tradeoff: scan all vs indexed partition catalog
        }
    }

    // Regulatory compliance: WORM (Write Once Read Many) for cold tier
    // SEC 17a-4 requires non-rewritable, non-erasable storage
    // Object lock on S3 or WORM tape library
    void enableWorm(const std::string& period) {
        // set immutable flag on cold tier objects
    }

private:
    Tier currentTier(const std::string& date) const { return Tier::HOT; }
    std::string pathForTier(const std::string& date, Tier t) const { return {}; }
};

// --------------------------------------------------------------------
// Parquet Schema for Market Data (using Arrow/Parquet C++)

// Parquet: columnar, compressed with snappy/zstd, min/max/bloom filters
// Schema for tick data:

/*
message MarketData {
    required binary symbol (STRING);
    required int64  timestamp_ns (TIMESTAMP(NANOS, true));
    optional float  bid;
    optional float  ask;
    optional float  last;
    optional int32  bid_size;
    optional int32  ask_size;
    optional int32  last_size;
    optional float  volume;
}
*/

class ParquetMarketWriter {
    // Using Apache Arrow Parquet C++ API
    // tradeoff: row group size (default 1M rows) vs memory pressure
    // tradeoff: dictionary encoding for symbol (high cardinality → disable)
    // tradeoff: compression codec — zstd (better ratio) vs snappy (faster)

public:
    void writeSchema() {
        // auto schema = arrow::schema({
        //     arrow::field("symbol", arrow::utf8()),
        //     arrow::field("timestamp_ns", arrow::int64()),
        //     arrow::field("bid", arrow::float64()),
        //     arrow::field("ask", arrow::float64()),
        // });
        //
        // tradeoff: float32 vs float64 — 50% storage reduction, precision loss ok
        // for prices in dollars.cents, float64 is safer
    }
};

// --------------------------------------------------------------------
// Data Lake Directory Structure

// /data/market/
//   raw/                — vendor dump, schema-on-read
//     exchange=NYSE/date=2024-06-15/
//     exchange=NASDAQ/date=2024-06-15/
//   cleaned/            — deduped, sorted, gap-checked
//     sym=AAPL/date=2024-06-15/
//     sym=MSFT/date=2024-06-15/
//   derived/            — aggregated bars, features
//   features/           — ML-ready feature vectors
//     min_1/            — 1-min bars with 200 features

// Data Catalog (Apache Atlas / Unity Catalog)
// tradeoff: heavy catalog vs file-system convention (Hive-style partitions)
// Hive-style: sym=AAPL/date=2024-06-15/part-00001.parquet
// → discovered by Spark PREDICATE PUSHDOWN
```
