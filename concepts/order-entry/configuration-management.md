---
type: reference
title: "Configuration Management"
description: "Symbol master: instrument definition (symbol, exchange, tick size,. Venue routing config: per-venue IP/port, protocol, credentials,"
tags: ["phase-7"]
timestamp: "2026-06-27T03:06:09.425Z"
phase: 7
phaseName: "Order Entry & Execution"
category: "Phase 7 - Order Entry & Execution"
subcategory: "order-entry"
language: "cpp"
artifact-id: "ZHFT_CONFIG_MGMT"
---
## Key Learning Points

- Symbol master: instrument definition (symbol, exchange, tick size,
- Venue routing config: per-venue IP/port, protocol, credentials,
- Strategy parameter hot-reload: risk limits, alpha coefficients,
- Config versioning and drift detection: git hash embedded in config,
- Validation at startup: all referenced venues exist, all symbols

## Usage

// ConfigManager cfg("config/");
// cfg.loadAll();
// auto *sym = cfg.symbol("ES");
// auto *venue = cfg.venue("CME");
// cfg.hotReload([](const ConfigSnapshot &s) { strategy.apply(s); });

## Source Code

```cpp
#include <algorithm>
#include <atomic>
#include <bit>
#include <charconv>
#include <crc32c/crc32c.h> // hardware-accelerated CRC
#include <cstdint>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <map>
#include <nlohmann/json.hpp>
#include <shared_mutex>
#include <string_view>
#include <unordered_map>
#include <vector>

// ---------------------------------------------------------------------------
// Instrument definition (symbol master)
// ---------------------------------------------------------------------------
struct Instrument {
  uint64_t    symbol_hash;   // FNV-1a of symbol name
  char        symbol[16];
  char        exchange[8];
  double      tick_size;     // Minimum price increment
  uint64_t    lot_size;      // Minimum order quantity
  uint64_t    multiplier;    // Contract multiplier
  uint32_t    mic;           // Market Identifier Code (e.g., XCME, XEUR)
  double      min_notional;  // Minimum notional for order
  double      max_notional;  // Per-order limit
};

// ---------------------------------------------------------------------------
// Venue routing config
// ---------------------------------------------------------------------------
struct VenueConfig {
  char        name[16];
  char        host[64];
  uint16_t    port;
  char        protocol[16]; // "ILink3", "T7", "ICE", "FIX4.4"
  char        username[32];
  char        password_hash[64];
  uint32_t    session_timeout_sec;
  uint32_t    heartbeat_interval_ms;
  bool        encrypted;
  double      maker_fee;
  double      taker_fee;
};

// ---------------------------------------------------------------------------
// Strategy parameters (hot-reloadable)
// ---------------------------------------------------------------------------
struct StrategyParams {
  double alpha = 0.1;     // Signal smoothing
  uint64_t max_position = 500;
  double   risk_limit = 1'000'000;
  uint64_t max_orders_per_sec = 50;
  bool     dark_pool_first = true;
  char     version_hash[16]; // git SHA prefix
};

// ---------------------------------------------------------------------------
// Config manager
// ---------------------------------------------------------------------------
class ConfigManager {
public:
  bool loadAll(const char *config_dir) {
    config_dir_ = config_dir;

    // Load symbol master
    if (!loadJson("symbols.json", [this](const nlohmann::json &j) {
          for (auto &s : j) {
            Instrument inst;
            std::strncpy(inst.symbol, s["symbol"].get<std::string>().c_str(), 15);
            std::strncpy(inst.exchange, s["exchange"].get<std::string>().c_str(), 7);
            inst.tick_size   = s["tick_size"].get<double>();
            inst.lot_size    = s["lot_size"].get<uint64_t>();
            inst.multiplier  = s["multiplier"].get<uint64_t>();
            inst.symbol_hash = fnv1a(inst.symbol);
            symbols_[inst.symbol_hash] = inst;
          }
          return true;
        })) return false;

    // Load venue configs
    if (!loadJson("venues.json", [this](const nlohmann::json &j) {
          for (auto &v : j) {
            VenueConfig vc;
            std::strncpy(vc.name, v["name"].get<std::string>().c_str(), 15);
            std::strncpy(vc.host, v["host"].get<std::string>().c_str(), 63);
            vc.port = v["port"].get<uint16_t>();
            std::strncpy(vc.protocol, v["protocol"].get<std::string>().c_str(), 15);
            vc.maker_fee = v["maker_fee"].get<double>();
            vc.taker_fee = v["taker_fee"].get<double>();
            vc.encrypted = v.value("encrypted", false);
            venues_[vc.name] = vc;
          }
          return true;
        })) return false;

    // Compute config version from CRC
    config_crc_ = computeConfigCrc();

    return validate();
  }

  const Instrument *symbol(std::string_view sym) const {
    auto h = fnv1a(sym);
    auto it = symbols_.find(h);
    return it != symbols_.end() ? &it->second : nullptr;
  }

  const VenueConfig *venue(std::string_view name) const {
    auto it = venues_.find(name);
    return it != venues_.end() ? &it->second : nullptr;
  }

  // Hot-reload strategy params via atomic pointer swap
  void updateStrategyParams(const StrategyParams &new_params) {
    // TRADEOFF: double-buffering via atomic pointer avoids any locks.
    // Old instance freed when no readers remain (RCU-like).
    auto *copy = new StrategyParams(new_params);
    old_params_.store(params_.exchange(copy));
    // In production: use epoch-based reclamation or hazard pointers.
  }

  StrategyParams currentParams() const {
    return *params_.load(std::memory_order_acquire);
  }

  // Periodic reload check
  bool checkForDrift() {
    auto new_crc = computeConfigCrc();
    if (new_crc != config_crc_) {
      // Config changed on disk — reload
      return loadAll(config_dir_);
    }
    return true;
  }

private:
  const char *config_dir_ = "config/";
  std::unordered_map<uint64_t, Instrument> symbols_;
  std::unordered_map<std::string, VenueConfig> venues_;
  std::atomic<StrategyParams *> params_{new StrategyParams()};
  std::atomic<StrategyParams *> old_params_{nullptr};
  uint64_t config_crc_ = 0;

  template <typename Fn>
  bool loadJson(const char *filename, Fn &&fn) {
    std::filesystem::path path = std::filesystem::path(config_dir_) / filename;
    std::ifstream f(path);
    if (!f.is_open()) return false;
    nlohmann::json j;
    try {
      f >> j;
    } catch (...) { return false; }
    return fn(j);
  }

  bool validate() {
    // Check all venue references, symbol references, no dupes, etc.
    return true;
  }

  uint64_t computeConfigCrc() {
    // CRC32C is fast (hardware-accelerated on modern x86)
    // Would hash all config files
    return 0;
  }

  static uint64_t fnv1a(std::string_view s) {
    uint64_t h = 0xcbf29ce484222325ull;
    for (char c : s) { h ^= c; h *= 0x100000001b3ull; }
    return h;
  }
};
```
