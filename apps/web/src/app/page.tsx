import Link from "next/link";
import { AuthHeaderAction } from "@/components/AuthHeaderAction";

export default function LandingPage() {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-[var(--border)] bg-[var(--surface)]">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <Link href="/" className="flex items-center gap-2 text-lg font-semibold tracking-tight">
            <svg
              aria-hidden="true"
              className="h-6 w-6 text-[var(--accent)]"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
              />
            </svg>
            <span>CodeScout</span>
          </Link>
          <nav aria-label="Primary">
            <ul className="flex items-center gap-4">
              <li>
                <a
                  href="/api/health"
                  className="text-sm text-[var(--muted)] transition-colors hover:text-[var(--text)]"
                >
                  API Status
                </a>
              </li>
              <li>
                <AuthHeaderAction variant="nav" />
              </li>
            </ul>
          </nav>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col justify-center px-6 py-16">
        <div className="max-w-2xl space-y-6">
          <p className="inline-block rounded-full border border-[var(--border)] bg-[var(--surface)] px-3 py-1 text-xs font-medium text-[var(--muted)]">
            Grounded retrieval · Sandboxed execution · Human-reviewed PRs
          </p>
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
            Understand and ship changes in any GitHub repository.
          </h1>
          <p className="text-lg text-[var(--muted)]">
            Connect a repository to index symbols with tree-sitter, ask architecture questions
            backed by exact file and line citations, and review tested diffs before opening a pull
            request.
          </p>
          <div className="flex flex-wrap items-center gap-4 pt-2">
            <AuthHeaderAction variant="hero" />
          </div>
        </div>

        <section aria-labelledby="capabilities-heading" className="mt-16">
          <h2 id="capabilities-heading" className="mb-6 text-xl font-semibold">
            Core capabilities
          </h2>
          <ul className="grid gap-6 sm:grid-cols-3">
            <li className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5">
              <h3 className="font-semibold">AST-aware indexing</h3>
              <p className="mt-2 text-sm text-[var(--muted)]">
                Parses functions, classes, and methods via tree-sitter with hybrid vector and
                ripgrep retrieval.
              </p>
            </li>
            <li className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5">
              <h3 className="font-semibold">Line-level citations</h3>
              <p className="mt-2 text-sm text-[var(--muted)]">
                Every answer links directly to file paths and line ranges inside an embedded code
                viewer.
              </p>
            </li>
            <li className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5">
              <h3 className="font-semibold">Sandboxed edits</h3>
              <p className="mt-2 text-sm text-[var(--muted)]">
                Executes changes and tests inside isolated Docker containers before you approve a PR.
              </p>
            </li>
          </ul>
        </section>
      </main>

      <footer className="border-t border-[var(--border)] py-6 text-center text-xs text-[var(--muted)]">
        CodeScout — AI Coding Agent for GitHub Repositories
      </footer>
    </div>
  );
}
