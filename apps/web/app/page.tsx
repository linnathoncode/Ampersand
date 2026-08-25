"use client";

import { useEffect, useState } from "react";

import { AppShell } from "./components/app-shell";
import { getSelectedTenant } from "./auth/client";
import {
  fetchModelRegistry,
  formatDate,
  getModelDefinitions,
  type RegistryModelVersion,
} from "./model-data";

export default function ModelSelectionPage() {
  const [models, setModels] = useState<RegistryModelVersion[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const tenant = getSelectedTenant();
    if (!tenant) return;

    void fetchModelRegistry(tenant)
      .then(setModels)
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : "Could not load models");
      })
      .finally(() => setIsLoading(false));
  }, []);

  const modelDefinitions = getModelDefinitions(models);

  return (
    <AppShell
      activeTab="selection"
      breadcrumb="Workspace / Models"
      controlsHref={modelDefinitions[0] ? `/models/${modelDefinitions[0].slug}` : undefined}
    >
      <section className="registry selection-registry" aria-label="Models">
        {error && <p className="inline-error" role="alert">{error}</p>}
        <div className="table-wrap">
          <table className="model-table">
            <thead>
              <tr><th>Model</th><th>Prediction target</th><th>Latest status</th><th>Available tools</th><th>Last trained</th><th><span className="sr-only">Open model</span></th></tr>
            </thead>
            <tbody>
              {modelDefinitions.map((model) => (
                <tr key={model.slug}>
                  <td><a className="model-link" href={`/models/${model.slug}`}>{model.name}</a></td>
                  <td><code>{model.target}</code></td>
                  <td><span className={`status status-${model.latestStatus}`}>{model.latestStatus}</span></td>
                  <td>{model.availableTools}</td>
                  <td>{formatDate(model.lastTrainedAt)}</td>
                  <td className="open-model"><a href={`/models/${model.slug}`} aria-label={`Open ${model.name}`}>View <span aria-hidden="true">→</span></a></td>
                </tr>
              ))}
              {!error && modelDefinitions.length === 0 && (
                <tr><td colSpan={6}>{isLoading ? "Loading model versions..." : "No model versions are available."}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </AppShell>
  );
}
