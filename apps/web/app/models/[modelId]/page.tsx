"use client";

import { useMemo, useState } from "react";
import { useParams } from "next/navigation";
import type { ModelVersionStatus } from "@ampersand/contracts";

import { AppShell } from "../../components/app-shell";
import { formatDate, modelDefinitions, sampleModelVersions } from "../../model-data";

type RegistryFilter = "all" | ModelVersionStatus;
type PendingAction = {
  action: "publish" | "retire";
  id: string;
  versionNumber: number;
};

const filters: RegistryFilter[] = ["all", "candidate", "published", "retired"];

export default function ModelControlsPage() {
  const { modelId } = useParams<{ modelId: string }>();
  const definition = modelDefinitions.find((model) => model.slug === modelId) ?? modelDefinitions[0];
  const [models, setModels] = useState(sampleModelVersions);
  const [filter, setFilter] = useState<RegistryFilter>("all");
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const visibleModels = useMemo(() => models.filter((model) => filter === "all" || model.status === filter), [filter, models]);

  function updateStatus(id: string, status: "published" | "retired") {
    const now = new Date().toISOString();
    setModels((current) => current.map((model) => model.id === id ? {
      ...model,
      status,
      toolAvailability: status === "published" ? "available" : "unavailable",
      publishedAt: status === "published" ? now : model.publishedAt,
      retiredAt: status === "retired" ? now : model.retiredAt,
    } : model));
    setNotice(status === "published" ? "Model published and prediction tool made available." : "Model retired and prediction tool made unavailable.");
    setPendingAction(null);
  }

  return (
    <AppShell activeTab="controls" breadcrumb={`Models / ${definition.name}`} controlsHref={`/models/${definition.slug}`}>
      <section className="registry selection-registry" aria-labelledby="model-title">
        <div className="registry-toolbar">
          <h2 id="model-title">{definition.name}</h2>
          <div className="filters" aria-label="Filter model versions">
            {filters.map((item) => <button className={filter === item ? "selected" : ""} key={item} onClick={() => setFilter(item)} type="button">{item}</button>)}
          </div>
        </div>
        <div className="table-wrap">
          <table className="version-table">
            <thead><tr><th>Version</th><th>Status</th><th>Model ID</th><th>Prediction tool</th><th>Created</th><th>Published</th><th><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {visibleModels.map((model) => (
                <tr key={model.id}>
                  <td className="version">v{model.versionNumber}</td>
                  <td><span className={`status status-${model.status}`}>{model.status}</span></td>
                  <td><code>{model.id.slice(0, 8)}</code></td>
                  <td className="tool-availability">{model.toolAvailability.replace("-", " ")}</td>
                  <td>{formatDate(model.createdAt)}</td>
                  <td>{formatDate(model.publishedAt)}</td>
                  <td className="row-action">
                    {model.status === "candidate" && <button onClick={() => setPendingAction({ action: "publish", id: model.id, versionNumber: model.versionNumber })} type="button">Publish</button>}
                    {model.status === "published" && <button className="quiet-action" onClick={() => setPendingAction({ action: "retire", id: model.id, versionNumber: model.versionNumber })} type="button">Retire</button>}
                    {model.status === "retired" && <span className="unavailable">Unavailable</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      {pendingAction && (
        <div className="dialog-backdrop" role="presentation">
          <div aria-labelledby="confirmation-title" aria-modal="true" className="confirmation-dialog" role="dialog">
            <h2 id="confirmation-title">{pendingAction.action === "publish" ? "Publish" : "Retire"} v{pendingAction.versionNumber}?</h2>
            <p>
              {pendingAction.action === "publish"
                ? "This publishes the model and creates its prediction tool."
                : "This removes the prediction tool from discovery and blocks new calls."}
            </p>
            <div className="dialog-actions">
              <button className="dialog-cancel" onClick={() => setPendingAction(null)} type="button">Cancel</button>
              <button className="dialog-confirm" onClick={() => updateStatus(pendingAction.id, pendingAction.action === "publish" ? "published" : "retired")} type="button">
                {pendingAction.action === "publish" ? "Publish" : "Retire"}
              </button>
            </div>
          </div>
        </div>
      )}
      {notice && <div className="notice" role="status"><span>{notice}</span><button onClick={() => setNotice(null)} type="button" aria-label="Dismiss notification">Close</button></div>}
    </AppShell>
  );
}
