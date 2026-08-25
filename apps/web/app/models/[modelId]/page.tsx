"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import type { ModelVersionStatus } from "@ampersand/contracts";

import { getSelectedTenant } from "../../auth/client";
import { AppShell } from "../../components/app-shell";
import {
  fetchModelRegistry,
  formatDate,
  getModelDefinitions,
  modelName,
  modelSlug,
  updateModelVersionStatus,
  type RegistryModelVersion,
} from "../../model-data";

type RegistryFilter = "all" | ModelVersionStatus;
type PendingAction = {
  action: "publish" | "retire";
  id: string;
  versionNumber: number;
};

const filters: RegistryFilter[] = ["all", "candidate", "published", "retired"];

export default function ModelControlsPage() {
  const { modelId } = useParams<{ modelId: string }>();
  const [models, setModels] = useState<RegistryModelVersion[]>([]);
  const [filter, setFilter] = useState<RegistryFilter>("all");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [isUpdating, setIsUpdating] = useState(false);

  useEffect(() => {
    const tenant = getSelectedTenant();
    if (!tenant) return;

    void fetchModelRegistry(tenant)
      .then(setModels)
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : "Could not load models");
      });
  }, []);

  const definition = useMemo(
    () => getModelDefinitions(models).find((model) => model.slug === modelId),
    [modelId, models],
  );
  const modelNameForPage = definition?.name ?? "Model controls";
  const visibleModels = useMemo(
    () =>
      models.filter(
        (model) =>
          modelSlug(modelName(model)) === modelId &&
          (filter === "all" || model.status === filter),
      ),
    [filter, modelId, models],
  );

  async function confirmStatusChange(): Promise<void> {
    if (!pendingAction) return;
    const tenant = getSelectedTenant();
    if (!tenant) {
      setError("Select a workspace before changing model status.");
      return;
    }

    setIsUpdating(true);
    setError(null);

    try {
      await updateModelVersionStatus(
        tenant,
        pendingAction.id,
        pendingAction.action,
      );
      const refreshed = await fetchModelRegistry(tenant);
      setModels(refreshed);
      setNotice(
        pendingAction.action === "publish"
          ? "Model version published."
          : "Model version retired.",
      );
      setPendingAction(null);
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : "Model update failed");
    } finally {
      setIsUpdating(false);
    }
  }

  return (
    <AppShell
      activeTab="controls"
      breadcrumb={`Models / ${modelNameForPage}`}
      controlsHref={`/models/${modelId}`}
    >
      <section className="registry selection-registry" aria-labelledby="model-title">
        <div className="registry-toolbar">
          <h2 id="model-title">{modelNameForPage}</h2>
          <div className="filters" aria-label="Filter model versions">
            {filters.map((item) => (
              <button
                className={filter === item ? "selected" : ""}
                key={item}
                onClick={() => setFilter(item)}
                type="button"
              >
                {item}
              </button>
            ))}
          </div>
        </div>
        {error && <p className="inline-error" role="alert">{error}</p>}
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
              {!error && models.length > 0 && visibleModels.length === 0 && (
                <tr><td colSpan={7}>No versions match this filter.</td></tr>
              )}
              {!error && models.length === 0 && (
                <tr><td colSpan={7}>Loading model versions...</td></tr>
              )}
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
                ? "This updates the model version in the tenant registry."
                : "This removes the model version from published discovery."}
            </p>
            <div className="dialog-actions">
              <button className="dialog-cancel" disabled={isUpdating} onClick={() => setPendingAction(null)} type="button">Cancel</button>
              <button className="dialog-confirm" disabled={isUpdating} onClick={() => void confirmStatusChange()} type="button">
                {isUpdating ? "Saving..." : pendingAction.action === "publish" ? "Publish" : "Retire"}
              </button>
            </div>
          </div>
        </div>
      )}
      {notice && <div className="notice" role="status"><span>{notice}</span><button onClick={() => setNotice(null)} type="button" aria-label="Dismiss notification">Close</button></div>}
    </AppShell>
  );
}
