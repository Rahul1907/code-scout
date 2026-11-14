"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  BarChart3,
  CheckCircle2,
  ChevronRight,
  Clock,
  Code2,
  ExternalLink,
  FileCode,
  FolderGit2,
  Layers,
  Loader2,
  RefreshCw,
  Terminal,
  X,
  XCircle,
  Zap,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { getEvalRun, listEvalRuns } from "@/lib/api";
import type { EvalRunItem, TaskEvalResultItem } from "@/lib/types";

export default function EvalsPage() {
  const [runs, setRuns] = useState<EvalRunItem[]>([]);
  const [selectedSuite, setSelectedSuite] = useState<"all" | "task" | "retrieval">("all");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedRun, setSelectedRun] = useState<EvalRunItem | null>(null);
  const [activeTaskDetail, setActiveTaskDetail] = useState<TaskEvalResultItem | null>(null);

  const fetchRuns = useCallback(async () => {
    try {
      const suiteParam = selectedSuite === "all" ? undefined : selectedSuite;
      const data = await listEvalRuns(suiteParam);
      setRuns(data);
    } catch (err) {
      console.error("Failed to load eval runs:", err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [selectedSuite]);

  useEffect(() => {
    setLoading(true);
    void fetchRuns();
  }, [fetchRuns]);

  const handleRefresh = () => {
    setRefreshing(true);
    void fetchRuns();
  };

  const handleSelectRun = async (run: EvalRunItem) => {
    try {
      // Fetch full details if results aren't populated
      if (!run.results || run.results.length === 0) {
        const full = await getEvalRun(run._id);
        setSelectedRun(full);
      } else {
        setSelectedRun(run);
      }
      setActiveTaskDetail(null);
    } catch (err) {
      console.error("Failed to fetch eval run details:", err);
      setSelectedRun(run);
    }
  };

  // Compute aggregate stats across runs
  const taskRuns = useMemo(() => runs.filter((r) => r.suite === "task"), [runs]);
  const retrievalRuns = useMemo(() => runs.filter((r) => r.suite === "retrieval"), [runs]);

  const latestTaskRun = taskRuns[0];
  const latestRetrievalRun = retrievalRuns[0];

  const overallPassRate = useMemo(() => {
    if (!latestTaskRun || !latestTaskRun.metrics?.passRate) return null;
    return Math.round(latestTaskRun.metrics.passRate * 100);
  }, [latestTaskRun]);

  return (
    <div className="flex min-h-screen flex-col bg-[var(--background)] text-[var(--text)]">
      {/* Header */}
      <header className="border-b border-[var(--border)] bg-[var(--surface)] sticky top-0 z-20">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-3.5">
          <div className="flex items-center gap-6">
            <Link href="/dashboard" className="flex items-center gap-2 text-lg font-semibold hover:opacity-90">
              <FolderGit2 className="h-5 w-5 text-[var(--accent)]" />
              <span>CodeScout</span>
            </Link>
            <nav className="flex items-center gap-3 text-xs">
              <Link href="/dashboard" className="text-[var(--muted)] hover:text-[var(--text)] transition-colors">
                Dashboard
              </Link>
              <span className="text-[var(--border)]">/</span>
              <span className="font-semibold text-[var(--accent)]">Evals</span>
            </nav>
          </div>

          <div className="flex items-center gap-3">
            <Button
              variant="secondary"
              size="sm"
              onClick={handleRefresh}
              disabled={refreshing || loading}
              className="h-8 gap-1.5 text-xs"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
              <span>Refresh</span>
            </Button>
            <Link href="/dashboard">
              <Button variant="ghost" size="sm" className="h-8 gap-1 text-xs text-[var(--muted)]">
                <ArrowLeft className="h-3.5 w-3.5" />
                <span>Back to Repos</span>
              </Button>
            </Link>
          </div>
        </div>
      </header>

      {/* Main Container */}
      <main className="mx-auto w-full max-w-7xl flex-1 px-6 py-8">
        {/* Title & Description */}
        <div className="mb-8 flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Evaluations Dashboard</h1>
            <p className="mt-1 text-xs text-[var(--muted)]">
              Continuous benchmarking of retrieval quality (Recall@K, MRR) and task editing success (pass rate, steps, tokens).
            </p>
          </div>

          {/* Suite Filter Tabs */}
          <div className="inline-flex rounded-lg border border-[var(--border)] bg-[var(--surface)] p-1 text-xs">
            <button
              onClick={() => setSelectedSuite("all")}
              className={`rounded px-3 py-1.5 font-medium transition-colors ${
                selectedSuite === "all"
                  ? "bg-[var(--accent)] text-white shadow-sm"
                  : "text-[var(--muted)] hover:text-[var(--text)]"
              }`}
            >
              All Runs ({runs.length})
            </button>
            <button
              onClick={() => setSelectedSuite("task")}
              className={`rounded px-3 py-1.5 font-medium transition-colors ${
                selectedSuite === "task"
                  ? "bg-[var(--accent)] text-white shadow-sm"
                  : "text-[var(--muted)] hover:text-[var(--text)]"
              }`}
            >
              Task Suite ({taskRuns.length})
            </button>
            <button
              onClick={() => setSelectedSuite("retrieval")}
              className={`rounded px-3 py-1.5 font-medium transition-colors ${
                selectedSuite === "retrieval"
                  ? "bg-[var(--accent)] text-white shadow-sm"
                  : "text-[var(--muted)] hover:text-[var(--text)]"
              }`}
            >
              Retrieval Suite ({retrievalRuns.length})
            </button>
          </div>
        </div>

        {/* KPI Cards Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-sm">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-[var(--muted)]">Total Evaluated Runs</span>
              <Layers className="h-4 w-4 text-[var(--accent)]" />
            </div>
            <div className="mt-2 text-2xl font-bold">{runs.length}</div>
            <div className="mt-1 text-[11px] text-[var(--muted)]">
              {taskRuns.length} task / {retrievalRuns.length} retrieval
            </div>
          </div>

          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-sm">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-[var(--muted)]">Latest Task Pass Rate</span>
              <CheckCircle2 className="h-4 w-4 text-emerald-500" />
            </div>
            <div className="mt-2 text-2xl font-bold">
              {overallPassRate !== null ? `${overallPassRate}%` : "—"}
            </div>
            <div className="mt-1 text-[11px] text-[var(--muted)]">
              {latestTaskRun
                ? `${latestTaskRun.passedTasks || 0} of ${latestTaskRun.totalTasks || 0} tasks passed`
                : "No task runs yet"}
            </div>
          </div>

          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-sm">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-[var(--muted)]">Avg Task Duration</span>
              <Clock className="h-4 w-4 text-amber-500" />
            </div>
            <div className="mt-2 text-2xl font-bold">
              {latestTaskRun?.metrics?.avgDurationSec
                ? `${latestTaskRun.metrics.avgDurationSec.toFixed(1)}s`
                : "—"}
            </div>
            <div className="mt-1 text-[11px] text-[var(--muted)]">
              Avg Steps: {latestTaskRun?.metrics?.avgSteps?.toFixed(1) ?? "—"}
            </div>
          </div>

          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-sm">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-[var(--muted)]">Hybrid + Rerank MRR</span>
              <Zap className="h-4 w-4 text-purple-500" />
            </div>
            <div className="mt-2 text-2xl font-bold">
              {latestRetrievalRun?.metrics?.hybrid_rerank?.mrr !== undefined
                ? latestRetrievalRun.metrics.hybrid_rerank.mrr
                : "—"}
            </div>
            <div className="mt-1 text-[11px] text-[var(--muted)]">
              Recall@5:{" "}
              {latestRetrievalRun?.metrics?.hybrid_rerank?.["recall@5"] !== undefined
                ? `${Math.round(latestRetrievalRun.metrics.hybrid_rerank["recall@5"] * 100)}%`
                : "—"}
            </div>
          </div>
        </div>

        {/* Comparison & Metrics Overview */}
        {latestTaskRun && (
          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 mb-8 shadow-sm">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-[var(--border)] pb-3 mb-4">
              <div className="flex items-center gap-2">
                <BarChart3 className="h-4 w-4 text-[var(--accent)]" />
                <h2 className="font-semibold text-sm">Latest Task Evaluation Suite Breakdown</h2>
                <Badge variant="neutral" className="text-[10px]">
                  {new Date(latestTaskRun.createdAt).toLocaleDateString()}
                </Badge>
              </div>
              <div className="text-xs text-[var(--muted)] font-mono">
                Model: {latestTaskRun.configSnapshot?.llmChatModel || "default"}
              </div>
            </div>

            {/* Pass Rate Bar */}
            <div className="mb-4">
              <div className="flex justify-between text-xs mb-1.5 font-medium">
                <span>Task Suite Pass Rate</span>
                <span>{overallPassRate !== null ? `${overallPassRate}%` : "0%"}</span>
              </div>
              <div className="h-3 w-full bg-[var(--border)] rounded-full overflow-hidden flex">
                <div
                  className="bg-emerald-500 transition-all duration-500"
                  style={{ width: `${overallPassRate || 0}%` }}
                />
                <div
                  className="bg-rose-500 transition-all duration-500"
                  style={{ width: `${100 - (overallPassRate || 0)}%` }}
                />
              </div>
            </div>

            {/* Failure Categories Breakdown */}
            {latestTaskRun.metrics?.failureCategories && (
              <div className="flex flex-wrap items-center gap-3 pt-2 text-xs">
                <span className="text-[var(--muted)] font-medium">Failure Breakdown:</span>
                {Object.entries(latestTaskRun.metrics.failureCategories).map(([cat, count]) => (
                  <span
                    key={cat}
                    className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-medium border ${
                      Number(count) > 0
                        ? "bg-rose-500/10 text-rose-400 border-rose-500/20"
                        : "bg-[var(--surface-alt)] text-[var(--muted)] border-[var(--border)]"
                    }`}
                  >
                    <span>{cat.replace(/_/g, " ")}:</span>
                    <span className="font-bold">{String(count)}</span>
                  </span>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Runs List Table */}
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] overflow-hidden shadow-sm">
          <div className="border-b border-[var(--border)] px-4 py-3 bg-[var(--surface-alt)] flex items-center justify-between">
            <h3 className="font-semibold text-xs text-[var(--muted)] uppercase tracking-wider">
              Evaluation Runs
            </h3>
            <span className="text-xs text-[var(--muted)]">{runs.length} recorded</span>
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-16 gap-2 text-xs text-[var(--muted)]">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>Loading eval runs...</span>
            </div>
          ) : runs.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center text-xs text-[var(--muted)]">
              <Activity className="h-8 w-8 mb-2 opacity-40 text-[var(--accent)]" />
              <p className="font-medium text-sm text-[var(--text)]">No evaluation runs found</p>
              <p className="mt-1 max-w-sm">
                Run the retrieval or task eval suite via CLI or background worker to populate benchmark results.
              </p>
            </div>
          ) : (
            <div className="divide-y divide-[var(--border)] text-xs">
              {runs.map((r) => {
                const isTask = r.suite === "task";
                return (
                  <div
                    key={r._id}
                    onClick={() => void handleSelectRun(r)}
                    className="flex flex-col md:flex-row md:items-center justify-between gap-3 p-4 hover:bg-[var(--surface-alt)] cursor-pointer transition-colors"
                  >
                    <div className="flex items-start gap-3">
                      <div
                        className={`p-2 rounded-lg mt-0.5 ${
                          isTask
                            ? "bg-blue-500/10 text-blue-400 border border-blue-500/20"
                            : "bg-purple-500/10 text-purple-400 border border-purple-500/20"
                        }`}
                      >
                        {isTask ? <Code2 className="h-4 w-4" /> : <Layers className="h-4 w-4" />}
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-sm">
                            {isTask ? "Task Edit Evaluation Suite" : "Retrieval Evaluation Suite"}
                          </span>
                          <span
                            className={`px-2 py-0.5 rounded-full text-[10px] font-medium uppercase border ${
                              isTask
                                ? "bg-blue-500/10 text-blue-400 border-blue-500/20"
                                : "bg-purple-500/10 text-purple-400 border-purple-500/20"
                            }`}
                          >
                            {r.suite}
                          </span>
                        </div>
                        <div className="mt-1 flex items-center gap-3 text-[11px] text-[var(--muted)]">
                          <span>{new Date(r.createdAt).toLocaleString()}</span>
                          <span>•</span>
                          <span className="font-mono">
                            {r.configSnapshot?.llmChatModel || r.configSnapshot?.embeddingModel || "standard"}
                          </span>
                          {r.repos && r.repos.length > 0 && (
                            <>
                              <span>•</span>
                              <span>{r.repos.join(", ")}</span>
                            </>
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center justify-between md:justify-end gap-4 shrink-0">
                      {isTask ? (
                        <div className="text-right">
                          <div className="font-bold text-sm text-emerald-400">
                            {r.metrics?.passRate !== undefined
                              ? `${Math.round(r.metrics.passRate * 100)}% Pass`
                              : "—"}
                          </div>
                          <div className="text-[11px] text-[var(--muted)]">
                            {r.passedTasks || 0}/{r.totalTasks || 0} passed
                          </div>
                        </div>
                      ) : (
                        <div className="text-right">
                          <div className="font-bold text-sm text-purple-400">
                            MRR: {r.metrics?.hybrid_rerank?.mrr ?? r.metrics?.hybrid?.mrr ?? "—"}
                          </div>
                          <div className="text-[11px] text-[var(--muted)]">
                            {r.totalQuestions || 0} queries
                          </div>
                        </div>
                      )}

                      <ChevronRight className="h-4 w-4 text-[var(--muted)]" />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Selected Run Details Modal / Drawer */}
        {selectedRun && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
            <div className="relative w-full max-w-4xl max-h-[90vh] flex flex-col rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-2xl overflow-hidden">
              {/* Modal Header */}
              <div className="flex items-center justify-between border-b border-[var(--border)] px-5 py-4 bg-[var(--surface-alt)]">
                <div className="flex items-center gap-2.5">
                  <div
                    className={`p-1.5 rounded-md ${
                      selectedRun.suite === "task"
                        ? "bg-blue-500/10 text-blue-400"
                        : "bg-purple-500/10 text-purple-400"
                    }`}
                  >
                    {selectedRun.suite === "task" ? (
                      <Code2 className="h-4 w-4" />
                    ) : (
                      <Layers className="h-4 w-4" />
                    )}
                  </div>
                  <div>
                    <h3 className="font-semibold text-sm">
                      {selectedRun.suite === "task" ? "Task Suite Run Details" : "Retrieval Run Details"}
                    </h3>
                    <p className="text-[11px] text-[var(--muted)] font-mono">ID: {selectedRun._id}</p>
                  </div>
                </div>

                <button
                  onClick={() => {
                    setSelectedRun(null);
                    setActiveTaskDetail(null);
                  }}
                  className="rounded-md p-1.5 text-[var(--muted)] hover:bg-[var(--border)] hover:text-[var(--text)] transition-colors"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              {/* Modal Body */}
              <div className="flex-1 overflow-y-auto p-5 space-y-5 text-xs">
                {/* Snapshot stats */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 bg-[var(--surface-alt)] p-3.5 rounded-lg border border-[var(--border)]">
                  <div>
                    <div className="text-[var(--muted)] text-[10px] uppercase font-semibold">Date</div>
                    <div className="mt-0.5 font-medium">{new Date(selectedRun.createdAt).toLocaleString()}</div>
                  </div>
                  <div>
                    <div className="text-[var(--muted)] text-[10px] uppercase font-semibold">Suite</div>
                    <div className="mt-0.5 font-medium uppercase text-[var(--accent)]">{selectedRun.suite}</div>
                  </div>
                  <div>
                    <div className="text-[var(--muted)] text-[10px] uppercase font-semibold">
                      {selectedRun.suite === "task" ? "Pass Rate" : "Top MRR"}
                    </div>
                    <div className="mt-0.5 font-bold text-emerald-400">
                      {selectedRun.suite === "task"
                        ? `${Math.round((selectedRun.metrics?.passRate || 0) * 100)}%`
                        : selectedRun.metrics?.hybrid_rerank?.mrr ?? "—"}
                    </div>
                  </div>
                  <div>
                    <div className="text-[var(--muted)] text-[10px] uppercase font-semibold">Trace Host</div>
                    <div className="mt-0.5">
                      <a
                        href="https://cloud.langfuse.com"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-[var(--accent)] hover:underline"
                      >
                        Langfuse
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    </div>
                  </div>
                </div>

                {/* Task Drill-Down List */}
                {selectedRun.suite === "task" && (
                  <div>
                    <h4 className="font-semibold text-xs text-[var(--muted)] uppercase tracking-wider mb-2.5">
                      Evaluated Tasks ({selectedRun.results?.length || 0})
                    </h4>

                    {(!selectedRun.results || selectedRun.results.length === 0) ? (
                      <p className="text-[var(--muted)] py-4 text-center">No individual task results recorded.</p>
                    ) : (
                      <div className="space-y-2">
                        {selectedRun.results.map((task: any) => {
                          const isExpanded = activeTaskDetail?.taskId === task.taskId;
                          return (
                            <div
                              key={task.taskId}
                              className="rounded-lg border border-[var(--border)] bg-[var(--surface-alt)] overflow-hidden"
                            >
                              <div
                                onClick={() => setActiveTaskDetail(isExpanded ? null : task)}
                                className="flex items-center justify-between p-3 cursor-pointer hover:bg-[var(--border)]/30 transition-colors"
                              >
                                <div className="flex items-center gap-2.5 min-w-0">
                                  {task.passed ? (
                                    <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0" />
                                  ) : (
                                    <XCircle className="h-4 w-4 text-rose-500 shrink-0" />
                                  )}
                                  <span className="font-mono font-bold text-xs">{task.taskId}</span>
                                  <span className="rounded bg-[var(--surface)] px-1.5 py-0.5 text-[10px] font-mono border border-[var(--border)] text-[var(--muted)]">
                                    {task.repo}
                                  </span>
                                  <span className="truncate text-xs text-[var(--text)]">{task.instruction}</span>
                                </div>

                                <div className="flex items-center gap-3 shrink-0 ml-2">
                                  {task.failureCategory && (
                                    <span className="px-2 py-0.5 rounded text-[10px] font-medium bg-rose-500/10 text-rose-400 border border-rose-500/20">
                                      {task.failureCategory}
                                    </span>
                                  )}
                                  <span className="text-[11px] text-[var(--muted)] font-mono">
                                    {task.durationSec}s
                                  </span>
                                </div>
                              </div>

                              {/* Expanded Task Drill-Down Panel */}
                              {isExpanded && (
                                <div className="border-t border-[var(--border)] p-3.5 space-y-3 bg-[var(--surface)]">
                                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-[11px]">
                                    <div>
                                      <span className="text-[var(--muted)]">Target File:</span>{" "}
                                      <span className="font-mono">{task.targetFile || "—"}</span>
                                    </div>
                                    <div>
                                      <span className="text-[var(--muted)]">Steps Executed:</span>{" "}
                                      <span className="font-semibold">{task.stepCount || 0}</span>
                                    </div>
                                    <div>
                                      <span className="text-[var(--muted)]">Tokens Used:</span>{" "}
                                      <span className="font-semibold">{task.totalTokens || 0}</span>
                                    </div>
                                  </div>

                                  <div>
                                    <div className="flex items-center justify-between text-[11px] text-[var(--muted)] mb-1">
                                      <span>Test Command:</span>
                                      <span className="font-mono">Exit Code: {task.exitCode}</span>
                                    </div>
                                    <div className="font-mono text-[11px] bg-[var(--surface-alt)] p-1.5 rounded border border-[var(--border)]">
                                      {task.testCommand}
                                    </div>
                                  </div>

                                  {task.testOutputTail && (
                                    <div>
                                      <div className="text-[11px] text-[var(--muted)] mb-1 flex items-center gap-1.5">
                                        <Terminal className="h-3 w-3" />
                                        <span>Test Output Tail:</span>
                                      </div>
                                      <pre className="font-mono text-[10px] p-2.5 rounded bg-black/80 text-emerald-400 max-h-48 overflow-y-auto whitespace-pre-wrap">
                                        {task.testOutputTail}
                                      </pre>
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
