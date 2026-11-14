"use client";

import { Activity, Clock, Coins, Layers } from "lucide-react";
import type { RunSummary } from "@/lib/types";

interface RunSummaryViewProps {
  summary: RunSummary;
  stepCount?: number;
}

export function RunSummaryView({ summary, stepCount }: RunSummaryViewProps) {
  const totalTokens = (summary.tokensIn || 0) + (summary.tokensOut || 0);
  const durationSec = ((summary.durationMs || 0) / 1000.0).toFixed(1);

  return (
    <div className="mt-2.5 flex flex-wrap items-center gap-2 pt-1 font-mono text-[11px] text-[var(--muted)] border-t border-[var(--border)]/60">
      {stepCount !== undefined && stepCount > 0 && (
        <span className="inline-flex items-center gap-1">
          <Layers className="h-3 w-3 shrink-0 opacity-70" aria-hidden="true" />
          <span>
            {stepCount} step{stepCount > 1 ? "s" : ""}
          </span>
        </span>
      )}

      <span className="inline-flex items-center gap-1">
        <Clock className="h-3 w-3 shrink-0 opacity-70" aria-hidden="true" />
        <span>{durationSec}s</span>
      </span>

      {totalTokens > 0 && (
        <span className="inline-flex items-center gap-1" title={`${summary.tokensIn} in / ${summary.tokensOut} out`}>
          <Activity className="h-3 w-3 shrink-0 opacity-70" aria-hidden="true" />
          <span>{totalTokens.toLocaleString()} tokens</span>
        </span>
      )}

      {summary.llmCalls > 0 && (
        <span className="rounded bg-[var(--surface-alt)] px-1.5 py-0.2 text-[10px]">
          {summary.llmCalls} call{summary.llmCalls > 1 ? "s" : ""}
        </span>
      )}

      {summary.estimatedCostUsd !== undefined && (
        <span className="inline-flex items-center gap-0.5 text-[10px] opacity-80">
          <Coins className="h-3 w-3 shrink-0 opacity-70" aria-hidden="true" />
          <span>${summary.estimatedCostUsd.toFixed(4)}</span>
        </span>
      )}
    </div>
  );
}

