---
type: reference
title: "Position Management"
description: "Max position limits per instrument and total portfolio VaR. Aging force: time-based unwind of stale positions"
tags: ["queue-dynamics"]
timestamp: "2026-06-27T03:06:09.438Z"
phase: 10
phaseName: "Trading Strategies"
category: "Phase 10 - Trading Strategies"
subcategory: "trading-strategies"
language: "cpp"
artifact-id: "ZHFT_POSITION_MGMT"
---
## Key Learning Points

- Max position limits per instrument and total portfolio VaR
- Aging force: time-based unwind of stale positions
- Inventory target zones: neutral band where no hedging is needed
- Cross-product hedging using futures and options
- Position keeping across multiple venues (netting)
- P&L attribution by strategy, instrument, venue, and time bucket

## Usage

PositionManager pm;
pm.setLimit("AAPL", 10000);
pm.update("AAPL", +200, 150.0, "NASDAQ");
pm.hedge("AAPL", "ES", -200);  // delta hedge with ES futures

## Source Code

```cpp
#include <unordered_map>
#include <string>
#include <chrono>

struct Position {
    double  quantity;       // +long / -short
    double  avg_entry;      // average entry price
    double  realized_pnl;
    double  unrealized_pnl;
    uint64_t first_trade_ns;
    uint64_t last_trade_ns;
};

class PositionManager {
    std::unordered_map<std::string, Position> positions_;
    std::unordered_map<std::string, double> limits_;
    double portfolio_var_limit_;

public:
    void setLimit(const std::string& symbol, double max_qty) {
        limits_[symbol] = max_qty;
    }

    bool checkLimit(const std::string& symbol, double delta_qty) {
        auto it = positions_.find(symbol);
        double current = it != positions_.end() ? it->second.quantity : 0;
        return std::abs(current + delta_qty) <= limits_[symbol];
    }

    void update(const std::string& symbol, double delta_qty,
                double price, const std::string& venue) {
        if (!checkLimit(symbol, delta_qty)) {
            // reject — risk limit breached; tradeoff: drop vs queue
            return;
        }
        auto& pos = positions_[symbol];
        if (pos.quantity == 0) {
            pos.avg_entry = price;
            pos.first_trade_ns = now();
        } else {
            // update average entry (FIFO simplification)
            // tradeoff: FIFO vs LIFO vs average — affects P&L attribution
            pos.avg_entry = (pos.avg_entry * std::abs(pos.quantity)
                            + price * std::abs(delta_qty))
                            / (std::abs(pos.quantity) + std::abs(delta_qty));
        }
        pos.quantity += delta_qty;
        pos.last_trade_ns = now();
        pos.unrealized_pnl = pos.quantity * (price - pos.avg_entry);
    }

    // aging: force-unwind positions older than max_age
    void agingForce(uint64_t max_age_ns) {
        uint64_t cutoff = now() - max_age_ns;
        for (auto& [sym, pos] : positions_) {
            if (pos.last_trade_ns < cutoff && std::abs(pos.quantity) > 0) {
                // emit unwind signal
                // tradeoff: aggressive unwind vs waiting for natural flow
                emitUnwind(sym, -pos.quantity);
            }
        }
    }

    // hedging: offset delta with correlated instrument
    void hedge(const std::string& symbol, const std::string& hedge_instr,
               double hedge_qty) {
        // simplified: hedge ratio could come from regression
        // tradeoff: cross-margining vs separate position tracking
    }

    struct PnLAttribution {
        double strategy_pnl;
        double instrument_pnl;
        double venue_pnl;
        double time_pnl;  // by minute bucket
    };

    PnLAttribution attribute(const std::string& strategy) {
        return {};  // decompose P&L by dimension
    }

private:
    static uint64_t now() {
        return std::chrono::steady_clock::now().time_since_epoch().count();
    }
    void emitUnwind(const std::string&, double) {}
};
```
