"use client";

import { useEffect, useState } from "react";
import type { ReactNode } from "react";

import {
  clearAuthenticatedSession,
  clearLegacyLlmSettings,
  createTenantHeaders,
  fetchWithAuthRedirect,
  getSelectedTenant,
  nucleusUrl,
  synchronizeAuthenticatedUser,
} from "../auth/client";

type AppShellProps = {
  activeTab: "selection" | "controls";
  activeSection?: "overview" | "chat" | "datasets" | "models" | "team" | "tools" | "profile";
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
  const [accountEmail, setAccountEmail] = useState("");
  const [canInviteUsers, setCanInviteUsers] = useState(false);
  const [tenant, setTenant] = useState("");
  const [isAccountMenuOpen, setIsAccountMenuOpen] = useState(false);

  async function signOut(): Promise<void> {
    try {
      if (tenant) {
        await fetch(`${nucleusUrl}/auth/logout`, {
          method: "POST",
          credentials: "include",
          headers: createTenantHeaders(tenant),
        });
      }
    } finally {
      clearAuthenticatedSession();
      window.location.assign("/login");
    }
  }

  useEffect(() => {
    clearLegacyLlmSettings();
    const selectedTenant = getSelectedTenant();

    if (!selectedTenant) {
      window.location.assign("/login");
      return;
    }

    setTenant(selectedTenant);

    void fetchWithAuthRedirect(`${nucleusUrl}/auth/me`, {
      credentials: "include",
      headers: createTenantHeaders(selectedTenant),
    }).then(async (response) => {
      if (!response.ok) {
        window.location.assign("/login");
        return;
      }

      const body = (await response.json()) as {
        data?: {
          user?: { id?: string; email?: string; isGod?: boolean };
          claims?: Array<{ action?: string; path?: string }>;
        };
      };
      if (body.data?.user?.id) {
        synchronizeAuthenticatedUser(body.data.user.id);
      }
      setAccountEmail(body.data?.user?.email ?? "Account");
      setCanInviteUsers(
        body.data?.user?.isGod === true ||
          body.data?.claims?.some(
            (claim) => claim.action === "invite" && claim.path === "users",
          ) === true,
      );
    }).catch(() => window.location.assign("/login"));
  }, []);

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
          <a className={activeSection === "overview" ? "active" : ""} href="/overview">Overview</a>
          <a className={activeSection === "chat" ? "active" : ""} href="/chat">Conversation</a>
          <a className={activeSection === "models" ? "active" : ""} href="/">Model controls</a>
          <a className={activeSection === "datasets" ? "active" : ""} href="/datasets">Datasets</a>
          <a className={activeSection === "tools" ? "active" : ""} href="/tools">Prediction tools</a>
          {canInviteUsers && (
            <a className={activeSection === "team" ? "active" : ""} href="/team">Team</a>
          )}
        </nav>
        <div className="sidebar-foot">{tenant || "Workspace"}</div>
      </aside>
      <main className="content">
        <header className="topbar">
          <div className="breadcrumb">{breadcrumb}</div>
          <div className="account-menu">
            <button
              aria-expanded={isAccountMenuOpen}
              aria-haspopup="menu"
              aria-label="Open account menu"
              className="account"
              onClick={() => setIsAccountMenuOpen((open) => !open)}
              type="button"
            >
              <span>{accountEmail.slice(0, 2).toUpperCase() || "A"}</span>
              {accountEmail || "Account"}
            </button>
            {isAccountMenuOpen && (
              <div className="account-dropdown" role="menu">
                <div className="account-dropdown-email">{accountEmail || "Account"}</div>
                <a href="/profile" role="menuitem">LLM settings</a>
                <button onClick={() => void signOut()} role="menuitem" type="button">
                  Sign out
                </button>
              </div>
            )}
          </div>
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
