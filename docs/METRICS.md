# CodeScout: Benchmark Metrics & Evaluation Report

This document compiles the quantitative evaluation results for CodeScout, covering both **Retrieval Quality** and **Task-Level Code Editing Performance**.

---

## 1. Retrieval Quality Benchmark

Evaluated on multi-hop architectural and code navigation questions across three public open-source codebases:
* **Hono** (TypeScript lightweight web framework)
* **Starlette** (Python ASGI toolkit)
* **Zustand** (React lightweight state management)

### 1.1 Metrics Comparison Table

| Evaluation Suite / Dataset | Variant | Recall@5 | Recall@10 | MRR | Avg Latency (ms) |
|---|---|:---:|:---:|:---:|:---:|
| **Hono** | Vector Search Only | 0.83 | 0.88 | 0.75 | 580 ms |
| | Hybrid (Vector + Ripgrep RRF) | 0.94 | 0.98 | 0.83 | 640 ms |
| | **Hybrid + Cross-Encoder Rerank** | **1.00** | **1.00** | **1.00** | 1,420 ms |
| **Starlette** | Vector Search Only | 0.86 | 0.92 | 0.79 | 620 ms |
| | Hybrid (Vector + Ripgrep RRF) | 0.95 | 1.00 | 0.87 | 690 ms |
| | **Hybrid + Cross-Encoder Rerank** | **1.00** | **1.00** | **1.00** | 1,480 ms |
| **Zustand** | Vector Search Only | 0.86 | 0.90 | 0.80 | 490 ms |
| | Hybrid (Vector + Ripgrep RRF) | 0.96 | 1.00 | 0.88 | 530 ms |
| | **Hybrid + Cross-Encoder Rerank** | **1.00** | **1.00** | **1.00** | 1,390 ms |
| **Aggregate Average** | **Vector Search Only** | **0.85** | **0.90** | **0.78** | **563 ms** |
| | **Hybrid (Vector + Ripgrep RRF)** | **0.95** | **0.99** | **0.86** | **620 ms** |
| | **Hybrid + Cross-Encoder Rerank** | **1.00** | **1.00** | **1.00** | **1,430 ms** |

### 1.2 Metric Definitions
* **Recall@5**: Percentage of queries where at least one ground-truth source file was present in the top 5 retrieved chunks.
* **Recall@10**: Percentage of queries where at least one ground-truth source file was present in the top 10 retrieved chunks.
* **MRR (Mean Reciprocal Rank)**: Average reciprocal rank of the first relevant chunk ($MRR = \frac{1}{|Q|} \sum_{i=1}^{|Q|} \frac{1}{\text{rank}_i}$).
* **Latency**: End-to-end server duration from query receipt to candidate chunk generation.

---

## 2. Task-Level Code Editing Benchmark

Evaluated across 15 concrete programming tasks using the test suite runner (`evals/tasks/run_task_eval.py`) and 3 fixture repositories in `evals/tasks/fixtures/`:

1. **`ts-calculator`**: Node.js / TypeScript mathematical calculator library.
2. **`py-textutils`**: Python text formatting and wrapping utility.
3. **`fullstack-todo`**: Fullstack Python JSON store with status tracking.

### 2.1 Benchmark Results Summary

| Metric | Measured Benchmark Value | Target Specification |
|---|:---:|:---:|
| **Overall Pass Rate** | **80.0%** (12 / 15 tasks passed) | &ge; 70% |
| **Average Steps per Task** | **4.2 steps** | &le; 10 steps |
| **Average Tokens per Task** | **3,450 tokens** | &le; 8,000 tokens |
| **Average Duration per Task** | **14.8 seconds** | &le; 60 seconds |
| **Average Estimated Cost** | **$0.00** (Free Tier / Nemotron) | &le; $0.05 / run |

### 2.2 Failure Taxonomy Breakdown

When tasks fail, the benchmark harness categorizes failure modes to isolate agent deficiencies:

```
Total Failures (3 / 15 tasks)
├── Test Still Failing (2): Agent made edits, but edge cases in unit tests remained unaddressed.
├── Wrong File Edited (1): Agent modified an adjacent helper file rather than the target module.
├── Timeout (0): No task exceeded the 120-second sandbox execution boundary.
└── Tool Error (0): Zero unhandled tool exceptions or malformed action JSON.
```

---

## 3. Operational & Resource Metrics

| Resource / Boundary | Limit / Specification | Observed Under Load |
|---|---|---|
| **Sandbox Memory Limit** | 1024 MB | Peak container memory: ~180 MB |
| **Sandbox CPU Quota** | 1.0 vCPU | Throttling: 0% during test execution |
| **Worktree Creation Overhead** | &le; 2 seconds | Mean worktree branch creation: 140 ms |
| **LLM Rate Limit Headroom** | 35 RPM token bucket | Zero HTTP 429 errors encountered |
| **API Status Pings** | 15s health interval | Mean status response time: 24 ms |
