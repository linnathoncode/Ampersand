"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { SourceTable } from "@ampersand/contracts";

import { AppShell } from "../components/app-shell";
import {
  authenticatedUserChangedEvent,
  createTenantHeaders,
  fetchWithAuthRedirect,
  getAuthenticatedUserId,
  getSelectedTenant,
  nucleusUrl,
} from "../auth/client";

const composerMaxHeight = 144;
const terminalTrainingStatuses = new Set(["succeeded", "failed", "cancelled", "dead"]);

type TrainingProgress = {
  id: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "dead";
  progressPercent: number;
  progressMessage: string | null;
  errorCode: string | null;
  errorMessage: string | null;
};

export default function ChatPage() {
  const [tenant, setTenant] = useState("");
  const [userId, setUserId] = useState("");
  const conversationCacheKey = `ampersand:chat:${tenant}:${userId}`;
  const timestampCacheKey = `ampersand:chat-timestamps:${tenant}:${userId}`;
  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: `${nucleusUrl}/chat`,
        credentials: "include",
        headers: {
          ...createTenantHeaders(tenant),
        },
        fetch: fetchWithAuthRedirect,
      }),
    [tenant],
  );
  const { error, messages, sendMessage, setMessages, status, stop } = useChat({ transport });
  const [input, setInput] = useState("");
  const [hasRestoredConversation, setHasRestoredConversation] = useState(false);
  const [llmStatus, setLlmStatus] = useState<
    | { state: "checking" }
    | { state: "available"; model: string }
    | { state: "unavailable"; message: string }
  >({ state: "checking" });
  const [messageTimestamps, setMessageTimestamps] = useState<Record<string, string>>({});
  const [trainingProgress, setTrainingProgress] = useState<TrainingProgress | null>(null);
  const composerInputRef = useRef<HTMLTextAreaElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const isBusy = status === "submitted" || status === "streaming";
  const trainingJob = useMemo(() => findLatestQueuedTrainingJob(messages), [messages]);
  const trainingIsActive =
    trainingProgress?.status === "queued" || trainingProgress?.status === "running";
  const activeToolName = findActiveToolName(messages);

  useEffect(() => {
    setTenant(getSelectedTenant() ?? "");

    const updateAuthenticatedUser = (event?: Event) => {
      const changedUserId =
        event instanceof CustomEvent && typeof event.detail === "string"
          ? event.detail
          : getAuthenticatedUserId();

      setHasRestoredConversation(false);
      setUserId(changedUserId ?? "");
    };

    updateAuthenticatedUser();
    window.addEventListener(
      authenticatedUserChangedEvent,
      updateAuthenticatedUser,
    );

    return () =>
      window.removeEventListener(
        authenticatedUserChangedEvent,
        updateAuthenticatedUser,
      );
  }, []);

  useEffect(() => {
    if (!tenant || !userId) return;

    const cachedMessages = readCachedMessages(
      window.sessionStorage.getItem(conversationCacheKey),
    );

    setMessages(cachedMessages ?? []);
    setMessageTimestamps(readCachedTimestamps(timestampCacheKey));
    setHasRestoredConversation(true);
  }, [conversationCacheKey, setMessages, tenant, timestampCacheKey, userId]);

  useEffect(() => {
    if (!tenant) return;

    void fetchWithAuthRedirect(`${nucleusUrl}/chat/status`, {
      credentials: "include",
      headers: createTenantHeaders(tenant),
      cache: "no-store",
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("The conversation service could not be reached.");
        const result = (await response.json()) as
          | { available: true; model: string }
          | { available: false; message: string };
        setLlmStatus(
          result.available
            ? { state: "available", model: result.model }
            : { state: "unavailable", message: result.message },
        );
      })
      .catch((reason: unknown) =>
        setLlmStatus({
          state: "unavailable",
          message: reason instanceof Error
            ? reason.message
            : "The conversation service could not be reached.",
        }),
      );
  }, [tenant]);

  useEffect(() => {
    if (!hasRestoredConversation) return;

    window.sessionStorage.setItem(conversationCacheKey, JSON.stringify(messages));

    setMessageTimestamps((current) => {
      const next = { ...current };
      let changed = false;

      for (const message of messages) {
        if (message.role !== "assistant" || next[message.id]) continue;

        next[message.id] = new Date().toISOString();
        changed = true;
      }

      if (!changed) return current;

      window.sessionStorage.setItem(timestampCacheKey, JSON.stringify(next));
      return next;
    });
  }, [conversationCacheKey, hasRestoredConversation, messages, timestampCacheKey]);

  useEffect(() => {
    const animationFrame = window.requestAnimationFrame(() => {
      const thread = threadRef.current;

      if (!thread) return;

      thread.scrollTo({
        behavior: status === "submitted" ? "smooth" : "auto",
        top: thread.scrollHeight,
      });
    });

    return () => window.cancelAnimationFrame(animationFrame);
  }, [messages, status]);

  useEffect(() => {
    if (!trainingJob || !tenant) return;

    let cancelled = false;
    let timer: number | undefined;

    const loadProgress = async () => {
      const response = await fetchWithAuthRedirect(
        `${nucleusUrl}/training-jobs/${trainingJob.id}`,
        {
          credentials: "include",
          headers: createTenantHeaders(tenant),
          cache: "no-store",
        },
      );
      if (!response.ok) throw new Error("Training progress could not be loaded");

      const progress = (await response.json()) as TrainingProgress;
      if (cancelled) return;

      setTrainingProgress(progress);
      if (!terminalTrainingStatuses.has(progress.status)) {
        timer = window.setTimeout(() => void loadProgress(), 1_500);
      }
    };

    setTrainingProgress({
      id: trainingJob.id,
      status: trainingJob.status,
      progressPercent: trainingJob.progressPercent,
      progressMessage: trainingJob.progressMessage,
      errorCode: null,
      errorMessage: null,
    });
    void loadProgress().catch(() => {
      if (!cancelled) {
        setTrainingProgress((current) =>
          current
            ? { ...current, status: "failed", errorMessage: "Training progress could not be loaded" }
            : null,
        );
      }
    });

    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [tenant, trainingJob]);

  return (
    <AppShell activeSection="chat" activeTab="selection" breadcrumb="Conversation">
      <section className="conversation" aria-label="Prediction conversation">
        <div className="conversation-toolbar">
          <button
            disabled={trainingIsActive}
            onClick={async () => {
              if (isBusy) await stop();

              window.sessionStorage.removeItem(conversationCacheKey);
              window.sessionStorage.removeItem(timestampCacheKey);
              window.location.reload();
            }}
            type="button"
          >
            New conversation
          </button>
        </div>
        <div className="conversation-thread" aria-live="polite" ref={threadRef}>
          {llmStatus.state === "unavailable" ? (
            <div className="conversation-unavailable" role="alert">
              <span className="conversation-mark">&amp;</span>
              <h1>Conversation unavailable</h1>
              <p>{llmStatus.message}</p>
              <button onClick={() => window.location.reload()} type="button">Check again</button>
            </div>
          ) : messages.length === 0 ? (
            <div className="conversation-empty">
              <span className="conversation-mark">&amp;</span>
              <p>Ask for a prediction using one of your published models.</p>
            </div>
          ) : (
            messages.map((message) => (
              <article className={`message message-${message.role}`} key={message.id}>
                <div className="message-content">
                  {message.parts.map((part, index) => {
                    if (part.type === "text") {
                      return <p key={index}>{part.text}</p>;
                    }

                    if (part.type === "dynamic-tool") {
                      return (
                        <details className="tool-call" key={index} open>
                          <summary>
                            <span className="tool-call-name">{part.toolName}</span>
                            <span className={`tool-call-state tool-call-state-${part.state}`}>
                              {formatToolState(part.state)}
                            </span>
                          </summary>
                          <div className="tool-call-body">
                            {part.toolName !== "list_source_tables" && (
                              <div className="tool-call-section">
                                <span>Input</span>
                                {renderToolInput(part.input)}
                              </div>
                            )}
                            {part.state === "output-available" && (
                              <div className="tool-call-section">
                                <span>Result</span>
                                {renderToolOutput(
                                  part.toolName,
                                  part.output,
                                  part.toolName === "start_model_training" &&
                                    isConfirmationRequiredResult(part.output)
                                    ? () => void sendMessage({ text: "Confirm" })
                                    : undefined,
                                )}
                              </div>
                            )}
                            {part.state === "output-error" && (
                              <p className="tool-call-error">{part.errorText}</p>
                            )}
                          </div>
                        </details>
                      );
                    }

                    return null;
                  })}
                  {message.role === "assistant" && messageTimestamps[message.id] && (
                    <time
                      className="message-timestamp"
                      dateTime={messageTimestamps[message.id]}
                    >
                      {formatMessageTime(messageTimestamps[message.id])}
                    </time>
                  )}
                </div>
              </article>
            ))
          )}
          {(status === "submitted" || (isBusy && activeToolName)) && (
            <div className="conversation-status" role="status">
              <span aria-hidden="true" className="thinking-mark">
                <span className="thinking-mark-ghost">&amp;</span>
                <span className="thinking-mark-ink">&amp;</span>
              </span>
              <span>
                {activeToolName
                  ? `Calling ${formatToolName(activeToolName)}`
                  : "Thinking"}
              </span>
            </div>
          )}
          {trainingProgress && (
            <div className={`training-progress training-progress-${trainingProgress.status}`} role="status">
              <div>
                <strong>{formatTrainingStatus(trainingProgress.status)}</strong>
                <span>{trainingProgress.progressPercent}%</span>
              </div>
              <progress max={100} value={trainingProgress.progressPercent} />
              <p>{trainingProgress.errorMessage ?? trainingProgress.progressMessage}</p>
            </div>
          )}
        </div>

        {error && (
          <div className="conversation-error" role="alert">
            <span>{formatChatError(error)}</span>
            <button onClick={() => window.location.reload()} type="button">Reload</button>
          </div>
        )}

        <form
          className="composer"
          onSubmit={(event) => {
            event.preventDefault();
            const text = input.trim();

            if (!text || isBusy || trainingIsActive || llmStatus.state !== "available") return;

            void sendMessage({ text });
            setInput("");
            window.requestAnimationFrame(() => {
              if (composerInputRef.current) resizeComposer(composerInputRef.current);
            });
          }}
        >
          <label className="sr-only" htmlFor="conversation-input">Message</label>
          <textarea
            id="conversation-input"
            onChange={(event) => {
              setInput(event.target.value);
              resizeComposer(event.currentTarget);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
            placeholder="Ask ampersand"
            ref={composerInputRef}
            rows={1}
            disabled={trainingIsActive}
            value={input}
          />
          {isBusy ? (
            <button className="composer-stop" onClick={() => stop()} type="button">Stop</button>
          ) : (
            <button
              aria-label="Send message"
              className="composer-send"
            disabled={!input.trim() || trainingIsActive || llmStatus.state !== "available"}
              title="Send message"
              type="submit"
            >
              <svg aria-hidden="true" viewBox="0 0 24 24">
                <path d="M22 2 15 22 11 13 2 9 22 2Z" />
                <path d="M22 2 11 13" />
              </svg>
            </button>
          )}
        </form>
      </section>
    </AppShell>
  );
}

function formatToolState(state: string): string {
  if (state === "output-available") return "Complete";
  if (state === "output-error") return "Failed";
  return "Running";
}

function formatToolPayload(value: unknown): string {
  if (value === undefined) return "Waiting for input";

  return JSON.stringify(value, null, 2);
}

function renderToolOutput(
  toolName: string,
  output: unknown,
  onConfirmTraining?: () => void,
): ReactNode {
  if (isConfirmationRequiredResult(output)) {
    return (
      <div className="tool-confirmation-result">
        <p>{output.message}</p>
        {onConfirmTraining && (
          <button
            className="tool-confirmation-button"
            onClick={onConfirmTraining}
            type="button"
          >
            Confirm and start training
          </button>
        )}
      </div>
    );
  }

  if (toolName === "list_source_tables" && isSourceTableResult(output)) {
    if (output.tables.length === 0) {
      return <p className="tool-result-empty">No source tables are available.</p>;
    }

    return (
      <div className="source-table-results">
        {output.tables.map((table) => (
          <section className="source-table-result" key={table.name}>
            <header>
              <strong>{table.name}</strong>
              <span>{table.rowCount.toLocaleString()} rows</span>
            </header>
            <table>
              <thead>
                <tr><th>Column</th><th>Type</th><th>Nullable</th></tr>
              </thead>
              <tbody>
                {table.columns.map((column) => (
                  <tr key={column.name}>
                    <td>{column.name}</td>
                    <td>{column.dataType ?? "unsupported"}</td>
                    <td>{column.isNullable ? "Yes" : "No"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ))}
      </div>
    );
  }

  if (isValidationToolResult(output)) {
    const issue = output.errors[0];

    return (
      <div className="tool-validation-result" role="alert">
        <strong>Invalid tool input</strong>
        <dl>
          <div><dt>Field</dt><dd>{formatValidationPath(issue.path)}</dd></div>
          <div><dt>Expected</dt><dd>{formatExpectedValue(issue.summary)}</dd></div>
          <div><dt>Received</dt><dd>{formatReadableValue(issue.value)}</dd></div>
        </dl>
      </div>
    );
  }

  return <pre>{formatToolPayload(output)}</pre>;
}

function renderToolInput(value: unknown): ReactNode {
  if (!isPlainObject(value)) return <pre>{formatToolPayload(value)}</pre>;

  return (
    <dl className="tool-input-fields">
      {Object.entries(value).map(([name, fieldValue]) => (
        <div key={name}>
          <dt>{formatFieldName(name)}</dt>
          <dd>{formatReadableValue(fieldValue)}</dd>
        </div>
      ))}
    </dl>
  );
}

type ValidationToolResult = {
  type: "validation";
  errors: Array<{ path: string; value: unknown; summary: string }>;
};

function isConfirmationRequiredResult(value: unknown): value is {
  outcome: "rejected";
  code: "CONFIRMATION_REQUIRED";
  message: string;
} {
  return (
    isPlainObject(value) &&
    value.outcome === "rejected" &&
    value.code === "CONFIRMATION_REQUIRED" &&
    typeof value.message === "string"
  );
}

function isValidationToolResult(value: unknown): value is ValidationToolResult {
  return (
    isPlainObject(value) &&
    value.type === "validation" &&
    Array.isArray(value.errors) &&
    value.errors.length > 0 &&
    isPlainObject(value.errors[0]) &&
    typeof value.errors[0].path === "string" &&
    typeof value.errors[0].summary === "string"
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatFieldName(value: string): string {
  return value.replace(/([a-z])([A-Z])/g, "$1 $2").replaceAll("_", " ");
}

function formatValidationPath(value: string): string {
  return value.replace(/^\/inputs\//, "").replaceAll("/", " > ");
}

function formatExpectedValue(value: string): string {
  const expected = value.match(/should be one of: (.+)$/)?.[1];
  return expected?.replaceAll("'", "") ?? value;
}

function formatReadableValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(String).join(", ");
  if (value === null) return "null";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function isSourceTableResult(value: unknown): value is { tables: SourceTable[] } {
  return (
    typeof value === "object" &&
    value !== null &&
    "tables" in value &&
    Array.isArray(value.tables)
  );
}

function findActiveToolName(messages: UIMessage[]): string | null {
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const parts = messages[messageIndex].parts;

    for (let partIndex = parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = parts[partIndex];

      if (
        part.type === "dynamic-tool" &&
        part.state !== "output-available" &&
        part.state !== "output-error"
      ) {
        return part.toolName;
      }
    }
  }

  return null;
}

function findLatestQueuedTrainingJob(messages: UIMessage[]): {
  id: string;
  status: TrainingProgress["status"];
  progressPercent: number;
  progressMessage: string | null;
} | null {
  for (const message of [...messages].reverse()) {
    for (const part of [...message.parts].reverse()) {
      if (
        part.type !== "dynamic-tool" ||
        part.toolName !== "start_model_training" ||
        part.state !== "output-available" ||
        !isQueuedTrainingOutput(part.output)
      ) {
        continue;
      }

      return part.output.job;
    }
  }

  return null;
}

function isQueuedTrainingOutput(value: unknown): value is {
  outcome: "queued";
  job: {
    id: string;
    status: TrainingProgress["status"];
    progressPercent: number;
    progressMessage: string | null;
  };
} {
  if (!isPlainObject(value) || value.outcome !== "queued" || !isPlainObject(value.job)) {
    return false;
  }

  return (
    typeof value.job.id === "string" &&
    typeof value.job.status === "string" &&
    typeof value.job.progressPercent === "number" &&
    (typeof value.job.progressMessage === "string" || value.job.progressMessage === null)
  );
}

function formatTrainingStatus(status: TrainingProgress["status"]): string {
  if (status === "queued") return "Training queued";
  if (status === "running") return "Training model";
  if (status === "succeeded") return "Training complete";
  if (status === "failed") return "Training failed";
  if (status === "cancelled") return "Training cancelled";
  return "Training stopped";
}

function formatToolName(value: string): string {
  return value.replaceAll("_", " ");
}

function readCachedMessages(value: string | null): UIMessage[] | null {
  if (!value) return null;

  try {
    const messages = JSON.parse(value) as unknown;

    return Array.isArray(messages) ? (messages as UIMessage[]) : null;
  } catch {
    return null;
  }
}

function readCachedTimestamps(timestampCacheKey: string): Record<string, string> {
  const value = window.sessionStorage.getItem(timestampCacheKey);

  if (!value) return {};

  try {
    const timestamps = JSON.parse(value) as unknown;

    return timestamps && typeof timestamps === "object"
      ? (timestamps as Record<string, string>)
      : {};
  } catch {
    window.sessionStorage.removeItem(timestampCacheKey);
    return {};
  }
}

function formatMessageTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatChatError(error: Error): string {
  if (error.message.includes("Failed to fetch")) {
    return "The conversation service could not be reached.";
  }

  try {
    const parsed = JSON.parse(error.message) as {
      error?: { message?: string };
    };
    return parsed.error?.message ?? "The conversation could not continue.";
  } catch {
    return error.message || "The conversation could not continue.";
  }
}

function resizeComposer(textarea: HTMLTextAreaElement): void {
  textarea.style.height = "auto";
  textarea.style.height = `${Math.min(textarea.scrollHeight, composerMaxHeight)}px`;
  textarea.style.overflowY =
    textarea.scrollHeight > composerMaxHeight ? "auto" : "hidden";
}
