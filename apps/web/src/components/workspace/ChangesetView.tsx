"use client";

import { useState, useEffect } from "react";
import { DiffEditor } from "@monaco-editor/react";
import {
  CheckCircle2,
  XCircle,
  FileCode,
  Check,
  X,
  Loader2,
  Terminal,
  Code2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { approveChangeset, rejectChangeset } from "@/lib/api";
import type { ChangesetItem, ChangedFile } from "@/lib/types";

interface ChangesetViewProps {
  changeset: ChangesetItem;
  onStatusChange?: (updated: ChangesetItem) => void;
}

const EXT_TO_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  py: "python",
  json: "json",
  md: "markdown",
  css: "css",
  html: "html",
  sh: "shell",
  bash: "shell",
};

function inferLanguage(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  return EXT_TO_LANG[ext] ?? "plaintext";
}

function reconstructOriginalAndModified(
  diff: string,
  changeType: "added" | "modified" | "deleted"
): { original: string; modified: string } {
  if (changeType === "added") {
    const lines = diff
      .split("\n")
      .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
      .map((l) => l.slice(1));
    return { original: "", modified: lines.join("\n") };
  }
  if (changeType === "deleted") {
    const lines = diff
      .split("\n")
      .filter((l) => l.startsWith("-") && !l.startsWith("---"))
      .map((l) => l.slice(1));
    return { original: lines.join("\n"), modified: "" };
  }

  const originalLines: string[] = [];
  const modifiedLines: string[] = [];
  let inHunk = false;

  for (const line of diff.split("\n")) {
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;

    if (line.startsWith("+") && !line.startsWith("+++")) {
      modifiedLines.push(line.slice(1));
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      originalLines.push(line.slice(1));
    } else if (line.startsWith(" ")) {
      originalLines.push(line.slice(1));
      modifiedLines.push(line.slice(1));
    }
  }

  return {
    original: originalLines.join("\n"),
    modified: modifiedLines.join("\n"),
  };
}

