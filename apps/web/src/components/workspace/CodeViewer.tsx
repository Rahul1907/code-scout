"use client";

import Editor, { type OnMount } from "@monaco-editor/react";
import { FileCode2, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

type MonacoCodeEditor = Parameters<OnMount>[0];
type MonacoDecorations = ReturnType<MonacoCodeEditor["createDecorationsCollection"]>;

interface CodeViewerProps {
  filePath: string | null;
  content: string;
  loading: boolean;
  error: string | null;
  highlightRange: { startLine: number; endLine: number } | null;
}

const EXT_TO_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  json: "json",
  md: "markdown",
  mdx: "markdown",
  yml: "yaml",
  yaml: "yaml",
  toml: "ini",
  css: "css",
  scss: "scss",
  html: "html",
  xml: "xml",
  sql: "sql",
  sh: "shell",
  bash: "shell",
  go: "go",
  rs: "rust",
  java: "java",
  rb: "ruby",
  php: "php",
  dockerfile: "dockerfile",
};

function inferLanguage(filePath: string | null): string {
  if (!filePath) return "plaintext";
  const base = filePath.split("/").pop()?.toLowerCase() ?? "";
  if (base === "dockerfile") return "dockerfile";
  const ext = base.includes(".") ? base.split(".").pop() ?? "" : "";
  return EXT_TO_LANG[ext] ?? "plaintext";
}

export function CodeViewer({
  filePath,
  content,
  loading,
  error,
  highlightRange,
}: CodeViewerProps) {
  const editorRef = useRef<MonacoCodeEditor | null>(null);
  const decorationsRef = useRef<MonacoDecorations | null>(null);
  const [isDark, setIsDark] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    setIsDark(mq.matches);
    const handler = (e: MediaQueryListEvent) => setIsDark(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  const applyHighlight = (
    editor: MonacoCodeEditor,
    range: { startLine: number; endLine: number } | null,
  ) => {
    decorationsRef.current?.clear();
    if (!range) return;

    const model = editor.getModel();
    const maxLine = model ? model.getLineCount() : range.endLine;
    const start = Math.max(1, Math.min(range.startLine, maxLine));
    const end = Math.max(start, Math.min(range.endLine, maxLine));

    decorationsRef.current = editor.createDecorationsCollection([
      {
        range: {
          startLineNumber: start,
          startColumn: 1,
          endLineNumber: end,
          endColumn: 1,
        },
        options: {
          isWholeLine: true,
          className: "monaco-citation-line",
          linesDecorationsClassName: "monaco-citation-glyph",
        },
      },
    ]);

    editor.revealRangeInCenter({
      startLineNumber: start,
      startColumn: 1,
      endLineNumber: end,
      endColumn: 1,
    });
  };

  const handleMount: OnMount = (editor) => {
    editorRef.current = editor;
    applyHighlight(editor, highlightRange);
  };

  useEffect(() => {
    if (!editorRef.current || loading || !filePath) return;
    applyHighlight(editorRef.current, highlightRange);
  }, [content, filePath, highlightRange, loading]);

  return (
    <section
      aria-label="Code viewer"
      className="flex h-full min-h-0 flex-col bg-[var(--surface)]"
    >
      <div className="flex items-center justify-between gap-2 border-b border-[var(--border)] px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <FileCode2 className="h-4 w-4 shrink-0 text-[var(--muted)]" aria-hidden="true" />
          <span className="truncate font-mono text-xs font-medium">
            {filePath ?? "Select a file or citation"}
          </span>
        </div>
        {filePath && highlightRange && (
          <span className="shrink-0 rounded-md bg-[var(--accent)]/15 px-2 py-0.5 font-mono text-xs text-[var(--accent)]">
            L{highlightRange.startLine}
            {highlightRange.endLine !== highlightRange.startLine
              ? `–${highlightRange.endLine}`
              : ""}
          </span>
        )}
      </div>

      <div className="relative min-h-0 flex-1">
        {loading ? (
          <div className="flex h-full items-center justify-center gap-2 text-xs text-[var(--muted)]">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            <span>Loading file...</span>
          </div>
        ) : error ? (
          <p role="alert" className="p-4 text-xs text-red-600 dark:text-red-400">
            {error}
          </p>
        ) : !filePath ? (
          <div className="flex h-full flex-col items-center justify-center p-6 text-center text-xs text-[var(--muted)]">
            <FileCode2 className="mb-2 h-8 w-8 opacity-60" aria-hidden="true" />
            <p>Choose a file from the tree or click any citation badge in chat to inspect code.</p>
          </div>
        ) : (
          <Editor
            height="100%"
            path={filePath}
            language={inferLanguage(filePath)}
            value={content}
            theme={isDark ? "vs-dark" : "vs"}
            onMount={handleMount}
            options={{
              readOnly: true,
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              fontSize: 13,
              lineNumbers: "on",
              renderLineHighlight: "line",
              wordWrap: "on",
              automaticLayout: true,
            }}
          />
        )}
      </div>
    </section>
  );
}
