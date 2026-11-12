# CodeScout: AI Coding Agent for GitHub Repositories
## Implementation Plan (for AI coding agent execution)

---

## 0. Rules for the AI coding agent (read first, follow always)

1. Work on ONE day at a time. Do not start the next day's tasks unless told.
2. Complete tasks in order. After each task, run the service in Docker and verify the acceptance criteria before moving on.
3. Never hardcode secrets, API keys, or model names. Everything comes from environment variables.
4. Every LLM call goes through the provider layer (services/agent/app/llm/). No direct SDK calls elsewhere.
5. Write tests for core logic (chunking, retrieval fusion, agent loop, tools). Use pytest (Python) and vitest (Node).
6. Commit after every completed task using conventional commits (feat:, fix:, chore:, test:).
7. If a requirement is ambiguous or a library does not behave as described, STOP and ask the human instead of guessing.
8. Keep code typed: TypeScript strict mode, Python type hints with Pydantic models.
9. Do not mark a task done until its acceptance criteria pass.

---

## 1. Product summary

A web app where a user signs in with GitHub, connects a repository, and works with an AI agent that:
- Answers questions about the codebase with exact file and line references
- Plans and makes code changes inside an isolated sandbox
- Runs tests to verify changes
- Shows diffs for human approval
- Opens a pull request on approval

Key engineering goals (portfolio focus): high-quality retrieval, a hand-written agent loop, safe sandboxed execution, full tracing, cost and latency tracking, and an evaluation suite with metrics.

---

## 2. Tech stack

| Layer | Choice |
|---|---|
| Frontend | Next.js (App Router) + TypeScript + Tailwind + shadcn/ui + Monaco Editor |
| API | Node.js + Express + TypeScript + Zod + Mongoose |
| Queue | Redis + BullMQ |
| AI service | Python + FastAPI + Pydantic + httpx, managed with uv |
| Parsing | tree-sitter (Python bindings) + tree-sitter-language-pack |
| Keyword search | ripgrep |
| Database | MongoDB (local: mongodb/mongodb-atlas-local Docker image, prod: MongoDB Atlas free cluster) |
| Vector search | MongoDB Atlas Vector Search |
| LLM provider | NVIDIA API (OpenAI-compatible), behind a provider abstraction |
| Tracing | Langfuse Cloud (Hobby plan) |
| Sandbox | Docker containers built from a custom sandbox image |
| Reverse proxy (prod) | Caddy with automatic HTTPS |
| Domain (prod) | Free DuckDNS subdomain (example: codescout.duckdns.org) |
| Hosting | Oracle Cloud Always Free ARM VM (all services via Docker Compose) |
| CI | GitHub Actions |
| Python tooling | uv, ruff, pytest |
| Node tooling | pnpm, eslint, vitest |

---

## 3. Architecture

### 3.1 Deployed services

Production runs 7 long-running containers on one Oracle VM, plus short-lived sandbox containers.

