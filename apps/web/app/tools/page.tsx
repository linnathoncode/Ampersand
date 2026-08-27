"use client";

import { useEffect, useState } from "react";
import type { GeneratedToolDefinition, ModelRegistryResponse } from "@ampersand/contracts";

import { AppShell } from "../components/app-shell";
import { createTenantHeaders, fetchWithAuthRedirect, getSelectedTenant, nucleusUrl } from "../auth/client";

type ListedTool = GeneratedToolDefinition & { modelName: string; modelVersion: number; createdAt: string };

export default function PredictionToolsPage() {
  const [tools, setTools] = useState<ListedTool[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const tenant = getSelectedTenant();
    if (!tenant) { window.location.assign("/login"); return; }
    const headers = createTenantHeaders(tenant);
    void Promise.all([
      fetchWithAuthRedirect(`${nucleusUrl}/tools`, { credentials: "include", headers, cache: "no-store" }),
      fetchWithAuthRedirect(`${nucleusUrl}/model-versions`, { credentials: "include", headers, cache: "no-store" }),
    ]).then(async ([toolsResponse, modelsResponse]) => {
      if (!toolsResponse.ok || !modelsResponse.ok) throw new Error("Prediction tools could not be loaded");
      const definitions = (await toolsResponse.json()) as GeneratedToolDefinition[];
      const registry = (await modelsResponse.json()) as ModelRegistryResponse;
      const models = new Map(registry.models.map((model) => [model.id, model]));
      setTools(definitions.map((tool) => {
        const model = models.get(tool.modelVersionId);
        return { ...tool, modelName: model?.datasetName ?? "Unknown model", modelVersion: model?.versionNumber ?? 0, createdAt: model?.createdAt ?? new Date().toISOString() };
      }));
    }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Prediction tools could not be loaded"));
  }, []);

  return (
    <AppShell activeSection="tools" activeTab="selection" breadcrumb="Workspace / Prediction tools">
      <section className="registry selection-registry" aria-label="Prediction tools">
        {error ? <p className="error-state" role="alert">{error}</p> : tools.length === 0 ? <p className="empty-state">No published prediction tools are available.</p> : (
          <div className="table-wrap"><table className="tool-table"><thead><tr><th>Tool</th><th>Model</th><th>Version</th><th>Inputs</th><th>Generated</th><th><span className="sr-only">Open tool</span></th></tr></thead><tbody>
            {tools.map((tool) => <tr key={tool.modelVersionId}><td><a className="model-link tool-name" href={`/tools/${toolSlug(tool.toolName)}`}>{tool.toolName}</a></td><td>{tool.modelName}</td><td>v{tool.modelVersion}</td><td>{Object.keys(tool.inputSchema.properties).length}</td><td>{formatToolDate(tool.createdAt)}</td><td className="open-model"><a href={`/tools/${toolSlug(tool.toolName)}`}>View <span aria-hidden="true">→</span></a></td></tr>)}
          </tbody></table></div>
        )}
      </section>
    </AppShell>
  );
}

function toolSlug(name: string): string { return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); }
function formatToolDate(value: string): string { return new Intl.DateTimeFormat("en", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value)); }
