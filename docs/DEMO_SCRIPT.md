# CodeScout: Showcase Video Script & Demo Guide

A 2 to 3 minute walk-through script demonstrating CodeScout's end-to-end capabilities, designed for portfolio presentations, Loom recordings, and technical interviews.

---

## 1. Demo Setup & Seed Repositories

### Recommended Seed Repositories
* **`Rahul1907/code-scout`**: The CodeScout repository itself (or any public TypeScript/Python repository).
* **Sample Buggy Repository**: Any repository with a failing test or incomplete feature (e.g. `evals/tasks/fixtures/ts-calculator`).

### Pre-Flight Checklist
- [x] Docker Compose running (`api`, `web`, `agent`, `worker`, `redis`, `mongo`, `docker-socket-proxy`).
- [x] Logged in via GitHub OAuth.
- [x] GitHub App installed on the test repository.
- [x] Browser tabs ready:
  1. CodeScout Web Dashboard (`http://localhost:3000/dashboard` or `https://<DOMAIN>/dashboard`)
  2. Evals Dashboard (`http://localhost:3000/evals`)
  3. Langfuse Tracing Dashboard (`https://cloud.langfuse.com`)
  4. GitHub Repository Pull Requests page

---

## 2. Timed Walkthrough Script (2:30 - 3:00)

### [0:00 - 0:30] Introduction & Repository Connection
**Screen**: Landing page & Dashboard.
> *"Hi everyone, this is **CodeScout**, an autonomous AI coding agent for GitHub repositories. Unlike simple code chat wrappers, CodeScout parses repositories into AST syntax trees, executes code and tests inside isolated Docker sandboxes, and automatically opens verified pull requests.*
> 
> *Here on the dashboard, we connect our GitHub repository. In the background, BullMQ workers clone the repository, run Tree-sitter AST symbol chunking, compute 2048-dimension vector embeddings, and build hybrid search indexes in MongoDB."*

---

### [0:30 - 1:05] Grounded Multi-Hop Q&A with Line Citations
**Screen**: Chat workspace (`Ask` mode selected).
> *"Let's ask CodeScout an architectural question: **'How does an incoming pull request creation request flow from the API route to the sandbox manager?'***
> 
> *Notice what's happening live:*
> 1. *The hand-written agent loop triggers tools via SSE streaming.*
> 2. *It runs hybrid search—fusing vector embeddings with ripgrep exact matching via Reciprocal Rank Fusion, then reranks candidates with a cross-encoder model.*
> 3. *The agent returns a grounded answer with exact file and line citations.*
> 
> *If I click a citation, the built-in Monaco code viewer jumps directly to the file and highlights the relevant lines."*

---

### [1:05 - 1:50] Sandboxed Code Editing & Automated Verification
**Screen**: Switch mode toggle from `Ask` to `Edit`.
> *"Now let's switch to **Edit Mode** and ask CodeScout to make a change:*
> 
> ***'Add a power exponentiation method `power(base, exponent)` to the calculator and run the unit tests.'***
> 
> *Under the hood, CodeScout:*
> 1. *Creates a fresh, isolated Git worktree branch (`agent/<run-id>`).*
> 2. *Spawns an ephemeral Docker sandbox container with a read-only root filesystem, dropped Linux capabilities, and no network access.*
> 3. *Modifies the source code using the AST `edit_file` tool.*
> 4. *Executes the test suite in the sandbox to verify the implementation.*
> 
> *Look at the UI: it automatically switches to the **Changeset View**, displaying a side-by-side Monaco DiffEditor showing the exact changes and the test pass confirmation."*

---

### [1:50 - 2:20] One-Click Pull Request Creation
**Screen**: Click **"Create Pull Request"** button.
> *"Once we approve the changeset, we click **Create Pull Request**.*
> 
> *CodeScout signs a short-lived GitHub App JWT with RS256, pushes the dedicated worktree branch to GitHub, generates a clean pull request title and markdown summary with LLM verification notes, and opens the PR.*
> 
> *Clicking the link takes us directly to GitHub, where we see the newly created pull request with test proof and commit history."*

---

### [2:20 - 2:45] Quantitative Evals Dashboard
**Screen**: Navigate to `/evals`.
> *"Agent reliability requires rigorous evaluation. CodeScout includes a built-in **Evaluations Dashboard**:*
> - *We benchmark retrieval quality across three variants: Vector Search, Hybrid Fusion, and Hybrid + Reranking.*
> - *Our cross-encoder reranking achieves **1.00 MRR** and **1.00 Recall@5** on open-source benchmarks.*
> - *Our task-level evaluation runs 15 real-world coding benchmarks across TypeScript and Python fixtures, measuring pass rate, token efficiency, and failure categories."*

---

### [2:45 - 3:00] Langfuse Observability & Conclusion
**Screen**: Langfuse trace view & closing remarks.
> *"Every single agent step, tool call, latency, and token cost is fully traced in Langfuse for production observability.*
> 
> *CodeScout is production-hardened with rate limiters, DuckDNS auto-HTTPS via Caddy, and multi-arch ARM64 containers. Thank you for watching!"*

