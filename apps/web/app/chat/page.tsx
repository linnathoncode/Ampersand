"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useMemo, useState } from "react";

import { AppShell } from "../components/app-shell";

const nucleusUrl = process.env.NEXT_PUBLIC_NUCLEUS_URL ?? "http://localhost:4000";

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
  const { error, messages, sendMessage, status, stop } = useChat({ transport });
  const [input, setInput] = useState("");
  const isBusy = status === "submitted" || status === "streaming";

  return (
    <AppShell activeSection="chat" activeTab="selection" breadcrumb="Conversation">
      <section className="conversation" aria-label="Prediction conversation">
        <div className="conversation-thread" aria-live="polite">
          {messages.length === 0 ? (
            <div className="conversation-empty">
              <span className="conversation-mark">&amp;</span>
              <p>Ask for a prediction using one of your published models.</p>
            </div>
          ) : (
            messages.map((message) => (
              <article className={`message message-${message.role}`} key={message.id}>
                <div className="message-role">{message.role === "user" ? "You" : "Ampersand"}</div>
                <div className="message-content">
                  {message.parts.map((part, index) => {
                    if (part.type === "text") {
                      return <p key={index}>{part.text}</p>;
                    }

                    if (part.type === "dynamic-tool") {
                      return (
                        <div className="tool-call" key={index}>
                          <span>{part.toolName}</span>
                          <span>{formatToolState(part.state)}</span>
                        </div>
                      );
                    }

                    return null;
                  })}
                </div>
              </article>
            ))
          )}
          {status === "submitted" && <div className="conversation-status">Thinking</div>}
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
          }}
        >
          <label className="sr-only" htmlFor="conversation-input">Message</label>
          <textarea
            id="conversation-input"
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
            placeholder="Ask Ampersand"
            rows={2}
            value={input}
          />
          {isBusy ? (
            <button className="composer-stop" onClick={() => stop()} type="button">Stop</button>
          ) : (
            <button disabled={!input.trim()} type="submit">Send</button>
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
