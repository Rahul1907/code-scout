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

export interface ConversationItem {
  _id: string;
  userId: string;
  repoId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface MessageItem {
  _id: string;
  conversationId: string;
  role: "user" | "assistant";
  content: string;
  citations: Citation[];
  runId?: string;
  createdAt: string;
}

export type SseEvent =
  | { type: "run_started"; data: { runId: string } }
  | { type: "token"; data: { text: string } }
  | { type: "citation"; data: Citation }
  | {
      type: "run_completed";
      data: {
        runId: string;
        totals?: { tokensIn?: number; tokensOut?: number; durationMs?: number };
      };
    }
  | { type: "error"; data: { message: string; retryable?: boolean } };
