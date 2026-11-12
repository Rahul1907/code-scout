"use client";

import { GitBranch, Loader2, Plus, Search, X } from "lucide-react";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { connectRepo, listGitHubRepos } from "@/lib/api";
import type { GitHubRepoItem, RepoItem } from "@/lib/types";

interface ConnectRepoDialogProps {
  open: boolean;
  connectedFullNames: Set<string>;
  onClose: () => void;
  onConnected: (repo: RepoItem) => void;
}

export function ConnectRepoDialog({
  open,
  connectedFullNames,
  onClose,
  onConnected,
}: ConnectRepoDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const searchId = useId();
  const manualId = useId();

  const [query, setQuery] = useState("");
  const [manualFullName, setManualFullName] = useState("");
  const [repos, setRepos] = useState<GitHubRepoItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [submittingName, setSubmittingName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  // Fallback for browsers without <dialog closedby="any"> support (e.g., Safari)
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if ("closedBy" in HTMLDialogElement.prototype) return;

    let pressedOutside = false;
    const isOutside = (e: PointerEvent): boolean => {
      const rect = dialog.getBoundingClientRect();
      return (
        e.clientX < rect.left ||
        e.clientX > rect.right ||
        e.clientY < rect.top ||
        e.clientY > rect.bottom
      );
    };

    const onPointerDown = (e: PointerEvent) => {
      pressedOutside = isOutside(e);
    };
    const onPointerUp = (e: PointerEvent) => {
      if (pressedOutside && isOutside(e)) {
        dialog.close();
      }
      pressedOutside = false;
    };

    dialog.addEventListener("pointerdown", onPointerDown);
    dialog.addEventListener("pointerup", onPointerUp);
    return () => {
      dialog.removeEventListener("pointerdown", onPointerDown);
      dialog.removeEventListener("pointerup", onPointerUp);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoading(true);
    setError(null);
    listGitHubRepos({ perPage: 50 })
      .then((res) => {
        if (active) setRepos(res.repos.filter((r) => !r.private));
      })
      .catch((err) => {
        if (active) {
          setError(err instanceof Error ? err.message : "Failed to load GitHub repositories");
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [open]);

  const handleConnect = async (fullName: string) => {
    setSubmittingName(fullName);
    setError(null);
    try {
      const repo = await connectRepo(fullName);
      setManualFullName("");
      onConnected(repo);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to connect repository");
    } finally {
      setSubmittingName(null);
    }
  };

  const handleManualSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = manualFullName.trim();
    if (!trimmed) return;
    await handleConnect(trimmed);
  };

  const normalizedQuery = query.trim().toLowerCase();
  const filteredRepos = normalizedQuery
    ? repos.filter(
        (r) =>
          r.fullName.toLowerCase().includes(normalizedQuery) ||
          r.description.toLowerCase().includes(normalizedQuery),
      )
    : repos;

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      onClose={() => {
        if (dialogRef.current) dialogRef.current.returnValue = "";
        onClose();
      }}
      {...({ closedby: "any" } as Record<string, string>)}
      className="m-auto w-full max-w-2xl rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-0 text-[var(--text)] shadow-2xl"
    >
      <div className="flex items-center justify-between border-b border-[var(--border)] px-6 py-4">
        <h2 id={titleId} className="text-lg font-semibold">
          Connect a Public GitHub Repository
        </h2>
        <button
          type="button"
          onClick={() => dialogRef.current?.close()}
          aria-label="Close dialog"
          className="rounded-lg p-1.5 text-[var(--muted)] hover:bg-[var(--surface-alt)] hover:text-[var(--text)]"
        >
          <X className="h-5 w-5" aria-hidden="true" />
        </button>
      </div>

      <div className="space-y-5 p-6">
        <form onSubmit={handleManualSubmit} className="space-y-2">
          <label htmlFor={manualId} className="block text-sm font-medium">
            Connect any public repo by <code className="font-mono">owner/name</code>
          </label>
          <div className="flex gap-2">
            <input
              id={manualId}
              name="fullName"
              type="text"
              value={manualFullName}
              onChange={(e) => setManualFullName(e.target.value)}
              placeholder="e.g. encode/starlette"
              pattern="^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$"
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
              className="min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm text-[var(--text)] focus:border-[var(--accent)] focus:outline-none"
            />
            <Button type="submit" disabled={!manualFullName.trim() || submittingName !== null}>
              {submittingName === manualFullName.trim() ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <Plus className="h-4 w-4" aria-hidden="true" />
              )}
              <span>Connect</span>
            </Button>
          </div>
        </form>

        <div className="border-t border-[var(--border)] pt-4">
          <search>
            <label htmlFor={searchId} className="mb-1.5 block text-sm font-medium">
              Or pick from your public GitHub repositories
            </label>
            <div className="relative">
              <Search
                className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-[var(--muted)]"
                aria-hidden="true"
              />
              <input
                id={searchId}
                name="repoSearch"
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Filter repositories..."
                autoFocus
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] py-2 pr-3 pl-9 text-sm text-[var(--text)] focus:border-[var(--accent)] focus:outline-none"
              />
            </div>
          </search>

          {error && (
            <p
              role="alert"
              className="mt-3 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/60 dark:text-red-300"
            >
              {error}
            </p>
          )}

          <div className="mt-3 max-h-72 overflow-y-auto rounded-lg border border-[var(--border)]">
            {loading ? (
              <div className="flex items-center justify-center gap-2 py-10 text-sm text-[var(--muted)]">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                <span>Loading repositories from GitHub...</span>
              </div>
            ) : filteredRepos.length === 0 ? (
              <p className="py-8 text-center text-sm text-[var(--muted)]">
                {repos.length === 0
                  ? "No public repositories returned from your GitHub account. Use owner/name above to connect any public repository."
                  : "No repositories match your filter."}
              </p>
            ) : (
              <ul className="divide-y divide-[var(--border)]">
                {filteredRepos.map((repo) => {
                  const alreadyConnected = connectedFullNames.has(repo.fullName);
                  const isBusy = submittingName === repo.fullName;
                  return (
                    <li
                      key={repo.id}
                      className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-[var(--surface-alt)]"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <GitBranch className="h-3.5 w-3.5 shrink-0 text-[var(--muted)]" aria-hidden="true" />
                          <span className="truncate font-mono text-sm font-medium">
                            {repo.fullName}
                          </span>
                          <span className="text-xs text-[var(--muted)]">
                            {Math.max(1, Math.round(repo.sizeKb / 1024))} MB
                          </span>
                        </div>
                        {repo.description && (
                          <p className="mt-0.5 truncate text-xs text-[var(--muted)]">
                            {repo.description}
                          </p>
                        )}
                      </div>
                      <Button
                        size="sm"
                        variant={alreadyConnected ? "secondary" : "primary"}
                        disabled={alreadyConnected || submittingName !== null}
                        onClick={() => void handleConnect(repo.fullName)}
                      >
                        {isBusy ? (
                          <>
                            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                            <span>Connecting...</span>
                          </>
                        ) : alreadyConnected ? (
                          <span>Connected</span>
                        ) : (
                          <span>Connect</span>
                        )}
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      </div>
    </dialog>
  );
}
