"use client";

import { ChevronDown, Database, ExternalLink } from "lucide-react";
import type { Citation, RetrievedChunk } from "@/lib/types";

interface RetrievalDebugViewProps {
  chunks: RetrievedChunk[];
  defaultOpen?: boolean;
  onSelectCitation: (citation: Citation) => void;
}

export function RetrievalDebugView({
  chunks,
  defaultOpen = false,
  onSelectCitation,
}: RetrievalDebugViewProps) {
  if (!chunks || chunks.length === 0) return null;

  const vectorCount = chunks.filter((c) => c.source === "vector").length;
  const keywordCount = chunks.filter((c) => c.source === "keyword").length;
  const bothCount = chunks.filter((c) => c.source === "both").length;

  return (
    <details
      open={defaultOpen ? true : undefined}
      className="group mt-3 rounded-lg border border-[var(--border)] bg-[var(--surface-alt)]/40 text-xs overflow-hidden"
    >
      <summary className="flex cursor-pointer select-none items-center justify-between px-3 py-2 font-medium text-[var(--text)] hover:bg-[var(--surface-alt)] transition-colors list-none [&::-webkit-details-marker]:hidden">
        <div className="flex items-center gap-2">
          <ChevronDown
            className="h-3.5 w-3.5 text-[var(--muted)] transition-transform duration-200 group-open:rotate-0 -rotate-90 shrink-0"
            aria-hidden="true"
          />
          <Database className="h-3.5 w-3.5 text-[var(--accent)] shrink-0" aria-hidden="true" />
          <span>Retrieval debug ({chunks.length} chunks)</span>
        </div>

        <div className="flex items-center gap-1.5 text-[10px]">
          {bothCount > 0 && (
            <span className="rounded bg-purple-500/15 px-1.5 py-0.5 font-semibold text-purple-700 dark:text-purple-300">
              {bothCount} hybrid
            </span>
          )}
          {vectorCount > 0 && (
            <span className="rounded bg-sky-500/15 px-1.5 py-0.5 font-semibold text-sky-700 dark:text-sky-300">
              {vectorCount} vector
            </span>
          )}
          {keywordCount > 0 && (
            <span className="rounded bg-amber-500/15 px-1.5 py-0.5 font-semibold text-amber-700 dark:text-amber-300">
              {keywordCount} keyword
            </span>
          )}
        </div>
      </summary>

      <div className="border-t border-[var(--border)] p-2.5 space-y-2">
        {chunks.map((chunk, idx) => {
          const sourceBadge =
            chunk.source === "both" ? (
              <span className="inline-flex items-center rounded-md border border-purple-500/20 bg-purple-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-purple-600 dark:text-purple-400">
                Vector + Keyword
              </span>
            ) : chunk.source === "keyword" ? (
              <span className="inline-flex items-center rounded-md border border-amber-500/20 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-600 dark:text-amber-400">
                Keyword
              </span>
            ) : chunk.source === "vector" ? (
              <span className="inline-flex items-center rounded-md border border-sky-500/20 bg-sky-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-sky-600 dark:text-sky-400">
                Vector
              </span>
            ) : (
              <span className="inline-flex items-center rounded-md border border-slate-500/20 bg-slate-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-slate-600 dark:text-slate-400">
                Unknown
              </span>
            );

          return (
            <article
              key={`${chunk.filePath}-${chunk.startLine}-${chunk.endLine}-${idx}`}
              className="rounded-md border border-[var(--border)] bg-[var(--surface)] p-2"
            >
              <div className="flex flex-wrap items-center justify-between gap-1.5">
                <div className="flex items-center gap-1.5">
                  <span className="font-mono text-[10px] font-bold text-[var(--muted)]">
                    #{idx + 1}
                  </span>
                  {sourceBadge}
                  {chunk.symbolName && (
                    <span className="font-mono text-[11px] text-[var(--muted)]">
                      ({chunk.symbolName})
                    </span>
                  )}
                </div>

                <span className="font-mono text-[11px] text-[var(--muted)]">
                  Score: <strong className="text-[var(--text)]">{chunk.score.toFixed(4)}</strong>
                </span>
              </div>

              <div className="mt-1.5 flex items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={() =>
                    onSelectCitation({
                      filePath: chunk.filePath,
                      startLine: chunk.startLine,
                      endLine: chunk.endLine,
                    })
                  }
                  className="inline-flex items-center gap-1 font-mono text-xs font-medium text-[var(--accent)] hover:underline"
                >
                  <span>
                    {chunk.filePath}:{chunk.startLine}
                    {chunk.endLine !== chunk.startLine ? `-${chunk.endLine}` : ""}
                  </span>
                  <ExternalLink className="h-3 w-3 shrink-0 opacity-70" aria-hidden="true" />
                </button>
              </div>

              {chunk.content && (
                <pre className="mt-2 max-h-24 overflow-x-auto overflow-y-auto rounded bg-[var(--surface-alt)] p-1.5 font-mono text-[10px] text-[var(--text)] leading-relaxed whitespace-pre">
                  {chunk.content.slice(0, 300)}
                  {chunk.content.length > 300 ? "..." : ""}
                </pre>
              )}
            </article>
          );
        })}
      </div>
    </details>
  );
}

