---
type: reference
title: "LLM Hft"
description: "Code generation for protocol parsers: LLMs can translate exchange spec. Incident analysis automation: feed logs and metrics to LLM for postmortem"
tags: ["phase-16"]
timestamp: "2026-06-27T03:06:09.456Z"
phase: 16
phaseName: "HFT Economics & Career"
category: "Phase 16 - HFT Economics & Career"
subcategory: "economics-career"
language: "cpp"
artifact-id: "ZHFT_LLM_HFT"
---
## Key Learning Points

- Code generation for protocol parsers: LLMs can translate exchange spec
- Incident analysis automation: feed logs and metrics to LLM for postmortem
- Python→C++ translation: LLMs can convert research/prototype Python into
- Monitoring anomaly detection: LLM-based log analysis identifies patterns
- Current limitations: LLMs lack understanding of memory ordering, cache

## Source Code

```cpp
#include <algorithm>
#include <array>
#include <cstdint>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <functional>
#include <map>
#include <optional>
#include <sstream>
#include <string>
#include <vector>

// ---------------------------------------------------------------------------
// LLM prompt templates for HFT engineering tasks.
// ---------------------------------------------------------------------------
/*
 * Each template is a std::string with {{placeholders}} for parameters.
 * The evaluation framework scores the LLM output against ground truth.
 */

namespace PromptTemplates {

// Prompt: translate an exchange spec snippet into a C++ struct definition.
inline constexpr const char *kProtocolParserPrompt = R"(
You are an HFT engineer implementing a market data protocol parser.

Given the following exchange specification for a {{protocol_name}} message,
generate a C++ struct that can parse this message from a byte buffer.

Specification:
{{spec_text}}

Requirements:
- Use `#pragma pack(push, 1)` for packed structs
- Fields must be in network byte order (big-endian)
- Include a `static constexpr size_t size()` method
- Include a `void to_host_order()` method if endianness conversion is needed
- Zero-copy parsing: return a pointer to the struct (do not copy fields)
- Include a bounds check against the buffer size in the parse function

Output only the C++ code, no explanation.
)";

// Prompt: translate Python research code to production C++.
inline constexpr const char *kPyToCppPrompt = R"(
Translate the following Python code to production-quality C++20.
The C++ version must:
- Use fixed-point arithmetic where Python uses float (scale factor: {{scale_factor}})
- Be lock-free (no std::mutex in the hot path)
- Use stack allocation (no heap allocation during the trading loop)
- Use RAII for all resource management
- Include noexcept specifiers
- Match the Python output exactly, including edge cases

Python code:
```python
{{python_code}}
```

Output only the C++ code, no explanation.
)";

// Prompt: generate a postmortem from incident logs.
inline constexpr const char *kPostmortemPrompt = R"(
Generate a postmortem report for a trading system incident based on the
following logs and metrics. Use the format:

## Summary
## Timeline (UTC)
## Root Cause Analysis
## Impact
## Action Items

Logs:
{{logs}}

Metrics (Latency P50/P99/P99.9):
{{metrics}}
)";

} // namespace PromptTemplates

// ---------------------------------------------------------------------------
// LLM output evaluation framework — scores generated code against specs.
// ---------------------------------------------------------------------------
class LlmOutputEvaluator {
public:
  struct Evaluation {
    std::string task;
    double      correctness_score;     // 0-1: does it compile and match spec?
    double      performance_score;     // 0-1: is it within 10% of hand-written?
    double      safety_score;          // 0-1: no buffer overflow, no UB.
    std::vector<std::string> issues;
    std::string verdict;
  };

  // Evaluate a generated protocol parser against the exchange spec.
  Evaluation evaluate_parser(const std::string &generated_code,
                              const std::string &spec,
                              const std::vector<uint8_t> &test_message) {
    Evaluation eval;
    eval.task = "Protocol Parser Generation";

    // Check 1: Does it compile? (Invoke compiler in a sandbox).
    bool compiles = check_compiles(generated_code);
    if (!compiles) {
      eval.issues.push_back("Generated code does not compile");
      eval.correctness_score = 0;
      eval.performance_score = 0;
      eval.safety_score      = 0;
      eval.verdict           = "REJECT — compilation failure";
      return eval;
    }

    // Check 2: Does it parse the test message correctly?
    bool parses = check_parser_output(generated_code, test_message);
    eval.correctness_score = parses ? 0.95 : 0.3;
    if (!parses) eval.issues.push_back("Parser output does not match expected");

    // Check 3: Any safety issues?
    bool has_ubsan = check_undefined_behavior(generated_code);
    eval.safety_score = has_ubsan ? 0.5 : 1.0;
    if (has_ubsan) eval.issues.push_back("Undefined behavior detected");

    // Check 4: Benchmark against reference.
    eval.performance_score = benchmark_parser(generated_code);

    // Overall verdict.
    double combined = (eval.correctness_score + eval.performance_score +
                       eval.safety_score) / 3.0;
    if (combined >= 0.85)
      eval.verdict = "ACCEPT — production-ready after review";
    else if (combined >= 0.6)
      eval.verdict = "ACCEPT WITH CHANGES — see issues above";
    else
      eval.verdict = "REJECT — requires rewrite";

    return eval;
  }

private:
  bool check_compiles(const std::string &code) const {
    // Write to temp file, invoke g++ -std=c++20 -fsyntax-only.
    std::string tmp = "/tmp/llm_eval_" + std::to_string(rand()) + ".cpp";
    std::ofstream(tmp) << code;
    int rc = std::system(("g++ -std=c++20 -fsyntax-only -c " + tmp + " 2>/dev/null").c_str());
    std::filesystem::remove(tmp);
    return rc == 0;
  }

  bool check_parser_output(const std::string &code,
                           const std::vector<uint8_t> &msg) const {
    // In production: compile the parser, link a test harness, run against msg.
    return true; // Placeholder.
  }

  bool check_undefined_behavior(const std::string &code) const {
    // Compile with -fsanitize=undefined and run.
    return false; // Placeholder.
  }

  double benchmark_parser(const std::string &code) const {
    // Compare cycles against a hand-written reference.
    return 0.9; // Placeholder: 90% of hand-written.
  }
};
```
