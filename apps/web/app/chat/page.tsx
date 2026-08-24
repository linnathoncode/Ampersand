"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { useEffect, useMemo, useRef, useState } from "react";

import { AppShell } from "../components/app-shell";

const nucleusUrl = process.env.NEXT_PUBLIC_NUCLEUS_URL ?? "http://localhost:4000";
const conversationCacheKey = "ampersand:chat:ampersand-dev";
const timestampCacheKey = "ampersand:chat-timestamps:ampersand-dev";
const composerMaxHeight = 144;

export default function ChatPage() {
  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: `${nucleusUrl}/chat`,
        credentials: "include",
        headers: {
          "x-service-id": "ampersand-web",
          "x-tenant-id": "ampersand-dev",
        },
      }),
    [],
  );
  const { error, messages, sendMessage, setMessages, status, stop } = useChat({ transport });
  const [input, setInput] = useState("");
  const [hasRestoredConversation, setHasRestoredConversation] = useState(false);
  const [messageTimestamps, setMessageTimestamps] = useState<Record<string, string>>({});
  const composerInputRef = useRef<HTMLTextAreaElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const isBusy = status === "submitted" || status === "streaming";
  const activeToolName = findActiveToolName(messages);

  useEffect(() => {
    const cachedMessages = readCachedMessages(
      window.sessionStorage.getItem(conversationCacheKey),
    );

    if (cachedMessages) setMessages(cachedMessages);
    setMessageTimestamps(readCachedTimestamps());
    setHasRestoredConversation(true);
  }, [setMessages]);

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
  }, [hasRestoredConversation, messages]);

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

  return (
    <AppShell activeSection="chat" activeTab="selection" breadcrumb="Conversation">
      <section className="conversation" aria-label="Prediction conversation">
        <div className="conversation-toolbar">
          <button
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
          {messages.length === 0 ? (
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
                            <div className="tool-call-section">
                              <span>Input</span>
                              <pre>{formatToolPayload(part.input)}</pre>
                            </div>
                            {part.state === "output-available" && (
                              <div className="tool-call-section">
                                <span>Result</span>
                                <pre>{formatToolPayload(part.output)}</pre>
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
        </div>

        {error && <p className="conversation-error">{error.message}</p>}

        <form
          className="composer"
          onSubmit={(event) => {
            event.preventDefault();
            const text = input.trim();

            if (!text || isBusy) return;

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
            value={input}
          />
          {isBusy ? (
            <button className="composer-stop" onClick={() => stop()} type="button">Stop</button>
          ) : (
            <button
              aria-label="Send message"
              className="composer-send"
              disabled={!input.trim()}
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

function formatToolName(value: string): string {
  return value.replaceAll("_", " ");
}

function readCachedMessages(value: string | null): UIMessage[] | null {
  if (!value) return null;

  try {
    const messages = JSON.parse(value) as unknown;

    return Array.isArray(messages) ? (messages as UIMessage[]) : null;
  } catch {
    window.sessionStorage.removeItem(conversationCacheKey);
    return null;
  }
}

function readCachedTimestamps(): Record<string, string> {
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

function resizeComposer(textarea: HTMLTextAreaElement): void {
  textarea.style.height = "auto";
  textarea.style.height = `${Math.min(textarea.scrollHeight, composerMaxHeight)}px`;
  textarea.style.overflowY =
    textarea.scrollHeight > composerMaxHeight ? "auto" : "hidden";
}
