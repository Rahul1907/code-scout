"use client";

import {
  Braces,
  ChevronDown,
  Clock,
  Code2,
  FileSearch,
  FileText,
  FolderTree,
  Loader2,
  Search,
  Wrench,
} from "lucide-react";
import type { AgentStep } from "@/lib/types";

interface AgentTimelineProps {
  steps: AgentStep[];
  isLive?: boolean;
  defaultOpen?: boolean;
}

function getToolIcon(toolName?: string) {
  switch (toolName) {
    case "search_code":
      return <Search className="h-3.5 w-3.5 text-blue-500" aria-hidden="true" />;
    case "grep":
      return <FileSearch className="h-3.5 w-3.5 text-amber-500" aria-hidden="true" />;
    case "read_file":
      return <FileText className="h-3.5 w-3.5 text-emerald-500" aria-hidden="true" />;
    case "list_directory":
      return <FolderTree className="h-3.5 w-3.5 text-violet-500" aria-hidden="true" />;
    case "find_symbol":
      return <Braces className="h-3.5 w-3.5 text-pink-500" aria-hidden="true" />;
    default:
      return <Code2 className="h-3.5 w-3.5 text-[var(--accent)]" aria-hidden="true" />;
  }
}

export function AgentTimeline({ steps, isLive = false, defaultOpen = false }: AgentTimelineProps) {
  if (!steps || steps.length === 0) return null;

  return (
    <details
      open={isLive || defaultOpen ? true : undefined}
      className="group mb-3 rounded-lg border border-[var(--border)] bg-[var(--surface-alt)]/35 text-xs overflow-hidden"
    >
      <summary className="flex cursor-pointer select-none items-center justify-between px-3 py-2 font-medium text-[var(--text)] hover:bg-[var(--surface-alt)] transition-colors list-none [&::-webkit-details-marker]:hidden">
        <div className="flex items-center gap-2">
          <ChevronDown
            className="h-3.5 w-3.5 text-[var(--muted)] transition-transform duration-200 group-open:rotate-0 -rotate-90 shrink-0"
            aria-hidden="true"
          />
          {isLive ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--accent)] shrink-0" aria-hidden="true" />
          ) : (
            <Wrench className="h-3.5 w-3.5 text-[var(--accent)] shrink-0" aria-hidden="true" />
          )}
          <span>
            {isLive
              ? `Agent exploring codebase (${steps.length} step${steps.length > 1 ? "s" : ""} taken)...`
              : `Agent reasoning timeline (${steps.length} step${steps.length > 1 ? "s" : ""})`}
          </span>
        </div>

        <span className="rounded bg-[var(--surface-alt)] px-2 py-0.5 font-mono text-[10px] text-[var(--muted)]">
          {steps.filter((s) => s.toolName).length} tool calls
        </span>
      </summary>

      <div className="border-t border-[var(--border)] p-3">
        <ol className="relative border-l border-[var(--border)] ml-2 space-y-3">
          {steps.map((step, idx) => (
            <li key={`step-${step.index}-${idx}`} className="ml-4">
              <span className="absolute -left-2 mt-1 flex h-4 w-4 items-center justify-center rounded-full bg-[var(--surface)] border border-[var(--border)]">
                {getToolIcon(step.toolName)}
              </span>

              <div className="rounded-md border border-[var(--border)] bg-[var(--surface)] p-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5">
                    <span className="font-mono text-[10px] font-bold text-[var(--muted)]">
                      #{idx + 1}
                    </span>
                    <span className="font-semibold text-[var(--text)]">
                      {step.toolName ?? step.type}
                    </span>
                  </div>

                  {step.durationMs ? (
                    <span className="inline-flex items-center gap-1 font-mono text-[10px] text-[var(--muted)]">
                      <Clock className="h-3 w-3 opacity-60" aria-hidden="true" />
                      <span>{step.durationMs.toFixed(0)}ms</span>
                    </span>
                  ) : null}
                </div>

                {step.inputSummary && (
                  <div className="mt-1 font-mono text-[11px] text-[var(--muted)] truncate">
                    <span className="text-[var(--text)] opacity-70">input: </span>
                    <span>{step.inputSummary}</span>
                  </div>
                )}

                {step.outputSummary && (
                  <div className="mt-1 font-mono text-[11px] text-[var(--muted)] truncate">
                    <span className="text-[var(--text)] opacity-70">result: </span>
                    <span className="text-emerald-600 dark:text-emerald-400">
                      {step.outputSummary}
                    </span>
                  </div>
                )}
              </div>
            </li>
          ))}
        </ol>
      </div>
    </details>
  );
}

