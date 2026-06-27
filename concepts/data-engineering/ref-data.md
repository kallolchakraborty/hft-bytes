---
type: reference
title: "Ref Data"
description: "Symbol master schema: ISIN, CUSIP, SEDOL, exchange, ticker. Instrument reference: currency, lot size, tick increment, market cap"
tags: ["data-engineering"]
timestamp: "2026-06-27T03:06:09.445Z"
phase: 12
phaseName: "Data Engineering"
category: "Phase 12 - Data Engineering"
subcategory: "data-engineering"
language: "cpp"
artifact-id: "ZHFT_REF_DATA"
---
## Key Learning Points

- Symbol master schema: ISIN, CUSIP, SEDOL, exchange, ticker
- Instrument reference: currency, lot size, tick increment, market cap
- Corporate actions: dividends (amount, ex-date, pay-date), stock splits
- Mergers/acquisitions, spin-offs, name changes → symbol mapping history
- Calendar management: trading holidays, early closes, rollover schedules
- Data vendor integration: Bloomberg, Reuters, exchange direct feeds

## Usage

SymbolMaster sm;
sm.addInstrument("AAPL", "US0378331005", "NASDAQ");
CorpActionsProcessor cap;
cap.applySplit("AAPL", 4, 1, "2024-08-28");

## Source Code

```cpp
#include <string>
#include <unordered_map>
#include <vector>
#include <algorithm>

struct InstrumentRecord {
    std::string ticker;
    std::string isin;
    std::string cusip;
    std::string exchange;
    std::string currency;
    double      lot_size;
    double      tick_increment;
    std::string sector;
    uint64_t    listed_ns;
    uint64_t    delisted_ns;
};

class SymbolMaster {
    std::unordered_map<std::string, InstrumentRecord> by_ticker_;
    std::unordered_map<std::string, std::string> by_isin_;  // ISIN → ticker

public:
    void addInstrument(const InstrumentRecord& rec) {
        by_ticker_[rec.ticker] = rec;
        by_isin_[rec.isin] = rec.ticker;
    }

    const InstrumentRecord* lookup(const std::string& ticker_or_isin) {
        auto it = by_ticker_.find(ticker_or_isin);
        if (it != by_ticker_.end()) return &it->second;
        auto iit = by_isin_.find(ticker_or_isin);
        if (iit != by_isin_.end()) return &by_ticker_[iit->second];
        return nullptr;
    }

    // Tradeoff: O(1) hash vs ordered map (range queries on sector)
};

// --------------------------------------------------------------------
// Corporate Actions Processor

struct CorpAction {
    enum Type { DIVIDEND, SPLIT, MERGER, SPINOFF, NAME_CHANGE };
    Type     type;
    std::string symbol;
    uint64_t effective_ns;
    union {
        struct { double amount; double currency_rate; } dividend;
        struct { int from; int to; } split;            // 4:1 split → from=4,to=1
        struct { std::string target; double ratio; } merger;
    };
};

class CorpActionsProcessor {
    std::vector<CorpAction> actions_;
    size_t replay_idx_{0};

public:
    void addAction(const CorpAction& ca) {
        actions_.push_back(ca);
        // tradeoff: sorted insert vs sort once
        std::sort(actions_.begin(), actions_.end(),
                  [](auto& a, auto& b) { return a.effective_ns < b.effective_ns; });
    }

    // Replay actions to a given time (for backtester)
    std::vector<CorpAction> replayTo(uint64_t time_ns) {
        std::vector<CorpAction> triggered;
        while (replay_idx_ < actions_.size() &&
               actions_[replay_idx_].effective_ns <= time_ns) {
            triggered.push_back(actions_[replay_idx_++]);
        }
        return triggered;
    }

    // Adjust historical price for splits
    static double adjustPrice(double price, const CorpAction& ca) {
        if (ca.type == CorpAction::SPLIT) {
            return price * ca.split.from / static_cast<double>(ca.split.to);
        }
        return price;
    }
};

// --------------------------------------------------------------------
// Trading Calendar

class TradingCalendar {
    struct Session {
        uint64_t date;       // YYYYMMDD
        uint64_t open_ns;    // nanoseconds since midnight
        uint64_t close_ns;
        bool     early_close;
    };

    std::vector<Session> sessions_;

public:
    bool isTradingDay(uint64_t date_ns) const {
        auto it = std::lower_bound(sessions_.begin(), sessions_.end(), date_ns,
                    [](const Session& s, uint64_t d) { return s.date < d; });
        return it != sessions_.end() && it->date == date_ns;
    }

    // Futures roll schedule
    struct RollSchedule {
        std::string contract;
        uint64_t first_notice_ns;
        uint64_t last_trade_ns;
        uint64_t roll_recommend_ns;
    };
};
```
