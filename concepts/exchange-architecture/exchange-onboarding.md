---
type: reference
title: "Exchange Onboarding"
description: "MOC (Model-Of-Communication) document analysis, RFP process, certification timeline (CME UAT, Eurex TES), connectivity test harness, IP whitelisting with colocation providers."
tags: ["exchange-protocols"]
timestamp: "2026-06-27T03:06:09.430Z"
phase: 8
phaseName: "Exchange Architecture"
category: "Exchange Architecture"
subcategory: "exchange-architecture"
language: "cpp"
artifact-id: "ZHFT_EXCHANGE_ONBOARDING"
---
## Key Learning Points

- MOC (Model-Of-Communication) document defines the exchange's network topology, session model, message formats, and certification requirements
- RFP / connectivity application: submit firm details, trading volumes, colocation requests; 2-8 week approval process for new members
- Certification timeline: CME requires 2-4 weeks of UAT (CME UAT environment), Eurex requires TES (Technical Entry Service) certification, ICE uses CERT environment
- Connectivity test harness: automated script that validates logon, sequence numbers, heartbeat, resend request, gap-fill, and logout scenarios
- IP whitelisting: exchange gateways limit connections to registered IP ranges; must provide colo cross-connect IPs in advance
- Latency baseline: ping RTT to the exchange matching engine before and after deployment; jitter should be < 5 us
- Protocol conformance: mandatory message types per session (logon, heartbeat, test request, resend request, sequence reset, logout)
- Production readiness checklist: trading limits set, risk controls configured, monitoring dashboards built, support rotation established

## Usage

```cpp
// Connectivity test harness skeleton
enum class TestResult { PASS, FAIL };

struct OnboardingTest {
    std::string exchange_;
    std::string session_host_;
    int session_port_;

    // Test 1: Logon and session establishment
    TestResult testLogon() {
        // 1. Connect TCP to session_host:session_port
        // 2. Send Logon message (35=A) with credentials
        // 3. Verify Logon response (35=A) with sender comp ID
        // 4. Measure time from connect to logon; target < 50 ms
        return TestResult::PASS;
    }

    // Test 2: Heartbeat exchange
    TestResult testHeartbeat() {
        // 1. After logon, wait for heartbeat interval
        // 2. Verify inbound Heartbeat (35=0) arrives within 120% of negotiated interval
        return TestResult::PASS;
    }

    // Test 3: Resend request / gap-fill
    TestResult testResend() {
        // 1. Request resend of messages 1-100 via ResendRequest (35=2)
        // 2. Verify sequence reset (35=4) and subsequent messages
        return TestResult::PASS;
    }
};

// Onboarding phases (typical 6-10 week timeline):
// Week 1-2:  MOC review + RFP submission
// Week 3-4:  Dev complete + internal test
// Week 5-6:  Exchange certification (UAT/TES/CERT)
// Week 7-8:  IP whitelisting + colo cross-connect
// Week 9-10: Production go-live with monitoring
```
