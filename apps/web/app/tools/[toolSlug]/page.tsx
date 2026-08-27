"use client";

import { useEffect, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import type { GeneratedToolDefinition, ModelRegistryResponse } from "@ampersand/contracts";

import { AppShell } from "../../components/app-shell";
import { createTenantHeaders, fetchWithAuthRedirect, getSelectedTenant, nucleusUrl } from "../../auth/client";

type ToolDetails = GeneratedToolDefinition & { modelName: string; modelVersion: number; createdAt: string };

export default function ToolPage() {
  const params = useParams<{ toolSlug: string }>();
  const searchParams = useSearchParams();
  const [tool, setTool] = useState<ToolDetails | null>(null);
  const [error, setError] = useState<string | null>(null);
  const activeView = searchParams.get("view") === "activity" ? "activity" : "schema";

  useEffect(() => {
    const tenant = getSelectedTenant();
    if (!tenant) { window.location.assign("/login"); return; }
    const headers = createTenantHeaders(tenant);
    void Promise.all([
      fetchWithAuthRedirect(`${nucleusUrl}/tools`, { credentials: "include", headers, cache: "no-store" }),
      fetchWithAuthRedirect(`${nucleusUrl}/model-versions`, { credentials: "include", headers, cache: "no-store" }),
    ]).then(async ([toolsResponse, modelsResponse]) => {
      if (!toolsResponse.ok || !modelsResponse.ok) throw new Error("Prediction tool could not be loaded");
      const definitions = (await toolsResponse.json()) as GeneratedToolDefinition[];
      const registry = (await modelsResponse.json()) as ModelRegistryResponse;
      const definition = definitions.find((candidate) => toolSlug(candidate.toolName) === params.toolSlug);
      if (!definition) throw new Error("Prediction tool was not found");
      const model = registry.models.find((candidate) => candidate.id === definition.modelVersionId);
      setTool({ ...definition, modelName: model?.datasetName ?? "Unknown model", modelVersion: model?.versionNumber ?? 0, createdAt: model?.createdAt ?? "" });
    }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Prediction tool could not be loaded"));
  }, [params.toolSlug]);

  if (error) return <AppShell activeSection="tools" activeTab="selection" breadcrumb="Workspace / Prediction tools"><p className="error-state" role="alert">{error}</p></AppShell>;
  if (!tool) return <AppShell activeSection="tools" activeTab="selection" breadcrumb="Workspace / Prediction tools"><p className="empty-state">Loading tool...</p></AppShell>;

  return (
    <AppShell activeSection="tools" activeTab="controls" breadcrumb={`Prediction tools / ${tool.toolName}`} toolHref={`/tools/${toolSlug(tool.toolName)}`} toolName={tool.toolName}>
      <div className="tool-heading"><div><h1>{tool.toolName}</h1><p>{tool.description}</p></div><div className="tool-model-reference"><span>{tool.modelName}</span><span>v{tool.modelVersion}</span></div></div>
      <nav className="detail-tabs" aria-label="Tool details"><a className={activeView === "schema" ? "active" : ""} href={`/tools/${toolSlug(tool.toolName)}`}>Schema</a><a className={activeView === "activity" ? "active" : ""} href={`/tools/${toolSlug(tool.toolName)}?view=activity`}>Activity</a></nav>
      {activeView === "schema" ? <section className="tool-detail" aria-label="Tool schema"><div className="detail-section-heading"><h2>Inputs</h2><span>{Object.keys(tool.inputSchema.properties).length} fields</span></div><div className="table-wrap"><table className="schema-table"><thead><tr><th>Name</th><th>Type</th><th>Description</th><th>Constraint</th><th>Required</th></tr></thead><tbody>{Object.entries(tool.inputSchema.properties).map(([name, property]) => <tr key={name}><td><code>{name}</code></td><td>{property.type}</td><td>{property.description}</td><td>{formatConstraint(property)}</td><td>{tool.inputSchema.required.includes(name) ? "Yes" : "No"}</td></tr>)}</tbody><tfoot><tr className="output-schema-row"><td>Output</td><td><code>number</code></td><td colSpan={3}>Prediction value with uncertainty and warnings</td></tr></tfoot></table></div></section> : <section className="tool-detail" aria-label="Inference audit history"><div className="detail-section-heading"><h2>Audit history</h2></div><p className="empty-state">No prediction calls have been recorded.</p></section>}
    </AppShell>
  );
}

function toolSlug(name: string): string { return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); }
function formatConstraint(property: GeneratedToolDefinition["inputSchema"]["properties"][string]): string { if (property.enum) return property.enum.join(", "); if (property.minimum !== undefined || property.maximum !== undefined) return `${property.minimum ?? "-∞"} to ${property.maximum ?? "∞"}`; return property.type === "boolean" ? "true or false" : "Any valid value"; }