| # | Service | Runtime | Public | Purpose |
|---|---|---|---|---|
| 1 | caddy | Caddy | Yes (80, 443) | HTTPS, routes / to web and /api/* to api |
| 2 | web | Next.js | Via Caddy | Frontend UI |
| 3 | api | Node + Express | Via Caddy | Auth, repos, conversations, runs, GitHub, SSE proxy |
| 4 | worker | Node + BullMQ (same image as api) | No | Background jobs: indexing, cleanup |
| 5 | agent | Python + FastAPI | No (internal only) | Indexing, retrieval, agent loop, tools, sandbox control |
| 6 | redis | Redis | No | Job queue, shared LLM rate limiter, run cancellation flags |
| 7 | docker-socket-proxy | docker-socket-proxy | No | Restricted Docker API access for the agent |
| - | sandbox-{runId} | Custom sandbox image | No | Created per agent run, destroyed after |

Managed external services (free tiers, not deployed by us):
- MongoDB Atlas free cluster: app data, chunks, vector search
- NVIDIA API: chat models, embeddings, reranker
- Langfuse Cloud Hobby: tracing
- GitHub: OAuth login, GitHub App, pull requests
- DuckDNS: free subdomain pointing to the VM

Local development runs the same services except caddy, and adds a local mongo container (mongodb/mongodb-atlas-local) instead of Atlas.

### 3.2 Request flow

Browser → Caddy → Next.js (web)
Browser → Caddy → /api/* → Node API (auth, repos, conversations, runs, GitHub)
Node API → Redis/BullMQ → worker → calls Python agent service for indexing
Node API → Python agent service (internal network only, protected by INTERNAL_API_KEY header)
Python agent service → NVIDIA API (LLM, embeddings, reranker)
Python agent service → MongoDB (chunks, vector search)
Python agent service → docker-socket-proxy → sandbox containers
Python agent service → Langfuse (traces)

Streaming: Python agent emits Server-Sent Events → Node API proxies the SSE stream → browser.

### 3.3 Storage

Shared Docker volume `repos_data` mounted at /data/repos in api, worker and agent services.
- Clones: /data/repos/{repoId}/base
- Agent run working copies: /data/repos/{repoId}/runs/{runId} (git worktree)

The agent service must NOT be exposed publicly. Only the Node API and worker can reach it.

---

## 4. Repository structure

    codescout/
      apps/
        web/                    Next.js frontend
      services/
        api/                    Node Express API and worker
          src/
            routes/
            models/
            middleware/
            queues/
            workers/
            github/
            lib/
        agent/                  Python FastAPI service
          app/
            main.py
            config.py
            llm/                provider layer, rate limiter, retries
            indexing/           clone, file walk, chunking, embedding
            retrieval/          vector, keyword, fusion, rerank
            agent/              agent loop, tools, prompts, events
            sandbox/            docker sandbox manager
            tracing/            langfuse helpers
            db/                 mongo access
          tests/
      sandbox/
        Dockerfile              sandbox image (node + python + git, non-root)
      evals/
        retrieval/              questions and expected files
        tasks/                  coding tasks with sample repos
        run_retrieval_eval.py
        run_task_eval.py
      infra/
        docker-compose.yml
        docker-compose.prod.yml
        Caddyfile
        scripts/
          create_indexes.py
          duckdns_update.sh
      .github/workflows/ci.yml
      .env.example
      README.md

---

## 5. Environment variables (.env.example)

    # General
    NODE_ENV=development
    DOMAIN=localhost
    APP_URL=http://localhost:3000
    API_URL=http://localhost:4000
    AGENT_URL=http://agent:8000
    INTERNAL_API_KEY=change-me

    # Auth
    GITHUB_OAUTH_CLIENT_ID=
    GITHUB_OAUTH_CLIENT_SECRET=
    JWT_SECRET=change-me
    TOKEN_ENCRYPTION_KEY=change-me-32-bytes

    # GitHub App (Day 5)
    GITHUB_APP_ID=
    GITHUB_APP_PRIVATE_KEY_PATH=/secrets/github-app.pem
    GITHUB_APP_SLUG=

    # Database and queue
    MONGODB_URI=mongodb://mongo:27017/codescout?directConnection=true
    REDIS_URL=redis://redis:6379

    # LLM provider (check build.nvidia.com catalog for current model IDs)
    LLM_BASE_URL=https://integrate.api.nvidia.com/v1
    LLM_API_KEY=
    LLM_CHAT_MODEL=
    LLM_FAST_MODEL=
    EMBEDDING_MODEL=
    EMBEDDING_DIMENSIONS=
    RERANK_MODEL=
    LLM_RPM_LIMIT=35
    LLM_MAX_RETRIES=5

    # Tracing
    LANGFUSE_PUBLIC_KEY=
    LANGFUSE_SECRET_KEY=
    LANGFUSE_HOST=https://cloud.langfuse.com

    # Limits
    MAX_REPO_SIZE_MB=50
    MAX_FILES_PER_REPO=3000
    MAX_AGENT_STEPS=15
    SANDBOX_TIMEOUT_SECONDS=120
    SANDBOX_MEMORY=1g
    SANDBOX_CPUS=1
    DAILY_RUNS_PER_USER=20
    EDIT_ALLOWLIST=

    # Production domain (Day 6)
    DUCKDNS_SUBDOMAIN=
    DUCKDNS_TOKEN=

---

## 6. Data models (MongoDB)

users
- githubId (unique), login, name, avatarUrl
- accessTokenEncrypted (AES-GCM with TOKEN_ENCRYPTION_KEY)
- createdAt, updatedAt

repos
- userId, owner, name, fullName, defaultBranch, commitSha
- status: pending | cloning | indexing | ready | failed
- progress: { stage, processedFiles, totalFiles }
- stats: { files, chunks, languages }
- githubInstallationId (Day 5), error, indexedAt

chunks
- repoId, filePath, language
- symbolName, symbolType (function | class | method | module | block)
- startLine, endLine, content, contentHash
- embedding: number[]
- Vector index "chunks_vector" on embedding with filter field repoId
- Regular index on { repoId, filePath }

conversations
- userId, repoId, title, createdAt

messages
- conversationId, role (user | assistant)
- content, citations: [{ filePath, startLine, endLine }]
- runId (optional), createdAt

agent_runs (Day 3)
- conversationId, repoId, userId, mode (ask | edit)
- status: running | awaiting_approval | completed | failed | cancelled
- steps: [{ index, type, toolName, inputSummary, outputSummary, durationMs, tokensIn, tokensOut }]
- totals: { tokensIn, tokensOut, llmCalls, durationMs, estimatedCostUsd }
- langfuseTraceId, error, createdAt

changesets (Day 4)
- runId, repoId, files: [{ path, changeType, diff }]
- testCommand, testResult: { exitCode, stdoutTail, stderrTail, passed }
- status: pending_review | approved | rejected

pull_requests (Day 5)
- runId, repoId, branch, prNumber, prUrl, createdAt

eval_runs (Day 2 and Day 5)
- suite (retrieval | tasks), configSnapshot (models, retrieval settings)
- results: []
- metrics: {}
- createdAt

Note for Atlas free cluster: maximum 3 search indexes. Use only "chunks_vector" for now. If driver methods cannot create search indexes on the free cluster, create the index through the Atlas UI and document the JSON definition in infra/scripts.

---

## 7. API contracts (Node API, prefix /api)

Auth
- GET  /api/auth/github → redirect to GitHub OAuth
- GET  /api/auth/github/callback → create or update user, set httpOnly JWT cookie, redirect to app
- POST /api/auth/logout
- GET  /api/me

Repos
- GET  /api/github/repos → list user's GitHub repos (paginated)
- POST /api/repos { fullName } → create repo record, enqueue indexing job
- GET  /api/repos
- GET  /api/repos/:id → includes status and progress
- POST /api/repos/:id/reindex
- DELETE /api/repos/:id → delete record, chunks, files on disk
- GET  /api/repos/:id/tree → file tree
- GET  /api/repos/:id/file?path=&start=&end= → file content

Conversations and runs
- POST /api/repos/:id/conversations
- GET  /api/repos/:id/conversations
- GET  /api/conversations/:id/messages
- POST /api/conversations/:id/messages { content, mode } → returns SSE stream
- POST /api/runs/:id/cancel
- GET  /api/runs/:id

Changes and PRs (Day 4 and 5)
- GET  /api/runs/:id/changeset
- POST /api/changesets/:id/approve
- POST /api/changesets/:id/reject
- POST /api/changesets/:id/pull-request

GitHub App (Day 5)
- GET  /api/github/app/install → redirect to app installation
- GET  /api/github/app/callback

Evals (Day 5)
- GET  /api/evals/runs
- GET  /api/evals/runs/:id

Status (Day 6)
- GET  /api/health
- GET  /api/status

Agent service (internal, header X-Internal-Key required)
- POST /internal/index { repoId, cloneUrl, token? }
- POST /internal/ask { runId, repoId, conversationHistory, question } → SSE
- POST /internal/run { runId, repoId, conversationHistory, instruction, mode } → SSE
- POST /internal/runs/{runId}/cancel
- GET  /internal/health

SSE event types (shared contract)
- run_started { runId }
- step_started { index, type }
- tool_call { index, toolName, input }
- tool_result { index, toolName, outputSummary, durationMs }
- token { text }
- citation { filePath, startLine, endLine }
- changeset_ready { changesetId }
- run_completed { runId, totals }
- error { message, retryable }

---

## DAY 1: Skeleton, auth, indexing, basic Q&A

Goal: Sign in with GitHub, connect a public repo, index it, ask questions, get answers with clickable file references.

### Task 1.1 Monorepo and Docker Compose
- Create the folder structure from Section 4.
- docker-compose.yml with services: web (3000), api (4000), worker (same image as api, different command), agent (8000, internal only), mongo (mongodb/mongodb-atlas-local), redis.
- Shared volume repos_data at /data/repos for api, worker, agent.
- Health endpoints: GET /api/health, GET /internal/health.
- Hot reload in development for all apps.
- Acceptance: `docker compose up` starts all services, both health endpoints return 200, web shows a landing page.

### Task 1.2 Provider layer and rate limiter (Python)
- app/llm/client.py: OpenAI-compatible async client using LLM_BASE_URL and LLM_API_KEY.
- Functions: chat(messages, tools=None, stream=False, model=None), embed(texts), rerank(query, documents).
- Token-bucket rate limiter in Redis enforcing LLM_RPM_LIMIT across all workers.
- Retries with exponential backoff and jitter on 429 and 5xx, up to LLM_MAX_RETRIES.
- Record tokens in/out and latency for every call.
- Acceptance: unit tests for rate limiter and retry logic pass; a test script can call chat and embed successfully.

### Task 1.3 GitHub OAuth login (Node)
- Manual OAuth flow (no passport needed): scopes read:user and public_repo.
- Upsert user, encrypt GitHub token with AES-GCM, issue JWT in httpOnly, Secure (prod), SameSite=Lax cookie.
- Auth middleware for protected routes.
- Acceptance: user can log in and log out; /api/me returns profile.

### Task 1.4 Repo connection and indexing queue
- GET /api/github/repos lists user repos.
- POST /api/repos validates size via GitHub API (reject over MAX_REPO_SIZE_MB), creates record, enqueues BullMQ job.
- Worker calls agent POST /internal/index; agent updates repo status and progress in Mongo.
- Acceptance: connecting a repo creates a job and the status moves from pending to cloning.

### Task 1.5 Indexing pipeline (Python)
- Shallow clone (depth 1) to /data/repos/{repoId}/base. Store commitSha.
- Walk files respecting .gitignore. Always skip: node_modules, dist, build, .next, vendor, .git, lockfiles, minified files, binaries, files over 500 KB.
- Chunking with tree-sitter for JavaScript, TypeScript, TSX, Python: one chunk per function, method, or class. Large symbols split at 120 lines with 15 lines overlap. Module-level code grouped into blocks.
- Fallback for other text files: 60-line windows with 10-line overlap.
- Text sent for embedding is prefixed with context: "File: {path}\nSymbol: {symbolType} {symbolName}\n" followed by code.
- Embed in batches (size configurable, default 32) through the provider layer.
- Upsert chunks to Mongo, update progress every batch, set status ready or failed with error.
- Script infra/scripts/create_indexes.py creates the vector index (local) and prints the JSON definition (for Atlas UI).
- Acceptance: indexing a small repo (around 100 files) completes; chunks contain correct line ranges; unit tests for chunking cover JS, TS, Python, fallback.

### Task 1.6 Basic Q&A (Python + Node)
- Retrieval: vector search top 8 chunks filtered by repoId.
- Prompt: system prompt requiring answers grounded only in provided code, with citations in the format [path:startLine-endLine]; say "not found in the indexed code" when unsure.
- Stream tokens via SSE, parse citations and emit citation events.
- Node proxies SSE and saves the final assistant message with citations.
- Acceptance: asking "where is X handled" in a known repo returns a grounded answer with at least one correct citation.

### Task 1.7 Frontend Day 1 screens
- Landing page with "Sign in with GitHub".
- Dashboard: connected repos with status badges and indexing progress, button to connect a repo (searchable list).
- Repo workspace: left file tree, center chat, right code viewer (Monaco, read-only).
- Clicking a citation opens the file in the viewer and highlights the line range.
- Acceptance: full flow works in the browser end to end.

### Task 1.8 Tracing
- Langfuse trace per question with spans for retrieval and LLM call, including tokens and latency.
- Acceptance: each question appears in Langfuse with spans.

---

## DAY 2: Retrieval quality and retrieval evals

Goal: Measurably better retrieval using hybrid search and reranking.

### Task 2.1 Keyword search
- ripgrep over /data/repos/{repoId}/base with fixed-string and identifier-aware search.
- Extract candidate identifiers from the question (camelCase, snake_case, quoted terms, file names) with regex; optionally use LLM_FAST_MODEL to propose up to 5 search terms.
- Map ripgrep hits to the enclosing chunk by filePath and line range.

### Task 2.2 Hybrid fusion
- Combine vector results (top 30) and keyword results (top 30) using Reciprocal Rank Fusion (k=60).
- Deduplicate by chunk id.

### Task 2.3 Reranking
- Rerank fused top 30 with RERANK_MODEL; keep top 8.
- If the reranker fails or is rate limited, fall back to fused order and log it.

### Task 2.4 Retrieval config
- All retrieval settings (top-k values, fusion k, rerank on/off) in a single config object so eval runs can compare variants.

### Task 2.5 Retrieval eval suite
- Pick 3 public repos of different styles (one TS backend, one React frontend, one Python project). Pin them to specific commits.
- Create 20 questions per repo in evals/retrieval/{repo}.json with expected file paths (and optionally line ranges).
- run_retrieval_eval.py runs each question through retrieval variants: vector only, hybrid, hybrid + rerank.
- Metrics: Recall@5, Recall@10, MRR, average latency.
- Save results to eval_runs collection and print a comparison table.
- Acceptance: eval script runs end to end; metrics shown for all three variants; results stored.

### Task 2.6 Retrieval debug panel (frontend)
- Toggle in chat showing retrieved chunks, their source (vector, keyword, both), and scores.
- Acceptance: panel shows what was retrieved for each answer.

---

## DAY 3: Agent loop with read-only tools

Goal: Replace single-shot Q&A with a multi-step agent that explores the codebase.

### Task 3.1 Tool definitions (Pydantic schemas)
- search_code(query: str, top_k: int = 8) → hybrid + rerank results
- grep(pattern: str, path_glob: str | None) → ripgrep matches with line numbers (max 50)
- read_file(path: str, start_line: int | None, end_line: int | None) → content with line numbers (max 400 lines per call)
- list_directory(path: str) → entries
- find_symbol(name: str) → chunks whose symbolName matches
- All paths validated to stay inside the repo directory (block path traversal).

### Task 3.2 Agent loop (hand-written, no framework)
- Loop: call LLM with tools → execute tool calls → append results → repeat.
- Stop when the model returns a final answer, MAX_AGENT_STEPS is reached, the run is cancelled (flag in Redis), or token budget is exceeded.
- Truncate large tool outputs with a clear "[truncated]" note.
- If the model's native tool calling fails or returns invalid JSON, retry once with an error message; after that fall back to a strict JSON action format parsed by the loop.
- Conversation history: keep last 6 messages verbatim, summarize older ones with LLM_FAST_MODEL.
- Emit SSE events for every step (Section 7).
- Persist steps and totals to agent_runs.

### Task 3.3 Cost and usage tracking
- Track tokens in/out per call and per run. Estimated cost uses configurable per-model prices (default 0 for free tier, but keep the mechanism).
- Show totals at the end of each run.

### Task 3.4 Tracing
- One Langfuse trace per run; one span per step with tool name, input, output summary, duration.

### Task 3.5 Frontend agent view
- Chat shows a collapsible timeline of agent steps (tool name, short input, duration) above the final answer.
- Cancel button during a run.
- Run summary: steps, tokens, duration.

### Task 3.6 Tests
- Unit tests for the loop with a mocked LLM: normal completion, max steps reached, invalid tool call recovery, cancellation.
- Acceptance: asking a multi-hop question ("how does a request flow from the route to the database for X") triggers several tool calls and returns a grounded answer with citations; tests pass.

---

## DAY 4: Code editing and sandboxed execution

Goal: Agent can modify code and run tests safely, and the user reviews diffs.

### Task 4.1 Sandbox image
- sandbox/Dockerfile: Node LTS, Python 3, git, common build tools. Non-root user. Multi-arch (amd64 and arm64).

### Task 4.2 Sandbox manager (Python)
- Add docker-socket-proxy service to Compose, allowing only the container endpoints needed (create, start, stop, remove, exec, logs). The agent never mounts the raw Docker socket.
- Per run: create git worktree at /data/repos/{repoId}/runs/{runId} on a new branch agent/{runId}.
- Start container with: workspace mounted at /workspace, network disabled by default, memory SANDBOX_MEMORY, cpus SANDBOX_CPUS, pids limit 256, no privileged mode, all capabilities dropped, read-only root filesystem with writable /workspace and /tmp.
- Dependency install step is the only step allowed network access, with a separate timeout, and only on explicit run_command with install=true.
- Commands time out at SANDBOX_TIMEOUT_SECONDS. Capture exit code, stdout tail, stderr tail (last 200 lines).
- Always clean up containers after the run.

### Task 4.3 Write tools
- edit_file(path, old_text, new_text): exact string replacement; fail if old_text is not found or found more than once.
- create_file(path, content)
- delete_file(path)
- run_command(command, install=false): runs in sandbox. Block obviously dangerous commands (rm -rf /, curl piping to shell, etc.).
- get_diff(): returns git diff of the worktree.
- In "edit" mode the agent is instructed to: understand the code, make minimal changes, run relevant tests, iterate on failures up to 3 times, then finish with a summary.

### Task 4.4 Changesets and approval
- On finish, create a changeset with per-file diffs and the last test result; run status becomes awaiting_approval.
- Emit changeset_ready.

### Task 4.5 Frontend diff review
- Mode switch in chat: Ask or Edit.
- Changeset view: list of changed files, Monaco DiffEditor per file, test result panel (pass or fail, output).
- Approve and Reject buttons. Reject discards the worktree.
- Acceptance: in a sample repo with a failing test, an Edit request results in a diff that makes the test pass, shown for review; sandbox limits verified by tests (network blocked, timeout enforced).

---

## DAY 5: Pull requests and task evals

Goal: Approved changes become real pull requests; agent quality is measured.

### Task 5.1 GitHub App
- Permissions: Contents read/write, Pull requests read/write, Metadata read.
- Installation flow; store installationId on repos.
- Generate installation access tokens on demand (short-lived, never stored).

### Task 5.2 Create pull request
- On approval and PR request: commit worktree changes with a generated message, push branch agent/{runId} using the installation token, open PR against the default branch.
- PR body generated by LLM: summary, files changed, test command and result, link back to the run.
- Save pull_requests record; show PR link in UI.
- Only repo owners who installed the app can create PRs.

### Task 5.3 Task eval suite
- Create 3 small sample repos inside evals/tasks/fixtures (one Node/TS, one Python, one mixed), each with intentional bugs and failing tests, plus feature tasks with tests already written.
- 15 tasks total in evals/tasks/tasks.json: { id, repo, instruction, testCommand }.
- run_task_eval.py runs the agent in edit mode on each task in a fresh worktree, then runs testCommand independently.
- Metrics: pass rate, average steps, average tokens, average duration, failures by category (wrong file, test still failing, timeout, tool error).
- Store results in eval_runs.

### Task 5.4 Evals dashboard (frontend)
- /evals page: list of eval runs with config, metrics, and a comparison chart between runs (retrieval and task suites).
- Drill-down per task showing status and a link to its trace.
- Acceptance: a PR is opened on a test repo from the UI; task eval runs end to end and results appear on the dashboard.

---

## DAY 6: Production deployment and hardening

Goal: Public demo running on the Oracle free VM with a free DuckDNS subdomain.

### Task 6.1 VM and domain setup (human does account steps, agent writes scripts and docs)
- Oracle VM: Ubuntu ARM (aarch64), Docker and Docker Compose plugin installed.
- Open ports 80 and 443 in BOTH the Oracle VCN security list AND the VM's own firewall (Oracle Ubuntu images block ports with iptables by default; persist the rules).
- Reserve a static public IP in Oracle so the address does not change.
- DuckDNS: create subdomain, point it to the VM public IP.
- infra/scripts/duckdns_update.sh: updates DuckDNS with the current IP using DUCKDNS_TOKEN; run via cron every 5 minutes as a safety net.
- Acceptance: DOMAIN resolves to the VM IP; ports 80 and 443 reachable.

### Task 6.2 Production Compose
- docker-compose.prod.yml with the 7 services from Section 3.1: caddy, web (next build, standalone output), api, worker, agent, redis, docker-socket-proxy. MongoDB uses the Atlas free cluster (no local mongo).
- All images built for linux/arm64.
- Restart policies, healthchecks, log rotation.
- Only caddy publishes ports to the host.

### Task 6.3 Caddy
- Caddyfile using DOMAIN: / → web, /api/* → api. Automatic HTTPS (Let's Encrypt via HTTP challenge on port 80).
- Agent service not routed.
- Ensure SSE responses are not buffered (flush_interval -1 on the /api reverse proxy).

### Task 6.4 Security and abuse limits
- Rate limit API per user and per IP.
- DAILY_RUNS_PER_USER enforced.
- Edit mode and PR creation restricted to EDIT_ALLOWLIST (comma separated GitHub logins) for the public demo; everyone else gets Ask mode.
- Helmet, CORS locked to APP_URL, input validation with Zod on every route.
- Update GitHub OAuth app and GitHub App callback URLs to https://DOMAIN.
- Secrets mounted as files or env, never committed.

### Task 6.5 CI
- GitHub Actions: lint, typecheck, unit tests for web, api, agent; build arm64 images on main.

### Task 6.6 Operations
- Structured JSON logs with request id across services.
- /api/status page showing service health and LLM provider availability.
- Cleanup job (worker, scheduled): delete worktrees older than 24 hours and repos not used for 14 days.
- Keep the VM active (Oracle may reclaim idle free instances): the scheduled cleanup and health checks provide light regular activity.
- Acceptance: app reachable over HTTPS on the DuckDNS domain; full flow works in production; CI passes.

---

## DAY 7: Documentation and showcase

### Task 7.1 README
- Problem, features, architecture diagram (Mermaid), tech stack, design decisions, how to run locally, how to run evals, limitations.

### Task 7.2 Design decisions section (important for interviews)
- Why a hand-written agent loop.
- Chunking strategy and why tree-sitter.
- Hybrid retrieval and reranking, with eval numbers before and after.
- Sandbox security model.
- Handling a 40 RPM rate limit (token bucket, batching, retries).
- Provider abstraction and model switching.

### Task 7.3 Metrics summary
- Table of retrieval metrics per variant and task eval pass rate, average cost, average latency.

### Task 7.4 Demo assets
- Seed demo with one or two public repos already indexed.
- Script for a 2 to 3 minute demo video: connect repo, ask multi-hop question, request a fix, review diff, open PR, show evals dashboard and a Langfuse trace.
