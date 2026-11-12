"use client";

import { FileText, Loader2, MessageSquarePlus, Send } from "lucide-react";
import { Fragment, useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/button";
import { createConversation, listConversations, listMessages, streamMessage } from "@/lib/api";
import type { Citation, ConversationItem, MessageItem, RepoStatus } from "@/lib/types";

interface ChatPanelProps {
  repoId: string;
  repoStatus: RepoStatus;
  onSelectCitation: (citation: Citation) => void;
}

const INLINE_CITATION_RE = /\[([A-Za-z0-9_.\-/]+):(\d+)(?:-(\d+))?\]/g;

function renderMessageWithCitations(
  content: string,
  onSelectCitation: (citation: Citation) => void,
) {
  const parts: Array<string | Citation> = [];
  let lastIndex = 0;
  const regex = new RegExp(INLINE_CITATION_RE.source, "g");
  let match: RegExpExecArray | null = regex.exec(content);

  while (match !== null) {
    if (match.index > lastIndex) {
      parts.push(content.slice(lastIndex, match.index));
    }
    const filePath = match[1] ?? "";
    const startLine = Number(match[2] ?? "1");
    const endLine = Number(match[3] ?? String(startLine));
    parts.push({ filePath, startLine, endLine });
    lastIndex = match.index + match[0].length;
    match = regex.exec(content);
  }

  if (lastIndex < content.length) {
    parts.push(content.slice(lastIndex));
  }

  return parts.map((part, idx) => {
    if (typeof part === "string") {
      return <Fragment key={idx}>{part}</Fragment>;
    }
    return (
      <button
        key={`${part.filePath}-${part.startLine}-${idx}`}
        type="button"
        onClick={() => onSelectCitation(part)}
        className="mx-0.5 inline-flex items-center gap-1 rounded bg-[var(--accent)]/15 px-1.5 py-0.5 font-mono text-xs font-medium text-[var(--accent)] hover:bg-[var(--accent)]/25"
      >
        <span>
          {part.filePath}:{part.startLine}
          {part.endLine !== part.startLine ? `-${part.endLine}` : ""}
        </span>
      </button>
    );
  });
}

export function ChatPanel({ repoId, repoStatus, onSelectCitation }: ChatPanelProps) {
  const [conversations, setConversations] = useState<ConversationItem[]>([]);
  const [activeConvId, setActiveConvId] = useState<string | null>(null);
  const [messages, setMessages] = useState<MessageItem[]>([]);
  const [input, setInput] = useState("");
  const [streamingText, setStreamingText] = useState("");
  const [streamingCitations, setStreamingCitations] = useState<Citation[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [loadingConv, setLoadingConv] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const selectId = useId();
  const promptId = useId();
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    async function load() {
      setLoadingConv(true);
      setError(null);
      try {
        const list = await listConversations(repoId);
        if (!active) return;
        if (list.length > 0 && list[0]) {
          setConversations(list);
          setActiveConvId(list[0]._id);
        } else {
          const created = await createConversation(repoId);
          if (!active) return;
          setConversations([created]);
          setActiveConvId(created._id);
        }
      } catch (err) {
        if (active) {
          setError(err instanceof Error ? err.message : "Failed to load conversations");
        }
      } finally {
        if (active) setLoadingConv(false);
      }
    }
    void load();
    return () => {
      active = false;
    };
  }, [repoId]);

  useEffect(() => {
    if (!activeConvId) return;
    let active = true;
    listMessages(activeConvId)
      .then((msgs) => {
        if (active) setMessages(msgs);
      })
      .catch((err) => {
        if (active) setError(err instanceof Error ? err.message : "Failed to load messages");
      });
    return () => {
      active = false;
    };
  }, [activeConvId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamingText]);

  const handleNewConversation = async () => {
    if (isStreaming) return;
    setError(null);
    try {
      const created = await createConversation(repoId);
      setConversations((prev) => [created, ...prev]);
      setActiveConvId(created._id);
      setMessages([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create conversation");
    }
  };

  const sendQuestion = async () => {
    const trimmed = input.trim();
    if (!trimmed || !activeConvId || isStreaming || repoStatus !== "ready") return;

    setInput("");
    setError(null);
    setIsStreaming(true);
    setStreamingText("");
    setStreamingCitations([]);

    const optimisticUserMsg: MessageItem = {
      _id: `tmp-user-${Date.now()}`,
      conversationId: activeConvId,
      role: "user",
      content: trimmed,
      citations: [],
      createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, optimisticUserMsg]);

    let finalContent = "";
    const collectedCitations: Citation[] = [];

    try {
      await streamMessage(activeConvId, trimmed, (evt) => {
        if (evt.type === "token") {
          finalContent += evt.data.text;
          setStreamingText(finalContent);
        } else if (evt.type === "citation") {
          const cit = evt.data;
          const dup = collectedCitations.some(
            (c) =>
              c.filePath === cit.filePath &&
              c.startLine === cit.startLine &&
              c.endLine === cit.endLine,
          );
          if (!dup) {
            collectedCitations.push(cit);
            setStreamingCitations([...collectedCitations]);
          }
        } else if (evt.type === "error") {
          setError(evt.data.message);
        }
      });

      const refreshed = await listMessages(activeConvId);
      setMessages(refreshed);
      const updatedConvs = await listConversations(repoId);
      setConversations(updatedConvs);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to get answer");
    } finally {
      setStreamingText("");
      setStreamingCitations([]);
      setIsStreaming(false);
    }
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    void sendQuestion();
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void sendQuestion();
    }
  };

  return (
    <section aria-label="Q&A Chat" className="flex h-full min-h-0 flex-col bg-[var(--bg)]">
      <div className="flex items-center justify-between gap-2 border-b border-[var(--border)] bg-[var(--surface)] px-4 py-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <label htmlFor={selectId} className="sr-only">
            Active conversation
          </label>
          <select
            id={selectId}
            value={activeConvId ?? ""}
            disabled={isStreaming || loadingConv}
            onChange={(e) => setActiveConvId(e.target.value)}
            className="min-w-0 max-w-xs truncate rounded-md border border-[var(--border)] bg-[var(--bg)] px-2.5 py-1 text-xs text-[var(--text)]"
          >
            {conversations.map((conv) => (
              <option key={conv._id} value={conv._id}>
                {conv.title}
              </option>
            ))}
          </select>
        </div>

        <Button
          size="sm"
          variant="secondary"
          disabled={isStreaming}
          onClick={() => void handleNewConversation()}
        >
          <MessageSquarePlus className="h-3.5 w-3.5" aria-hidden="true" />
          <span>New chat</span>
        </Button>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        {loadingConv ? (
          <div className="flex items-center justify-center gap-2 py-12 text-xs text-[var(--muted)]">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            <span>Loading conversation...</span>
          </div>
        ) : messages.length === 0 && !isStreaming ? (
          <div className="rounded-xl border border-dashed border-[var(--border)] bg-[var(--surface)] p-6 text-center text-sm text-[var(--muted)]">
            <p className="font-medium text-[var(--text)]">Ask anything about this repository</p>
            <p className="mt-1 text-xs">
              Try asking &ldquo;Where is routing handled?&rdquo; or &ldquo;How does authentication
              work?&rdquo;. Click any citation to jump directly to the source lines.
            </p>
          </div>
        ) : (
          messages.map((msg) => (
            <article
              key={msg._id}
              className={
                msg.role === "user"
                  ? "ml-auto max-w-[85%] rounded-2xl bg-[var(--accent)] px-4 py-2.5 text-sm text-white dark:text-slate-950"
                  : "max-w-[95%] rounded-2xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3 text-sm text-[var(--text)]"
              }
            >
              <div className="whitespace-pre-wrap leading-relaxed">
                {msg.role === "assistant"
                  ? renderMessageWithCitations(msg.content, onSelectCitation)
                  : msg.content}
              </div>

              {msg.role === "assistant" && msg.citations.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1.5 border-t border-[var(--border)] pt-2.5">
                  {msg.citations.map((cit, idx) => (
                    <button
                      key={`${cit.filePath}:${cit.startLine}-${cit.endLine}-${idx}`}
                      type="button"
                      onClick={() => onSelectCitation(cit)}
                      className="inline-flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--surface-alt)] px-2 py-1 font-mono text-xs text-[var(--text)] hover:border-[var(--accent)] hover:text-[var(--accent)]"
                    >
                      <FileText className="h-3 w-3 shrink-0" aria-hidden="true" />
                      <span>
                        {cit.filePath}:{cit.startLine}
                        {cit.endLine !== cit.startLine ? `-${cit.endLine}` : ""}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </article>
          ))
        )}

        {isStreaming && (
          <article
            aria-live="polite"
            className="max-w-[95%] rounded-2xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3 text-sm text-[var(--text)]"
          >
            {streamingText ? (
              <div className="whitespace-pre-wrap leading-relaxed">
                {renderMessageWithCitations(streamingText, onSelectCitation)}
              </div>
            ) : (
              <div className="flex items-center gap-2 text-xs text-[var(--muted)]">
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                <span>Searching indexed code and thinking...</span>
              </div>
            )}

            {streamingCitations.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-1.5 border-t border-[var(--border)] pt-2.5">
                {streamingCitations.map((cit, idx) => (
                  <button
                    key={`stream-${cit.filePath}:${cit.startLine}-${idx}`}
                    type="button"
                    onClick={() => onSelectCitation(cit)}
                    className="inline-flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--surface-alt)] px-2 py-1 font-mono text-xs text-[var(--text)] hover:border-[var(--accent)]"
                  >
                    <FileText className="h-3 w-3 shrink-0" aria-hidden="true" />
                    <span>
                      {cit.filePath}:{cit.startLine}
                      {cit.endLine !== cit.startLine ? `-${cit.endLine}` : ""}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </article>
        )}
        <div ref={bottomRef} />
      </div>

      {error && (
        <p
          role="alert"
          className="mx-4 mb-2 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/60 dark:text-red-300"
        >
          {error}
        </p>
      )}

      <form
        onSubmit={handleSubmit}
        className="border-t border-[var(--border)] bg-[var(--surface)] p-3"
      >
        <label htmlFor={promptId} className="sr-only">
          Ask a question about the repository
        </label>
        <div className="flex items-end gap-2">
          <textarea
            id={promptId}
            name="question"
            rows={2}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={isStreaming || repoStatus !== "ready"}
            placeholder={
              repoStatus === "ready"
                ? "Ask a question about this codebase... (Enter to send, Shift+Enter for newline)"
                : `Repository is ${repoStatus}. Chat unlocks when indexing completes.`
            }
            className="min-h-[44px] flex-1 resize-y rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm text-[var(--text)] focus:border-[var(--accent)] focus:outline-none disabled:opacity-60"
          />
          <Button
            type="submit"
            disabled={!input.trim() || isStreaming || repoStatus !== "ready"}
          >
            {isStreaming ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <Send className="h-4 w-4" aria-hidden="true" />
            )}
            <span>Ask</span>
          </Button>
        </div>
      </form>
    </section>
  );
}
