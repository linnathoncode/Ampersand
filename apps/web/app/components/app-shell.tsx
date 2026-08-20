"use client";

import { useEffect, useState } from "react";
import type { ReactNode } from "react";

type AppShellProps = {
  activeTab: "selection" | "controls";
  breadcrumb: string;
  children: ReactNode;
  controlsHref?: string;
};

const LAST_MODEL_CONTROLS_KEY = "ampersand:last-model-controls";

export function AppShell({ activeTab, breadcrumb, children, controlsHref }: AppShellProps) {
  const [lastControlsHref, setLastControlsHref] = useState<string | undefined>(controlsHref);

  useEffect(() => {
    if (controlsHref) {
      localStorage.setItem(LAST_MODEL_CONTROLS_KEY, controlsHref);
      setLastControlsHref(controlsHref);
      return;
    }

    setLastControlsHref(localStorage.getItem(LAST_MODEL_CONTROLS_KEY) ?? undefined);
  }, [controlsHref]);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="/" aria-label="Ampersand home">
          <span className="brand-mark">&amp;</span>
          <span className="brand-name">ampersand</span>
        </a>
        <nav className="primary-nav" aria-label="Primary navigation">
          <a href="#">Overview</a>
          <a className="active" href="/">Model controls</a>
          <a href="#">Datasets</a>
          <a href="#">Prediction tools</a>
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
        <nav className="section-tabs" aria-label="Model navigation">
          <a className={activeTab === "selection" ? "active" : ""} href="/">Model selection</a>
          {lastControlsHref ? (
            <a className={activeTab === "controls" ? "active" : ""} href={lastControlsHref}>Model controls</a>
          ) : (
            <span aria-disabled="true">Model controls</span>
          )}
        </nav>
        {children}
      </main>
    </div>
  );
}
