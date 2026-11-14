export interface UserProfile {
  id: string;
  githubId: number;
  login: string;
  name: string;
  avatarUrl: string;
  createdAt?: string;
}

export type RepoStatus = "pending" | "cloning" | "indexing" | "ready" | "failed";

export interface RepoItem {
  _id: string;
  userId: string;
  owner: string;
  name: string;
  fullName: string;
  defaultBranch: string;
  commitSha?: string;
  status: RepoStatus;
  progress: {
    stage: string;
    processedFiles: number;
    totalFiles: number;
  };
  stats?: {
    files: number;
    chunks: number;
    languages?: Record<string, number>;
  };
  error?: string;
  indexedAt?: string;
  createdAt: string;
}

export interface GitHubRepoItem {
  id: number;
  fullName: string;
  name: string;
  owner: string;
  description: string;
  defaultBranch: string;
  private: boolean;
  sizeKb: number;
  htmlUrl: string;
  updatedAt: string;
}

export interface TreeNode {
  name: string;
  path: string;
  type: "file" | "dir";
  children?: TreeNode[];
}

export interface FileContentResponse {
  path: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  content: string;
}

export interface Citation {
  filePath: string;
  startLine: number;
  endLine: number;
}

export interface RetrievedChunk {
  chunkId?: string;
  filePath: string;
  startLine: number;
  endLine: number;
  score: number;
  source: "vector" | "keyword" | "both" | "unknown";
  symbolName?: string;
  content?: string;
}

export interface ConversationItem {
  _id: string;
  userId: string;
  repoId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentStep {
  index: number;
  type: string;
  toolName?: string;
  inputSummary?: string;
  outputSummary?: string;
  durationMs?: number;
}

export interface RunSummary {
  tokensIn: number;
  tokensOut: number;
  llmCalls: number;
  durationMs: number;
  estimatedCostUsd: number;
}

export interface ChangedFile {
  path: string;
  changeType: "added" | "modified" | "deleted";
  diff: string;
}

export interface TestResult {
  exitCode: number;
  stdoutTail: string;
  stderrTail: string;
  passed: boolean;
}

export interface PullRequestItem {
  _id: string;
  repoId: string;
  runId: string;
  changesetId: string;
  prNumber: number;
  prUrl: string;
  title: string;
  body: string;
  headBranch: string;
  baseBranch: string;
  status: "open" | "closed" | "merged";
  createdAt: string;
}

export interface ChangesetItem {
  _id: string;
  runId: string;
  repoId: string;
  files: ChangedFile[];
  testCommand?: string;
  testResult?: TestResult;
  status: "pending_review" | "approved" | "rejected";
  pullRequest?: {
    prNumber: number;
    prUrl: string;
    title?: string;
  };
  createdAt: string;
  updatedAt: string;
}

export interface MessageItem {
  _id: string;
  conversationId: string;
  role: "user" | "assistant";
  content: string;
  citations: Citation[];
  retrievedChunks?: RetrievedChunk[];
  steps?: AgentStep[];
  runSummary?: RunSummary;
  runId?: string;
  changesetId?: string;
  mode?: "ask" | "edit";
  createdAt: string;
}

export type SseEvent =
  | { type: "run_started"; data: { runId: string } }
  | { type: "step_started"; data: { index: number; type: string } }
  | {
      type: "tool_call";
      data: { index: number; toolName: string; input: unknown };
    }
  | {
      type: "tool_result";
      data: {
        index: number;
        toolName: string;
        outputSummary: string;
        durationMs: number;
      };
    }
  | { type: "retrieval_debug"; data: { chunks: RetrievedChunk[] } }
  | { type: "token"; data: { text: string } }
  | { type: "citation"; data: Citation }
  | { type: "changeset_ready"; data: { changesetId: string; runId?: string } }
  | {
      type: "run_completed";
      data: {
        runId: string;
        totals?: {
          tokensIn?: number;
          tokensOut?: number;
          llmCalls?: number;
          durationMs?: number;
          estimatedCostUsd?: number;
        };
      };
    }
  | { type: "error"; data: { message: string; retryable?: boolean } };

export interface TaskEvalResultItem {
  taskId: string;
  repo: string;
  instruction: string;
  targetFile?: string;
  testCommand: string;
  passed: boolean;
  exitCode: number;
  testOutputTail?: string;
  stepCount: number;
  totalTokens: number;
  durationSec: number;
  editedFiles?: string[];
  failureCategory?: string | null;
  agentStatus?: string;
}

export interface EvalRunItem {
  _id: string;
  suite: "retrieval" | "task";
  createdAt: string;
  configSnapshot: Record<string, any>;
  repos?: string[];
  totalQuestions?: number;
  totalTasks?: number;
  passedTasks?: number;
  failedTasks?: number;
  metrics: {
    passRate?: number;
    avgSteps?: number;
    avgTokens?: number;
    avgDurationSec?: number;
    failureCategories?: Record<string, number>;
    [key: string]: any;
  };
  results?: Array<TaskEvalResultItem & Record<string, any>>;
}
