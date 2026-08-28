"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import Markdown from "react-markdown";
import type { GeneratedToolDefinition, SourceTable } from "@ampersand/contracts";

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
const composerHints = ["Ask ampersand", "/datasets", "/tools"];

const slashCommands = [
  {
    command: "/datasets",
    aliases: [],
    description: "List available datasets",
    endpoint: "/source-tables",
    toolName: "list_source_tables",
  },
  {
    command: "/tools",
    aliases: ["/tool"],
    description: "List published prediction tools",
    endpoint: "/tools",
    toolName: "list_prediction_tools",
  },
] as const;

type SlashCommand = (typeof slashCommands)[number];

type TrainingProgress = {
  id: string;
  modelVersionId: string | null;
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
  const [composerHintIndex, setComposerHintIndex] = useState(0);
  const [commandError, setCommandError] = useState<string | null>(null);
  const [hasRestoredConversation, setHasRestoredConversation] = useState(false);
  const [llmStatus, setLlmStatus] = useState<
    | { state: "checking" }
    | { state: "available"; model: string }
    | { state: "unavailable"; message: string }
  >({ state: "checking" });
  const [messageTimestamps, setMessageTimestamps] = useState<Record<string, string>>({});
  const [trainingProgress, setTrainingProgress] = useState<TrainingProgress | null>(null);
  const [replacementTrainingJob, setReplacementTrainingJob] = useState<ReturnType<typeof findLatestQueuedTrainingJob>>(null);
  const [trainingAction, setTrainingAction] = useState<"publishing" | "retrying" | null>(null);
  const [trainingActionMessage, setTrainingActionMessage] = useState<string | null>(null);
  const [publishedModelVersionId, setPublishedModelVersionId] = useState<string | null>(null);
  const composerInputRef = useRef<HTMLTextAreaElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const authenticatedUserRef = useRef<string | null>(null);
  const restoredConversationKeyRef = useRef<string | null>(null);
  const isBusy = status === "submitted" || status === "streaming";
  const assistantMessageKey = useMemo(
    () => messages
      .filter((message) => message.role === "assistant")
      .map((message) => message.id)
      .join("|"),
    [messages],
  );
  const trainingJob = useMemo(() => findLatestQueuedTrainingJob(messages), [messages]);
  const currentTrainingJob = replacementTrainingJob ?? trainingJob;
  const currentTrainingJobId = currentTrainingJob?.id;
  const trainingIsActive =
    trainingProgress?.status === "queued" || trainingProgress?.status === "running";
  const activeToolName = findActiveToolName(messages);
  const visibleSlashCommands = input.startsWith("/")
    ? slashCommands.filter((command) =>
        [command.command, ...command.aliases].some((value) =>
          value.startsWith(input.trim().toLowerCase()),
        ),
      )
    : [];
  const isSlashCommandInput = slashCommands.some(
    (command) =>
      [command.command, ...command.aliases].some(
        (value) => value === input.trim().toLowerCase(),
      ),
  );

  useEffect(() => {
    setTenant(getSelectedTenant() ?? "");

    const updateAuthenticatedUser = (event?: Event) => {
      const changedUserId =
        event instanceof CustomEvent && typeof event.detail === "string"
          ? event.detail
          : getAuthenticatedUserId();

      if (authenticatedUserRef.current === changedUserId) return;

      authenticatedUserRef.current = changedUserId;
      restoredConversationKeyRef.current = null;
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
    if (restoredConversationKeyRef.current === conversationCacheKey) return;

    const cachedMessages = readCachedMessages(
      window.sessionStorage.getItem(conversationCacheKey),
    );

    restoredConversationKeyRef.current = conversationCacheKey;
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
  }, [conversationCacheKey, hasRestoredConversation, messages]);

  useEffect(() => {
    if (!hasRestoredConversation) return;

    const assistantMessageIds = assistantMessageKey
      ? assistantMessageKey.split("|")
      : [];

    setMessageTimestamps((current) => {
      const next = { ...current };
      let changed = false;

      for (const messageId of assistantMessageIds) {
        if (next[messageId]) continue;

        next[messageId] = new Date().toISOString();
        changed = true;
      }

      if (!changed) return current;

      window.sessionStorage.setItem(timestampCacheKey, JSON.stringify(next));
      return next;
    });
  }, [assistantMessageKey, hasRestoredConversation, timestampCacheKey]);

  useEffect(() => {
    if (input) return;

    const timer = window.setInterval(() => {
      setComposerHintIndex((current) => (current + 1) % composerHints.length);
    }, 3_400);

    return () => window.clearInterval(timer);
  }, [input]);

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
    if (!currentTrainingJobId || !tenant) return;

    let cancelled = false;
    let timer: number | undefined;

    const loadProgress = async () => {
      const response = await fetchWithAuthRedirect(
        `${nucleusUrl}/training-jobs/${currentTrainingJobId}`,
        {
          credentials: "include",
          headers: createTenantHeaders(tenant),
          cache: "no-store",
        },
      );

      if (response.status === 429) {
        timer = window.setTimeout(() => void loadProgress(), 10_000);
        return;
      }

      if (!response.ok) throw new Error("Training progress could not be loaded");

      const progress = (await response.json()) as TrainingProgress;
      if (cancelled) return;

      setTrainingProgress((current) =>
        hasSameTrainingProgress(current, progress) ? current : progress,
      );
      if (!terminalTrainingStatuses.has(progress.status)) {
        timer = window.setTimeout(() => void loadProgress(), 5_000);
      }
    };

    const initialProgress: TrainingProgress = {
      id: currentTrainingJobId,
      modelVersionId: null,
      status: "queued",
      progressPercent: 0,
      progressMessage: "Waiting for a worker",
      errorCode: null,
      errorMessage: null,
    };
    setTrainingProgress((current) =>
      current?.id === currentTrainingJobId ? current : initialProgress,
    );
    void loadProgress().catch(() => {
      if (!cancelled) {
        setTrainingProgress((current) => {
          if (!current) return null;
          if (
            current.status === "failed" &&
            current.errorMessage === "Training progress could not be loaded"
          ) {
            return current;
          }

          return {
            ...current,
            status: "failed",
            errorMessage: "Training progress could not be loaded",
          };
        });
      }
    });

    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [currentTrainingJobId, tenant]);

  async function publishTrainingModel(modelVersionId: string) {
    if (!tenant) return;

    setTrainingAction("publishing");
    setTrainingActionMessage(null);
    try {
      const response = await fetchWithAuthRedirect(
        `${nucleusUrl}/model-versions/${modelVersionId}/publish`,
        {
          method: "POST",
          credentials: "include",
          headers: createTenantHeaders(tenant),
        },
      );
      if (!response.ok) throw new Error(await readActionError(response, "Model publication failed"));
      setPublishedModelVersionId(modelVersionId);
      setTrainingActionMessage("Model published and available for tool discovery.");
    } catch (reason) {
      setTrainingActionMessage(reason instanceof Error ? reason.message : "Model publication failed");
    } finally {
      setTrainingAction(null);
    }
  }

  async function retryTrainingJob() {
    if (!tenant || !currentTrainingJob?.datasetDefinitionId) return;

    setTrainingAction("retrying");
    setTrainingActionMessage(null);
    try {
      const response = await fetchWithAuthRedirect(`${nucleusUrl}/training-jobs`, {
        method: "POST",
        credentials: "include",
        headers: { ...createTenantHeaders(tenant), "Content-Type": "application/json" },
        body: JSON.stringify({ datasetDefinitionId: currentTrainingJob.datasetDefinitionId }),
      });
      if (!response.ok) throw new Error(await readActionError(response, "Training retry failed"));
      const result = (await response.json()) as { outcome?: string; job?: TrainingProgress };
      if (result.outcome !== "queued" || !result.job) throw new Error("Training retry returned an invalid response");
      setReplacementTrainingJob({
        ...result.job,
        datasetDefinitionId: currentTrainingJob.datasetDefinitionId,
      });
      setTrainingProgress({ ...result.job, modelVersionId: null, errorCode: null, errorMessage: null });
      setTrainingActionMessage("Training was queued again.");
    } catch (reason) {
      setTrainingActionMessage(reason instanceof Error ? reason.message : "Training retry failed");
    } finally {
      setTrainingAction(null);
    }
  }

  function renderTrainingProgress(jobId: string): ReactNode {
    if (!trainingProgress || trainingProgress.id !== jobId) return null;

    return (
      <div className={`training-progress training-progress-${trainingProgress.status}`} role="status">
        <div>
          <strong>{formatTrainingStatus(trainingProgress.status)}</strong>
          <span>{trainingProgress.progressPercent}%</span>
        </div>
        <progress max={100} value={trainingProgress.progressPercent} />
        <p>{trainingProgress.errorMessage ?? trainingProgress.progressMessage}</p>
        {trainingProgress.status === "succeeded" && trainingProgress.modelVersionId && (
          <button
            className="training-action-button"
            disabled={
              trainingAction !== null ||
              publishedModelVersionId === trainingProgress.modelVersionId
            }
            onClick={() => void publishTrainingModel(trainingProgress.modelVersionId!)}
            type="button"
          >
            {trainingAction === "publishing"
              ? "Publishing..."
              : publishedModelVersionId === trainingProgress.modelVersionId
                ? "Published"
                : "Publish model"}
          </button>
        )}
        {(trainingProgress.status === "failed" || trainingProgress.status === "dead") && (
          <button
            className="training-action-button"
            disabled={trainingAction !== null}
            onClick={() => void retryTrainingJob()}
            type="button"
          >
            {trainingAction === "retrying" ? "Retrying..." : "Retry training"}
          </button>
        )}
        {trainingActionMessage && <p className="training-action-message">{trainingActionMessage}</p>}
      </div>
    );
  }

  async function runSlashCommand(command: SlashCommand) {
    if (!tenant || isBusy || trainingIsActive) return;

    setCommandError(null);
    setInput("");

    try {
      const response = await fetchWithAuthRedirect(`${nucleusUrl}${command.endpoint}`, {
        credentials: "include",
        headers: createTenantHeaders(tenant),
        cache: "no-store",
      });

      if (!response.ok) {
        throw new Error(await readActionError(response, "Command could not be completed"));
      }

      const output = formatSlashCommandOutput(command.toolName, await response.json());
      setMessages((current) => [
        ...current,
        createSlashCommandMessage(command.command),
        createSlashCommandResult(command.toolName, output),
      ]);
    } catch (reason) {
      setCommandError(
        reason instanceof Error ? reason.message : "Command could not be completed",
      );
    }
  }

  return (
    <AppShell activeSection="chat" activeTab="selection" breadcrumb="Conversation">
      <section className="conversation" aria-label="Prediction conversation">
        <div className="conversation-toolbar">
          <span className="conversation-model">
            {llmStatus.state === "available" ? llmStatus.model : ""}
          </span>
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
            messages.map((message, messageIndex) => (
              <article className={`message message-${message.role}`} key={`${message.id}-${messageIndex}`}>
                <div className="message-content">
                  {message.parts.map((part, index) => {
                    if (part.type === "text") {
                      return message.role === "assistant" ? (
                        <Markdown key={index}>{part.text}</Markdown>
                      ) : (
                        <p key={index}>{part.text}</p>
                      );
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
                            {part.toolName !== "list_source_tables" && part.toolName !== "list_prediction_tools" && (
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
                                )}
                              </div>
                            )}
                            {part.state === "output-error" && (
                              <p className="tool-call-error">{part.errorText}</p>
                            )}
                            {part.toolName === "start_model_training" &&
                              part.state === "output-available" &&
                              isQueuedTrainingOutput(part.output) &&
                              renderTrainingProgress(part.output.job.id)}
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
        </div>

        {(error || commandError) && (
          <div className="conversation-error" role="alert">
            <span>{commandError ?? (error ? formatChatError(error) : "")}</span>
            <button onClick={() => window.location.reload()} type="button">Reload</button>
          </div>
        )}

        {visibleSlashCommands.length > 0 && !trainingIsActive && (
          <div className="slash-command-menu" aria-label="Commands">
            {visibleSlashCommands.map((command) => (
              <button
                key={command.command}
                onClick={() => void runSlashCommand(command)}
                type="button"
              >
                <code>{command.command}</code>
                <span>{command.description}</span>
              </button>
            ))}
          </div>
        )}

        <form
          className="composer"
          onSubmit={(event) => {
            event.preventDefault();
            const text = input.trim();

            if (!text || isBusy || trainingIsActive) return;

            const command = slashCommands.find((candidate) =>
              [candidate.command, ...candidate.aliases].some(
                (value) => value === text.toLowerCase(),
              ),
            );

            if (command) {
              void runSlashCommand(command);
              return;
            }

            if (llmStatus.state !== "available") return;

            void sendMessage({ text });
            setInput("");
            window.requestAnimationFrame(() => {
              if (composerInputRef.current) resizeComposer(composerInputRef.current);
            });
          }}
        >
          <label className="sr-only" htmlFor="conversation-input">Message</label>
          <div className="composer-input-wrap">
            {!input && (
              <span className="composer-hint" key={composerHints[composerHintIndex]} aria-hidden="true">
                {composerHints[composerHintIndex]}
              </span>
            )}
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
              placeholder=""
              ref={composerInputRef}
              rows={1}
              disabled={trainingIsActive}
              value={input}
            />
          </div>
          {isBusy ? (
            <button className="composer-stop" onClick={() => stop()} type="button">Stop</button>
          ) : (
            <button
              aria-label="Send message"
              className="composer-send"
            disabled={!input.trim() || trainingIsActive || (!isSlashCommandInput && llmStatus.state !== "available")}
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

function createSlashCommandMessage(command: string): UIMessage {
  return {
    id: crypto.randomUUID(),
    role: "user",
    parts: [{ type: "text", text: command }],
  } as UIMessage;
}

function createSlashCommandResult(toolName: string, output: unknown): UIMessage {
  return {
    id: crypto.randomUUID(),
    role: "assistant",
    parts: [
      {
        type: "dynamic-tool",
        toolCallId: crypto.randomUUID(),
        toolName,
        state: "output-available",
        input: {},
        output,
      },
    ],
  } as UIMessage;
}

function formatSlashCommandOutput(toolName: string, output: unknown): unknown {
  if (toolName !== "list_prediction_tools" || !Array.isArray(output)) {
    return output;
  }

  return (output as GeneratedToolDefinition[]).map((definition) => ({
    toolName: definition.toolName,
    modelVersionId: definition.modelVersionId,
    description: definition.description,
    inputs: Object.entries(definition.inputSchema.properties).map(
      ([name, property]) => ({
        name,
        type: property.type,
        values: property.enum ?? [],
      }),
    ),
  }));
}

function formatToolPayload(value: unknown): string {
  if (value === undefined) return "Waiting for input";

  return JSON.stringify(value, null, 2);
}

function renderToolOutput(
  toolName: string,
  output: unknown,
): ReactNode {
  if (toolName === "list_source_tables" && isSourceTableResult(output)) {
    if (output.tables.length === 0) {
      return <p className="tool-result-empty">No source tables are available.</p>;
    }

    return (
      <PaginatedToolResultList
        emptyLabel="No source tables are available."
        items={output.tables}
        itemKey={(table) => table.name}
        renderDetails={(table) => <SourceTableDetails table={table} />}
        renderSummary={(table) => (
          <>
            <strong>{table.name}</strong>
            <span>{table.rowCount.toLocaleString()} rows · {table.columns.length} columns</span>
          </>
        )}
      />
    );
  }

  if (toolName === "list_prediction_tools" && isPredictionToolResult(output)) {
    return (
      <PaginatedToolResultList
        emptyLabel="No published prediction tools are available."
        items={output}
        itemKey={(tool) => tool.modelVersionId}
        renderDetails={(tool) => <PredictionToolDetails tool={tool} />}
        renderSummary={(tool) => (
          <>
            <strong>{tool.toolName}</strong>
            <span>{tool.description || `${tool.inputs.length} accepted inputs`} · {tool.inputs.length} inputs</span>
          </>
        )}
      />
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

type PredictionToolResult = {
  toolName: string;
  modelVersionId: string;
  description: string;
  inputs: Array<{
    name: string;
    type: string;
    values: Array<string | number>;
  }>;
};

function isPredictionToolResult(value: unknown): value is PredictionToolResult[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        isPlainObject(item) &&
        typeof item.toolName === "string" &&
        typeof item.modelVersionId === "string" &&
        typeof item.description === "string" &&
        Array.isArray(item.inputs) &&
        item.inputs.every(
          (input) =>
            isPlainObject(input) &&
            typeof input.name === "string" &&
            typeof input.type === "string" &&
            Array.isArray(input.values) &&
            input.values.every(
              (value) => typeof value === "string" || typeof value === "number",
            ),
        ),
    )
  );
}

function PaginatedToolResultList<T>({
  emptyLabel,
  items,
  itemKey,
  renderDetails,
  renderSummary,
}: {
  emptyLabel: string;
  items: T[];
  itemKey: (item: T) => string;
  renderDetails: (item: T) => ReactNode;
  renderSummary: (item: T) => ReactNode;
}): ReactNode {
  const pageSize = 5;
  const [page, setPage] = useState(0);
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const activePage = Math.min(page, totalPages - 1);
  const visibleItems = items.slice(activePage * pageSize, (activePage + 1) * pageSize);

  if (items.length === 0) {
    return <p className="tool-result-empty">{emptyLabel}</p>;
  }

  return (
    <div className="tool-result-list">
      {visibleItems.map((item) => (
        <details className="tool-result-item" key={itemKey(item)}>
          <summary>{renderSummary(item)}</summary>
          <div className="tool-result-details">{renderDetails(item)}</div>
        </details>
      ))}
      {totalPages > 1 && (
        <nav className="tool-result-pagination" aria-label="Result pages">
          <button disabled={activePage === 0} onClick={() => setPage(activePage - 1)} type="button">Previous</button>
          <span>Page {activePage + 1} of {totalPages}</span>
          <button disabled={activePage === totalPages - 1} onClick={() => setPage(activePage + 1)} type="button">Next</button>
        </nav>
      )}
    </div>
  );
}

function SourceTableDetails({ table }: { table: SourceTable }): ReactNode {
  return (
    <table className="tool-result-table">
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
  );
}

function PredictionToolDetails({ tool }: { tool: PredictionToolResult }): ReactNode {
  return (
    <div className="prediction-tool-details">
      <p>{tool.description || "No description is available."}</p>
      <div>
        <span>Accepted inputs</span>
        <dl>
          {tool.inputs.map((input) => (
            <div key={input.name}>
              <dt><code>{input.name}</code></dt>
              <dd>{formatPredictionInput(input)}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}

function formatPredictionInput(input: PredictionToolResult["inputs"][number]): string {
  if (input.values.length > 0) {
    return `(${input.values.join(", ")})`;
  }

  return input.type;
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
  datasetDefinitionId: string;
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

      return {
        ...part.output.job,
        datasetDefinitionId: part.output.dataset.id,
      };
    }
  }

  return null;
}

function isQueuedTrainingOutput(value: unknown): value is {
  outcome: "queued";
  dataset: { id: string };
  job: {
    id: string;
    status: TrainingProgress["status"];
    progressPercent: number;
    progressMessage: string | null;
  };
} {
  if (
    !isPlainObject(value) ||
    value.outcome !== "queued" ||
    !isPlainObject(value.dataset) ||
    !isPlainObject(value.job)
  ) {
    return false;
  }

  return (
    typeof value.job.id === "string" &&
    typeof value.dataset.id === "string" &&
    typeof value.job.status === "string" &&
    typeof value.job.progressPercent === "number" &&
    (typeof value.job.progressMessage === "string" || value.job.progressMessage === null)
  );
}

function hasSameTrainingProgress(
  current: TrainingProgress | null,
  next: TrainingProgress,
): boolean {
  return current !== null &&
    current.id === next.id &&
    current.modelVersionId === next.modelVersionId &&
    current.status === next.status &&
    current.progressPercent === next.progressPercent &&
    current.progressMessage === next.progressMessage &&
    current.errorCode === next.errorCode &&
    current.errorMessage === next.errorMessage;
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

    return Array.isArray(messages)
      ? deduplicateCachedMessages(messages as UIMessage[])
      : null;
  } catch {
    return null;
  }
}

function deduplicateCachedMessages(messages: UIMessage[]): UIMessage[] {
  const seenMessageIds = new Set<string>();

  return messages.filter((message) => {
    if (seenMessageIds.has(message.id)) return false;

    seenMessageIds.add(message.id);
    return true;
  });
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

async function readActionError(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: string }; message?: string };
    return body.error?.message ?? body.message ?? fallback;
  } catch {
    return fallback;
  }
}

function resizeComposer(textarea: HTMLTextAreaElement): void {
  textarea.style.height = "auto";
  textarea.style.height = `${Math.min(textarea.scrollHeight, composerMaxHeight)}px`;
  textarea.style.overflowY =
    textarea.scrollHeight > composerMaxHeight ? "auto" : "hidden";
}
