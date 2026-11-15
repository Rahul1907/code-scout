import type {
  ChangesetItem,
  ConversationItem,
  FileContentResponse,
  GitHubRepoItem,
  MessageItem,
  RepoItem,
  SseEvent,
  TreeNode,
  UserProfile,
} from "./types";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: "include",
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });

  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = (await res.json()) as { error?: string; message?: string };
      message = body.error || body.message || message;
    } catch {
      // ignore non-JSON errors
    }
    throw new ApiError(res.status, message);
  }

  return (await res.json()) as T;
}

export async function getMe(): Promise<UserProfile | null> {
  try {
    return await apiFetch<UserProfile>("/api/me");
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      return null;
    }
    throw err;
  }
}

export async function logout(): Promise<void> {
  await apiFetch<{ ok: boolean }>("/api/auth/logout", { method: "POST" });
}

export async function listRepos(): Promise<RepoItem[]> {
  const data = await apiFetch<{ repos: RepoItem[] }>("/api/repos");
  return data.repos;
}

export async function getRepo(repoId: string): Promise<RepoItem> {
  const data = await apiFetch<{ repo: RepoItem }>(`/api/repos/${encodeURIComponent(repoId)}`);
  return data.repo;
}

export async function listGitHubRepos(params?: {
  page?: number;
  perPage?: number;
  q?: string;
}): Promise<{ repos: GitHubRepoItem[]; hasMore: boolean }> {
  const qs = new URLSearchParams();
  if (params?.page) qs.set("page", String(params.page));
  if (params?.perPage) qs.set("per_page", String(params.perPage));
  if (params?.q) qs.set("q", params.q);
  const query = qs.toString();
  return apiFetch<{ repos: GitHubRepoItem[]; hasMore: boolean }>(
    `/api/github/repos${query ? `?${query}` : ""}`,
  );
}

export async function connectRepo(fullName: string): Promise<RepoItem> {
  const data = await apiFetch<{ repo: RepoItem }>("/api/repos", {
    method: "POST",
    body: JSON.stringify({ fullName }),
  });
  return data.repo;
}

export async function reindexRepo(repoId: string): Promise<RepoItem> {
  const data = await apiFetch<{ repo: RepoItem }>(
    `/api/repos/${encodeURIComponent(repoId)}/reindex`,
    { method: "POST" },
  );
  return data.repo;
}

export async function deleteRepo(repoId: string): Promise<void> {
  await apiFetch<{ ok: boolean }>(`/api/repos/${encodeURIComponent(repoId)}`, {
    method: "DELETE",
  });
}

export async function getRepoTree(repoId: string): Promise<TreeNode[]> {
  const data = await apiFetch<{ tree: TreeNode[] }>(
    `/api/repos/${encodeURIComponent(repoId)}/tree`,
  );
  return data.tree;
}

export async function getRepoFile(repoId: string, filePath: string): Promise<FileContentResponse> {
  const qs = new URLSearchParams({ path: filePath });
  return apiFetch<FileContentResponse>(
    `/api/repos/${encodeURIComponent(repoId)}/file?${qs.toString()}`,
  );
}

export async function listConversations(repoId: string): Promise<ConversationItem[]> {
  const data = await apiFetch<{ conversations: ConversationItem[] }>(
    `/api/repos/${encodeURIComponent(repoId)}/conversations`,
  );
  return data.conversations;
}

export async function createConversation(
  repoId: string,
  title?: string,
): Promise<ConversationItem> {
  const data = await apiFetch<{ conversation: ConversationItem }>(
    `/api/repos/${encodeURIComponent(repoId)}/conversations`,
    {
      method: "POST",
      body: JSON.stringify(title ? { title } : {}),
    },
  );
  return data.conversation;
}

export async function listMessages(conversationId: string): Promise<MessageItem[]> {
  const data = await apiFetch<{ messages: MessageItem[] }>(
    `/api/conversations/${encodeURIComponent(conversationId)}/messages`,
  );
  return data.messages;
}

export async function streamMessage(
  conversationId: string,
  content: string,
  onEvent: (event: SseEvent) => void,
  signal?: AbortSignal,
  mode: "ask" | "edit" = "ask",
): Promise<void> {
  const res = await fetch(
    `/api/conversations/${encodeURIComponent(conversationId)}/messages`,
    {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content, mode }),
      signal,
    },
  );

  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // ignore non-json
    }
    throw new ApiError(res.status, message);
  }

  if (!res.body) {
    throw new Error("Response stream unavailable");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const dispatchBlock = (block: string): void => {
    let eventName = "";
    const dataLines: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("event:")) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trim());
      }
    }
    if (!eventName || dataLines.length === 0) return;
    try {
      const parsed = JSON.parse(dataLines.join("\n")) as unknown;
      onEvent({ type: eventName, data: parsed } as SseEvent);
    } catch {
      // ignore malformed SSE block
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split(/\r?\n\r?\n/);
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      if (part.trim()) dispatchBlock(part);
    }
  }

  if (buffer.trim()) {
    dispatchBlock(buffer);
  }
}

export async function cancelRun(runId: string): Promise<void> {
  const res = await fetch(`/api/runs/${runId}/cancel`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error ?? "Failed to cancel run");
  }
}

export async function getChangesetByRunId(runId: string): Promise<ChangesetItem | null> {
  try {
    const data = await apiFetch<{ changeset: ChangesetItem }>(`/api/runs/${runId}/changeset`);
    return data.changeset;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      return null;
    }
    throw err;
  }
}

export async function approveChangeset(changesetId: string): Promise<ChangesetItem> {
  const data = await apiFetch<{ changeset: ChangesetItem }>(
    `/api/changesets/${changesetId}/approve`,
    { method: "POST" }
  );
  return data.changeset;
}

export async function rejectChangeset(changesetId: string): Promise<ChangesetItem> {
  const data = await apiFetch<{ changeset: ChangesetItem }>(
    `/api/changesets/${changesetId}/reject`,
    { method: "POST" }
  );
  return data.changeset;
}
