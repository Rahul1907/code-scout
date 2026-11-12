"use client";

import {
  AlertCircle,
  CheckCircle2,
  FolderGit2,
  Loader2,
  LogOut,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ConnectRepoDialog } from "@/components/ConnectRepoDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { deleteRepo, getMe, listRepos, logout, reindexRepo } from "@/lib/api";
import type { RepoItem, RepoStatus, UserProfile } from "@/lib/types";

function StatusBadge({ status }: { status: RepoStatus }) {
  switch (status) {
    case "ready":
      return (
        <Badge variant="success">
          <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
          <span>Ready</span>
        </Badge>
      );
    case "failed":
      return (
        <Badge variant="danger">
          <AlertCircle className="h-3.5 w-3.5" aria-hidden="true" />
          <span>Failed</span>
        </Badge>
      );
    case "cloning":
      return (
        <Badge variant="info">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          <span>Cloning</span>
        </Badge>
      );
    case "indexing":
      return (
        <Badge variant="info">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          <span>Indexing</span>
        </Badge>
      );
    default:
      return (
        <Badge variant="warning">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          <span>Pending</span>
        </Badge>
      );
  }
}

export default function DashboardPage() {
  const router = useRouter();
  const [user, setUser] = useState<UserProfile | null>(null);
  const [repos, setRepos] = useState<RepoItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [busyRepoId, setBusyRepoId] = useState<string | null>(null);

  const refreshRepos = useCallback(async () => {
    const items = await listRepos();
    setRepos(items);
  }, []);

  useEffect(() => {
    let active = true;
    async function init() {
      try {
        const profile = await getMe();
        if (!active) return;
        if (!profile) {
          router.replace("/");
          return;
        }
        setUser(profile);
        await refreshRepos();
      } catch (err) {
        if (active) {
          setError(err instanceof Error ? err.message : "Failed to load dashboard");
        }
      } finally {
        if (active) setLoading(false);
      }
    }
    void init();
    return () => {
      active = false;
    };
  }, [refreshRepos, router]);

  const hasActiveIndexing = useMemo(
    () => repos.some((r) => r.status === "pending" || r.status === "cloning" || r.status === "indexing"),
    [repos],
  );

  useEffect(() => {
    if (!hasActiveIndexing) return;
    const timer = window.setInterval(() => {
      void refreshRepos().catch(() => {
        // ignore transient poll errors
      });
    }, 2000);
    return () => window.clearInterval(timer);
  }, [hasActiveIndexing, refreshRepos]);

  const connectedFullNames = useMemo(() => new Set(repos.map((r) => r.fullName)), [repos]);

  const handleLogout = async () => {
    await logout();
    router.push("/");
  };

  const handleReindex = async (repoId: string) => {
    setBusyRepoId(repoId);
    setError(null);
    try {
      const updated = await reindexRepo(repoId);
      setRepos((prev) => prev.map((r) => (r._id === repoId ? updated : r)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to trigger reindex");
    } finally {
      setBusyRepoId(null);
    }
  };

  const handleDelete = async (repoId: string) => {
    setBusyRepoId(repoId);
    setError(null);
    try {
      await deleteRepo(repoId);
      setRepos((prev) => prev.filter((r) => r._id !== repoId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete repository");
    } finally {
      setBusyRepoId(null);
    }
  };

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center gap-2 text-sm text-[var(--muted)]">
        <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
        <span>Loading your workspace...</span>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-[var(--border)] bg-[var(--surface)]">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3.5">
          <Link href="/dashboard" className="flex items-center gap-2 text-lg font-semibold">
            <FolderGit2 className="h-5 w-5 text-[var(--accent)]" aria-hidden="true" />
            <span>CodeScout</span>
          </Link>

          <div className="flex items-center gap-4">
            {user && (
              <div className="flex items-center gap-2 text-sm">
                {user.avatarUrl && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={user.avatarUrl}
                    alt={`${user.login} avatar`}
                    className="h-7 w-7 rounded-full border border-[var(--border)]"
                  />
                )}
                <span className="font-medium">@{user.login}</span>
              </div>
            )}
            <Button variant="ghost" size="sm" onClick={() => void handleLogout()}>
              <LogOut className="h-4 w-4" aria-hidden="true" />
              <span>Sign out</span>
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-8">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Connected Repositories</h1>
            <p className="mt-1 text-sm text-[var(--muted)]">
              Connect a public GitHub repository to index its codebase and start asking questions.
            </p>
          </div>
          <Button onClick={() => setDialogOpen(true)}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            <span>Connect Repository</span>
          </Button>
        </div>

        {error && (
          <p
            role="alert"
            className="mt-4 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/60 dark:text-red-300"
          >
            {error}
          </p>
        )}

        {repos.length === 0 ? (
          <section className="mt-8 rounded-2xl border border-dashed border-[var(--border)] bg-[var(--surface)] px-6 py-16 text-center">
            <FolderGit2 className="mx-auto h-10 w-10 text-[var(--muted)]" aria-hidden="true" />
            <h2 className="mt-3 text-base font-semibold">No repositories connected yet</h2>
            <p className="mx-auto mt-1 max-w-md text-sm text-[var(--muted)]">
              Pick one of your GitHub repositories or enter any public{" "}
              <code className="font-mono">owner/name</code> repository to begin indexing.
            </p>
            <Button className="mt-5" onClick={() => setDialogOpen(true)}>
              <Plus className="h-4 w-4" aria-hidden="true" />
              <span>Connect your first repository</span>
            </Button>
          </section>
        ) : (
          <ul className="mt-6 grid gap-4 md:grid-cols-2">
            {repos.map((repo) => {
              const total = repo.progress?.totalFiles ?? 0;
              const processed = repo.progress?.processedFiles ?? 0;
              const isBusy = busyRepoId === repo._id;
              const isActive =
                repo.status === "pending" ||
                repo.status === "cloning" ||
                repo.status === "indexing";

              return (
                <li
                  key={repo._id}
                  className="flex flex-col justify-between rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5"
                >
                  <div>
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h2 className="truncate font-mono text-base font-semibold">
                          {repo.fullName}
                        </h2>
                        <p className="mt-0.5 text-xs text-[var(--muted)]">
                          Branch: <code className="font-mono">{repo.defaultBranch}</code>
                          {repo.commitSha ? ` · ${repo.commitSha.slice(0, 7)}` : ""}
                        </p>
                      </div>
                      <StatusBadge status={repo.status} />
                    </div>

                    {isActive && (
                      <div className="mt-4 space-y-1.5" role="status" aria-live="polite">
                        <div className="flex items-center justify-between text-xs text-[var(--muted)]">
                          <span className="capitalize">{repo.progress?.stage || repo.status}</span>
                          {total > 0 && (
                            <span>
                              {processed} / {total} files
                            </span>
                          )}
                        </div>
                        <progress
                          value={total > 0 ? processed : undefined}
                          max={total > 0 ? total : undefined}
                          className="h-2 w-full overflow-hidden rounded-full accent-[var(--accent)]"
                        />
                      </div>
                    )}

                    {repo.status === "ready" && repo.stats && (
                      <p className="mt-3 text-xs text-[var(--muted)]">
                        {repo.stats.files} files · {repo.stats.chunks} indexed chunks
                      </p>
                    )}

                    {repo.status === "failed" && repo.error && (
                      <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-950/60 dark:text-red-300">
                        {repo.error}
                      </p>
                    )}
                  </div>

                  <div className="mt-5 flex flex-wrap items-center justify-between gap-2 border-t border-[var(--border)] pt-4">
                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={isBusy || isActive}
                        onClick={() => void handleReindex(repo._id)}
                      >
                        <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                        <span>Reindex</span>
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        disabled={isBusy}
                        onClick={() => void handleDelete(repo._id)}
                      >
                        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                        <span>Remove</span>
                      </Button>
                    </div>

                    <Link
                      href={`/repos/${repo._id}`}
                      className="inline-flex items-center rounded-lg bg-[var(--accent)] px-3.5 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90 dark:text-slate-950"
                    >
                      Open Workspace →
                    </Link>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </main>

      <ConnectRepoDialog
        open={dialogOpen}
        connectedFullNames={connectedFullNames}
        onClose={() => setDialogOpen(false)}
        onConnected={(repo) => {
          setRepos((prev) => [repo, ...prev.filter((r) => r._id !== repo._id)]);
        }}
      />
    </div>
  );
}
