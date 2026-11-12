"use client";

import { ArrowLeft, Loader2 } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { ChatPanel } from "@/components/workspace/ChatPanel";
import { CodeViewer } from "@/components/workspace/CodeViewer";
import { FileTree } from "@/components/workspace/FileTree";
import { getMe, getRepo, getRepoFile, getRepoTree } from "@/lib/api";
import type { Citation, RepoItem, TreeNode } from "@/lib/types";

export default function RepoWorkspacePage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const repoId = typeof params?.id === "string" ? params.id : "";

  const [repo, setRepo] = useState<RepoItem | null>(null);
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState("");
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [highlightRange, setHighlightRange] = useState<{
    startLine: number;
    endLine: number;
  } | null>(null);

  const loadFile = useCallback(
    async (filePath: string, range: { startLine: number; endLine: number } | null) => {
      setSelectedPath(filePath);
      setHighlightRange(range);
      setFileLoading(true);
      setFileError(null);
      try {
        const res = await getRepoFile(repoId, filePath);
        setFileContent(res.content);
      } catch (err) {
        setFileContent("");
        setFileError(err instanceof Error ? err.message : "Failed to load file");
      } finally {
        setFileLoading(false);
      }
    },
    [repoId],
  );

  useEffect(() => {
    if (!repoId) return;
    let active = true;

    async function init() {
      try {
        const profile = await getMe();
        if (!active) return;
        if (!profile) {
          router.replace("/");
          return;
        }
        const [repoData, treeData] = await Promise.all([
          getRepo(repoId),
          getRepoTree(repoId).catch(() => [] as TreeNode[]),
        ]);
        if (!active) return;
        setRepo(repoData);
        setTree(treeData);
      } catch (err) {
        if (active) {
          setError(err instanceof Error ? err.message : "Failed to open repository workspace");
        }
      } finally {
        if (active) setLoading(false);
      }
    }

    void init();
    return () => {
      active = false;
    };
  }, [repoId, router]);

  useEffect(() => {
    if (!repo || (repo.status !== "pending" && repo.status !== "cloning" && repo.status !== "indexing")) {
      return;
    }
    const timer = window.setInterval(() => {
      void getRepo(repoId)
        .then(async (updated) => {
          setRepo(updated);
          if (updated.status === "ready") {
            const treeData = await getRepoTree(repoId).catch(() => [] as TreeNode[]);
            setTree(treeData);
          }
        })
        .catch(() => {
          // ignore transient poll errors
        });
    }, 2000);
    return () => window.clearInterval(timer);
  }, [repo, repoId]);

  const handleSelectCitation = (citation: Citation) => {
    void loadFile(citation.filePath, {
      startLine: citation.startLine,
      endLine: citation.endLine,
    });
  };

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center gap-2 text-sm text-[var(--muted)]">
        <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
        <span>Opening repository workspace...</span>
      </div>
    );
  }

  if (error || !repo) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-16">
        <p role="alert" className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-700">
          {error ?? "Repository not found"}
        </p>
        <Link
          href="/dashboard"
          className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-[var(--accent)]"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          <span>Back to Dashboard</span>
        </Link>
      </main>
    );
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <header className="flex shrink-0 items-center justify-between gap-4 border-b border-[var(--border)] bg-[var(--surface)] px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-3">
          <Link
            href="/dashboard"
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-[var(--muted)] hover:bg-[var(--surface-alt)] hover:text-[var(--text)]"
          >
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Dashboard</span>
          </Link>
          <span className="text-[var(--border)]" aria-hidden="true">
            /
          </span>
          <h1 className="truncate font-mono text-sm font-semibold">{repo.fullName}</h1>
          <Badge variant={repo.status === "ready" ? "success" : repo.status === "failed" ? "danger" : "info"}>
            {repo.status}
          </Badge>
        </div>

        {repo.stats && repo.status === "ready" && (
          <span className="hidden text-xs text-[var(--muted)] sm:inline">
            {repo.stats.files} files · {repo.stats.chunks} chunks
          </span>
        )}
      </header>

      <main className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[260px_minmax(0,1fr)_minmax(0,1.05fr)]">
        <aside
          aria-label="Repository file tree"
          className="min-h-0 overflow-y-auto border-b border-[var(--border)] bg-[var(--surface)] lg:border-r lg:border-b-0"
        >
          <div className="border-b border-[var(--border)] px-3 py-2 text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">
            Files
          </div>
          <FileTree
            nodes={tree}
            selectedPath={selectedPath}
            onSelectFile={(path) => void loadFile(path, null)}
          />
        </aside>

        <div className="min-h-0 border-b border-[var(--border)] lg:border-r lg:border-b-0">
          <ChatPanel
            repoId={repo._id}
            repoStatus={repo.status}
            onSelectCitation={handleSelectCitation}
          />
        </div>

        <div className="min-h-0">
          <CodeViewer
            filePath={selectedPath}
            content={fileContent}
            loading={fileLoading}
            error={fileError}
            highlightRange={highlightRange}
          />
        </div>
      </main>
    </div>
  );
}
