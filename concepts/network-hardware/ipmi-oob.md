---
type: reference
title: "IPMI Oob"
description: "IPMI (Intelligent Platform Management Interface) runs on a BMC. iDRAC (Dell Integrated Dell Remote Access Controller) and iLO"
tags: ["phase-6"]
difficulty: intermediate
timestamp: "2026-06-27T03:06:09.419Z"
phase: 6
phaseName: "Network Hardware"
category: "Phase 6 - Network Hardware"
subcategory: "network-hardware"
language: "cpp"
artifact-id: "ZHFT_IPMI_OOB"
---
## Key Learning Points

- IPMI (Intelligent Platform Management Interface) runs on a BMC
- iDRAC (Dell Integrated Dell Remote Access Controller) and iLO
- Redfish (DMTF standard) is the modern REST API for server
- Serial Over LAN (SOL) provides serial console access over the
- Remote power cycle: IPMI chassis power commands (power on,
- Virtual media: mount an ISO image for OS installation or rescue
- Sensor monitoring: IPMI provides temperature, voltage, fan speed,
- BMC security concerns: the BMC runs its own OS (often Linux-based),

## Usage

// g++ -O3 -std=c++20 -lcurl ZHFT_IPMI_OOB.txt -o ipmi_client
// ./ipmi_client
// Requires libcurl for Redfish API calls.

## Source Code

```cpp
#include <algorithm>
#include <array>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <iostream>
#include <map>
#include <optional>
#include <span>
#include <sstream>
#include <string>
#include <string_view>
#include <vector>

// ====================================================================
// Redfish API client for server inventory.
// Uses libcurl (curl/curl.h) in production; here we simulate the
// HTTP calls with mock responses for documentation.
// ====================================================================

// -------------------------------------------------------------------
// Mock Redfish response parser — in production, use nlohmann/json or
// simdjson to parse the JSON response efficiently.
// -------------------------------------------------------------------
struct ServerInfo {
    std::string id;
    std::string model;
    std::string serial_number;
    std::string bios_version;
    std::string firmware_version;
    std::string power_state;            // On, Off, PoweringOn
    double      cpu_temperature_c;      // from sensors
    int         fan_speed_pct;
    int         memory_gb;
    int         num_cpus;
};

class RedfishClient {
public:
    RedfishClient(std::string_view bmc_ip, std::string_view username,
                  std::string_view password)
        : base_url_{"https://" + std::string{bmc_ip} + "/redfish/v1/"}
        , username_{username}, password_{password}
    {}

    // -----------------------------------------------------------------
    // Get system inventory from /redfish/v1/Systems/{id}.
    // -----------------------------------------------------------------
    auto GetSystemInfo() -> std::optional<ServerInfo> {
        // In production:
        //   CURL* curl = curl_easy_init();
        //   curl_easy_setopt(curl, CURLOPT_URL, (base_url_ + "Systems/1").c_str());
        //   curl_easy_setopt(curl, CURLOPT_HTTPAUTH, CURLAUTH_BASIC);
        //   curl_easy_setopt(curl, CURLOPT_USERPWD, (username_ + ":" + password_).c_str());
        //   curl_easy_setopt(curl, CURLOPT_SSL_VERIFYPEER, 0L);
        //   curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, WriteCallback);
        //   curl_easy_perform(curl);

        // Simulated response.
        std::cout << "[Redfish] GET " << base_url_ << "Systems/1\n";
        ServerInfo info{
            .id = "1",
            .model = "PowerEdge R7525",
            .serial_number = "SN12345678",
            .bios_version = "2.15.0",
            .firmware_version = "iDRAC 7.00.00.00",
            .power_state = "On",
            .cpu_temperature_c = 62.5,
            .fan_speed_pct = 35,
            .memory_gb = 512,
            .num_cpus = 2,
        };

        // Authenticate and fetch (mocked).
        return info;
    }

    // -----------------------------------------------------------------
    // Power control.
    // -----------------------------------------------------------------
    auto PowerOn() -> bool {
        std::cout << "[Redfish] POST " << base_url_
                  << "Systems/1/Actions/ComputerSystem.Reset "
                  << "(ResetType=On)\n";
        return true;
    }

    auto PowerOff() -> bool {
        std::cout << "[Redfish] POST " << base_url_
                  << "Systems/1/Actions/ComputerSystem.Reset "
                  << "(ResetType=ForceOff)\n";
        return true;
    }

    auto PowerCycle() -> bool {
        std::cout << "[Redfish] POST " << base_url_
                  << "Systems/1/Actions/ComputerSystem.Reset "
                  << "(ResetType=PowerCycle)\n";
        return true;
    }

    // -----------------------------------------------------------------
    // List all systems in the chassis.
    // -----------------------------------------------------------------
    auto ListSystems() -> std::vector<std::string> {
        std::cout << "[Redfish] GET " << base_url_ << "Systems\n";
        // Simulated: return a few servers.
        return {"1", "2", "3", "4"};
    }

    // -----------------------------------------------------------------
    // Get sensor readings.
    // -----------------------------------------------------------------
    auto GetTemperatures() -> std::map<std::string, double> {
        std::cout << "[Redfish] GET " << base_url_
                  << "Chassis/1/Thermal\n";
        return {
            {"CPU1 Temp", 62.5},
            {"CPU2 Temp", 58.3},
            {"System Board Temp", 42.0},
            {"DIMM Zone Temp", 45.1},
        };
    }

private:
    std::string base_url_;
    std::string username_;
    std::string password_;
};

// ====================================================================
// SOL (Serial Over LAN) session launcher.
// Uses ipmitool under the hood; here we show the command construction.
// ====================================================================
class SOLSession {
public:
    SOLSession(std::string_view bmc_ip, std::string_view username,
               std::string_view password)
        : bmc_ip_{bmc_ip}, username_{username}, password_{password}
    {}

    // Launch an SOL session.
    auto Launch() -> void {
        std::cout << "\n=== SOL Session ===\n";
        std::cout << "Launching Serial Over LAN to " << bmc_ip_ << "\n";
        std::cout << "Command that would be executed:\n";
        std::cout << "  ipmitool -I lanplus -H " << bmc_ip_
                  << " -U " << username_ << " -P " << password_
                  << " sol activate\n\n";
        std::cout << "Session controls:\n";
        std::cout << "  ~.   = terminate session\n";
        std::cout << "  ~B   = send break\n";
        std::cout << "  ~?   = help\n";
    }

    // Deactivate SOL.
    auto Close() -> void {
        std::cout << "Closing SOL session:\n";
        std::cout << "  ipmitool -I lanplus -H " << bmc_ip_
                  << " -U " << username_ << " -P " << password_
                  << " sol deactivate\n";
    }

private:
    std::string bmc_ip_;
    std::string username_;
    std::string password_;
};

// ====================================================================
// IPMI sensor monitoring utility.
// ====================================================================
class IPMISensorMonitor {
public:
    IPMISensorMonitor(std::string_view bmc_ip)
        : bmc_ip_{bmc_ip}
    {}

    // Read chassis status.
    auto ReadPowerStatus() -> void {
        std::cout << "\n--- Sensor Monitoring ---\n";
        std::cout << "Command: ipmitool -I lanplus -H " << bmc_ip_
                  << " chassis status\n";
        std::cout << "  System Power:  On\n";
        std::cout << "  Power Overload: false\n";
        std::cout << "  Power Interlock: inactive\n";
        std::cout << "  Main Power Fault: false\n";
        std::cout << "  Power Control Fault: false\n";
        std::cout << "  Chassis Intrusion: closed\n";
        std::cout << "  Front Panel Lockout: inactive\n";
        std::cout << "  Drive Fault: false\n";
    }

    // Read sensor list.
    auto ReadSensors() -> void {
        std::cout << "\n--- SDR Sensor List ---\n";
        std::cout << "Command: ipmitool -I lanplus -H " << bmc_ip_
                  << " sdr list\n";
        std::cout << "  CPU1 Temp     | 62 deg C    | ok\n";
        std::cout << "  CPU2 Temp     | 58 deg C    | ok\n";
        std::cout << "  System Temp   | 42 deg C    | ok\n";
        std::cout << "  Fan1 Speed    | 10500 RPM   | ok\n";
        std::cout << "  Fan2 Speed    | 10200 RPM   | ok\n";
        std::cout << "  +12V Main     | 12.15 V     | ok\n";
        std::cout << "  +5V Main      | 5.02 V      | ok\n";
        std::cout << "  +3.3V Main    | 3.31 V      | ok\n";
    }
};

// ====================================================================
// Demonstration.
// ====================================================================
auto main() -> int {
    std::cout << "=== IPMI & Out-of-Band Management ===\n\n";

    // Redfish client.
    RedfishClient redfish{"192.168.100.1", "admin", "password"};

    auto info = redfish.GetSystemInfo();
    if (info) {
        std::cout << "Server inventory:\n";
        std::cout << "  Model: " << info->model << "\n";
        std::cout << "  Serial: " << info->serial_number << "\n";
        std::cout << "  BIOS: " << info->bios_version << "\n";
        std::cout << "  iDRAC: " << info->firmware_version << "\n";
        std::cout << "  Power: " << info->power_state << "\n";
        std::cout << "  CPU Temp: " << info->cpu_temperature_c << "°C\n";
        std::cout << "  Fan: " << info->fan_speed_pct << "%\n";
        std::cout << "  RAM: " << info->memory_gb << " GB\n";
    }

    // Temperatures.
    auto temps = redfish.GetTemperatures();
    std::cout << "\nTemperatures:\n";
    for (const auto& [name, temp] : temps) {
        std::cout << "  " << name << ": " << temp << "°C\n";
    }

    // SOL session.
    SOLSession sol{"192.168.100.1", "admin", "password"};
    sol.Launch();
    sol.Close();

    // IPMI sensor monitoring.
    IPMISensorMonitor monitor{"192.168.100.1"};
    monitor.ReadPowerStatus();
    monitor.ReadSensors();

    // Power cycle (simulated).
    std::cout << "\n=== Remote Power Cycle ===\n";
    redfish.PowerCycle();
    std::cout << "  Server power-cycled.\n";

    std::cout << "\n=== Security Best Practices ===\n";
    std::cout << "1. Isolate BMCs on a dedicated management VLAN\n";
    std::cout << "2. Never expose BMC to the internet\n";
    std::cout << "3. Disable default accounts, use strong passwords\n";
    std::cout << "4. Keep BMC firmware updated quarterly\n";
    std::cout << "5. Monitor BMC logs for brute-force attempts\n";
    std::cout << "6. Use Redfish with HTTPS + certificate validation\n";
    std::cout << "7. Consider dedicated OOB network (separate switch)\n";

    return 0;
}
```