export function ChangesetView({ changeset, onStatusChange }: ChangesetViewProps) {
  const [currentChangeset, setCurrentChangeset] = useState<ChangesetItem>(changeset);
  const [selectedFileIdx, setSelectedFileIdx] = useState(0);
  const [isActing, setIsActing] = useState(false);
  const [viewMode, setViewMode] = useState<"diff" | "patch">("diff");
  const [isDark, setIsDark] = useState(false);

  useEffect(() => {
    setCurrentChangeset(changeset);
  }, [changeset]);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    setIsDark(mq.matches);
    const handler = (e: MediaQueryListEvent) => setIsDark(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  const handleApprove = async () => {
    setIsActing(true);
    try {
      const updated = await approveChangeset(currentChangeset._id);
      setCurrentChangeset(updated);
      onStatusChange?.(updated);
    } catch (err) {
      console.error("Failed to approve changeset:", err);
    } finally {
      setIsActing(false);
    }
  };

  const handleReject = async () => {
    setIsActing(true);
    try {
      const updated = await rejectChangeset(currentChangeset._id);
      setCurrentChangeset(updated);
      onStatusChange?.(updated);
    } catch (err) {
      console.error("Failed to reject changeset:", err);
    } finally {
      setIsActing(false);
    }
  };

  const files = currentChangeset.files;
  const activeFile: ChangedFile | undefined = files[selectedFileIdx] ?? files[0];
  const { original, modified } = activeFile
    ? reconstructOriginalAndModified(activeFile.diff, activeFile.changeType)
    : { original: "", modified: "" };

  const statusBadges = {
    pending_review: "bg-amber-500/10 text-amber-500 border-amber-500/20",
    approved: "bg-emerald-500/10 text-emerald-500 border-emerald-500/20",
    rejected: "bg-rose-500/10 text-rose-500 border-rose-500/20",
  };

  return (
    <div className="my-3 flex flex-col rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs text-[var(--text)] shadow-sm">
      {/* Header bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border)] px-3 py-2.5 bg-[var(--surface-elevated)]">
        <div className="flex items-center gap-2">
          <Code2 className="h-4 w-4 text-[var(--accent)]" />
          <span className="font-semibold text-sm">Review Changeset</span>
          <span
            className={`rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${
              statusBadges[currentChangeset.status]
            }`}
          >
            {currentChangeset.status.replace("_", " ")}
          </span>
          <span className="text-[var(--text-muted)]">
            ({files.length} file{files.length === 1 ? "" : "s"} modified)
          </span>
        </div>

        {currentChangeset.status === "pending_review" && (
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="danger"
              disabled={isActing}
              onClick={handleReject}
              className="h-7 text-xs border-rose-500/30 text-rose-500 hover:bg-rose-500/10 hover:text-rose-600"
            >
              {isActing ? (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              ) : (
                <X className="mr-1 h-3.5 w-3.5" />
              )}
              Reject Changes
            </Button>
            <Button
              size="sm"
              disabled={isActing}
              onClick={handleApprove}
              className="h-7 text-xs bg-emerald-600 hover:bg-emerald-700 text-white"
            >
              {isActing ? (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Check className="mr-1 h-3.5 w-3.5" />
              )}
              Approve Changes
            </Button>
          </div>
        )}
      </div>

      {/* Test Result Panel */}
      {currentChangeset.testResult && (
        <div
          className={`border-b border-[var(--border)] px-3 py-2 flex items-start gap-2.5 ${
            currentChangeset.testResult.passed
              ? "bg-emerald-500/5 text-emerald-600 dark:text-emerald-400"
              : "bg-rose-500/5 text-rose-600 dark:text-rose-400"
          }`}
        >
          {currentChangeset.testResult.passed ? (
            <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0 text-emerald-500" />
          ) : (
            <XCircle className="h-4 w-4 mt-0.5 shrink-0 text-rose-500" />
          )}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-xs">
                {currentChangeset.testResult.passed
                  ? "Tests Passed"
                  : `Tests Failed (Exit Code: ${currentChangeset.testResult.exitCode})`}
              </span>
              {currentChangeset.testCommand && (
                <span className="font-mono text-[11px] bg-black/10 dark:bg-white/10 px-1.5 py-0.5 rounded">
                  {currentChangeset.testCommand}
                </span>
              )}
            </div>
            {currentChangeset.testResult.stdoutTail && (
              <details className="mt-1">
                <summary className="cursor-pointer text-[11px] opacity-80 hover:underline">
                  View Test Output
                </summary>
                <pre className="mt-1 max-h-36 overflow-auto rounded bg-black/80 text-emerald-300 dark:bg-black/90 p-2 font-mono text-[11px] whitespace-pre-wrap">
                  {currentChangeset.testResult.stdoutTail}
                  {currentChangeset.testResult.stderrTail && (
                    <span className="text-rose-400">
                      {"\n"}
                      {currentChangeset.testResult.stderrTail}
                    </span>
                  )}
                </pre>
              </details>
            )}
          </div>
        </div>
      )}

      {/* File Navigation & Diff/Patch Toggle */}
      <div className="flex items-center justify-between border-b border-[var(--border)] px-3 py-1.5 bg-[var(--surface)] overflow-x-auto">
        <div className="flex items-center gap-1.5">
          {files.map((file, idx) => {
            const isSelected = idx === selectedFileIdx;
            const typeBadge = {
              added: "text-emerald-500",
              modified: "text-amber-500",
              deleted: "text-rose-500",
            }[file.changeType];

            return (
              <button
                key={file.path}
                type="button"
                onClick={() => setSelectedFileIdx(idx)}
                className={`flex items-center gap-1.5 rounded px-2 py-1 font-mono text-xs transition-colors ${
                  isSelected
                    ? "bg-[var(--accent)] text-white font-medium shadow-sm"
                    : "text-[var(--text-muted)] hover:bg-[var(--surface-elevated)] hover:text-[var(--text)]"
                }`}
              >
                <FileCode className="h-3 w-3" />
                <span>{file.path}</span>
                <span className={`text-[10px] font-bold ${isSelected ? "text-white/80" : typeBadge}`}>
                  {file.changeType === "added" ? "+" : file.changeType === "deleted" ? "-" : "~"}
                </span>
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-1 shrink-0 ml-2">
          <button
            type="button"
            onClick={() => setViewMode("diff")}
            className={`rounded px-2 py-0.5 text-[11px] ${
              viewMode === "diff"
                ? "bg-[var(--border)] font-medium text-[var(--text)]"
                : "text-[var(--text-muted)] hover:text-[var(--text)]"
            }`}
          >
            Side-by-Side
          </button>
          <button
            type="button"
            onClick={() => setViewMode("patch")}
            className={`rounded px-2 py-0.5 text-[11px] ${
              viewMode === "patch"
                ? "bg-[var(--border)] font-medium text-[var(--text)]"
                : "text-[var(--text-muted)] hover:text-[var(--text)]"
            }`}
          >
            Patch
          </button>
        </div>
      </div>

      {/* Editor or Raw Patch View */}
      <div className="relative min-h-[260px] max-h-[420px] overflow-hidden rounded-b-lg">
        {activeFile && viewMode === "diff" ? (
          <DiffEditor
            height="320px"
            original={original}
            modified={modified}
            language={inferLanguage(activeFile.path)}
            theme={isDark ? "vs-dark" : "light"}
            options={{
              readOnly: true,
              renderSideBySide: true,
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              fontSize: 12,
              lineNumbers: "on",
              wordWrap: "on",
            }}
          />
        ) : activeFile && viewMode === "patch" ? (
          <pre className="h-[320px] overflow-auto p-3 font-mono text-[11px] leading-relaxed bg-[var(--surface-elevated)] whitespace-pre-wrap">
            {activeFile.diff}
          </pre>
        ) : (
          <div className="flex h-40 items-center justify-center text-[var(--text-muted)]">
            No changed files selected
          </div>
        )}
      </div>
    </div>
  );
}
