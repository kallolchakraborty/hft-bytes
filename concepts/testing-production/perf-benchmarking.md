---
type: reference
title: "Performance Benchmarking Methodology"
description: "Paired A/B latency testing, statistical significance for performance changes (Mann-Whitney, t-test), confidence intervals for tail latency, benchmark harness design with CPU isolation, and CI performance regression gates."
tags: ["testing"]
difficulty: staff
timestamp: "2026-06-27T06:00:00.000Z"
phase: 15
phaseName: "Testing & Production"
category: "Testing"
subcategory: "testing"
language: "python"
artifact-id: "ZHFT_PERF_BENCHMARKING"
---
## Key Learning Points

- Paired A/B benchmark: same input sequence, alternating A/B runs, interleaved to cancel thermal/system noise; measure end-to-end latency per tick, compare distributions, not just averages
- Statistical significance for latency: Mann-Whitney U-test (non-parametric, no normality assumption) for comparing latency distributions; paired t-test if differences are normally distributed; report p-value + effect size
- Confidence intervals for tail latency: bootstrap resampling for p50/p95/p99; report 95% CI for each percentile; changes in p99 need larger sample sizes (n > 1000) for reliable detection
- Benchmark harness design: CPU isolation (`isolcpus` + `taskset`), fixed frequency (`cpupower frequency-set -g performance`), warm-up iterations to fill caches, no ASLR, no turbo boost for repeatable measurements
- CI performance gates: run benchmark on every PR; compare p95 latency against baseline; fail if regression > 200ns with p < 0.05; store historical results for trend detection

```html
<div class="ad-wrapper">
  <div class="ad-title">A/B Benchmark Methodology</div>
  <div class="ad-flow">
    <div class="ad-stage active"><span class="ad-stage-icon">🔀</span><span class="ad-stage-label">Interleave A/B Runs</span></div>
    <div class="ad-arrow"><span class="material-symbols-outlined">chevron_right</span><span class="ad-packet"></span></div>
    <div class="ad-stage"><span class="ad-stage-icon">📊</span><span class="ad-stage-label">Collect Latency Samples</span></div>
    <div class="ad-arrow"><span class="material-symbols-outlined">chevron_right</span><span class="ad-packet"></span></div>
    <div class="ad-stage"><span class="ad-stage-icon">📈</span><span class="ad-stage-label">Mann-Whitney U Test</span></div>
    <div class="ad-arrow"><span class="material-symbols-outlined">chevron_right</span><span class="ad-packet"></span></div>
    <div class="ad-stage"><span class="ad-stage-icon">✅</span><span class="ad-stage-label">Pass/Fail Gate</span></div>
  </div>
</div>
```

## Usage

```python
import numpy as np
from scipy.stats import mannwhitneyu

def bench_ab(baseline_ns, candidate_ns, alpha=0.05):
    stat, p = mannwhitneyu(baseline_ns, candidate_ns, alternative='two-sided')
    effect = np.median(candidate_ns) - np.median(baseline_ns)
    p95_b = np.percentile(baseline_ns, 95)
    p95_c = np.percentile(candidate_ns, 95)
    print(f"p-value: {p:.4f}, effect: {effect:.1f}ns")
    print(f"p95 baseline: {p95_b:.0f}ns, candidate: {p95_c:.0f}ns")
    regression = p95_c - p95_b
    gate_pass = regression < 200 or p > alpha
    return {"pass": gate_pass, "p": p, "regression_ns": regression}
```

## Source Code

```python
# Benchmark harness setup
def run_benchmark(binary, cpu_affinity=2, iterations=100_000):
    subprocess.run(["taskset", "-c", str(cpu_affinity), binary,
                    f"--iterations={iterations}", "--warmup=10000"],
                   check=True, capture_output=True)
    # Parse latency log, return list of per-op ns values
    return parse_latencies(f"{binary}_latency.csv")

# CI gate script (run in CI pipeline)
if __name__ == "__main__":
    baseline = run_benchmark("./strategy_old")
    candidate = run_benchmark("./strategy_new")
    result = bench_ab(baseline, candidate)
    if not result["pass"]:
        print(f"REGRESSION: p95 +{result['regression_ns']:.0f}ns (p={result['p']:.4f})")
        exit(1)
```
