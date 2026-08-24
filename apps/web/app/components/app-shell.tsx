"use client";

import { useEffect, useState } from "react";
import type { ReactNode } from "react";

type AppShellProps = {
  activeTab: "selection" | "controls";
  activeSection?: "chat" | "models" | "tools";
  breadcrumb: string;
  children: ReactNode;
  controlsHref?: string;
  toolHref?: string;
  toolName?: string;
};

const LAST_MODEL_CONTROLS_KEY = "ampersand:last-model-controls";
const LAST_TOOL_KEY = "ampersand:last-tool";

export function AppShell({ activeTab, activeSection = "models", breadcrumb, children, controlsHref, toolHref, toolName }: AppShellProps) {
  const [lastControlsHref, setLastControlsHref] = useState<string | undefined>(controlsHref);
  const [lastTool, setLastTool] = useState<{ href: string; name: string } | undefined>(
    toolHref && toolName ? { href: toolHref, name: toolName } : undefined,
  );

  useEffect(() => {
    if (controlsHref) {
      localStorage.setItem(LAST_MODEL_CONTROLS_KEY, controlsHref);
      setLastControlsHref(controlsHref);
      return;
    }

    setLastControlsHref(localStorage.getItem(LAST_MODEL_CONTROLS_KEY) ?? undefined);
  }, [controlsHref]);

  useEffect(() => {
    if (toolHref && toolName) {
      const tool = { href: toolHref, name: toolName };
      localStorage.setItem(LAST_TOOL_KEY, JSON.stringify(tool));
      setLastTool(tool);
      return;
    }

    const storedTool = localStorage.getItem(LAST_TOOL_KEY);

    if (!storedTool) return;

    try {
      const parsed = JSON.parse(storedTool) as { href?: unknown; name?: unknown };

      if (typeof parsed.href === "string" && typeof parsed.name === "string") {
        setLastTool({ href: parsed.href, name: parsed.name });
      }
    } catch {
      localStorage.removeItem(LAST_TOOL_KEY);
    }
  }, [toolHref, toolName]);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="/" aria-label="ampersand home">
          <span className="brand-mark">&amp;</span>
          <span className="brand-name">ampersand</span>
        </a>
        <nav className="primary-nav" aria-label="Primary navigation">
          <a href="#">Overview</a>
          <a className={activeSection === "chat" ? "active" : ""} href="/chat">Conversation</a>
          <a className={activeSection === "models" ? "active" : ""} href="/">Model controls</a>
          <a href="#">Datasets</a>
          <a className={activeSection === "tools" ? "active" : ""} href="/tools">Prediction tools</a>
        </nav>
        <div className="sidebar-foot">Development tenant</div>
      </aside>
      <main className="content">
        <header className="topbar">
          <div className="breadcrumb">{breadcrumb}</div>
          <button className="account" type="button" aria-label="Open account menu">
            <span>FG</span>
            Furkan
          </button>
        </header>
        {activeSection === "models" && (
          <nav className="section-tabs" aria-label="Model navigation">
            <a className={activeTab === "selection" ? "active" : ""} href="/">Model selection</a>
            {lastControlsHref ? (
              <a className={activeTab === "controls" ? "active" : ""} href={lastControlsHref}>Model controls</a>
            ) : (
              <span aria-disabled="true">Model controls</span>
            )}
          </nav>
        )}
        {activeSection === "tools" && (
          <nav className="section-tabs" aria-label="Prediction tool navigation">
            <a className={activeTab === "selection" ? "active" : ""} href="/tools">Tools</a>
            {lastTool ? (
              <a className={activeTab === "controls" ? "active" : ""} href={lastTool.href}>{lastTool.name}</a>
            ) : (
              <span aria-disabled="true">Tool</span>
            )}
          </nav>
        )}
        {children}
      </main>
    </div>
  );
}
