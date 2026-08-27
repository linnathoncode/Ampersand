"use client";

import { useEffect, useMemo, useState } from "react";

import { AppShell } from "../components/app-shell";
import {
  fetchModelRegistry,
  formatDate,
  getModelDefinitions,
  type RegistryModelVersion,
} from "../model-data";
import { getSelectedTenant } from "../auth/client";

export default function OverviewPage() {
  const [models, setModels] = useState<RegistryModelVersion[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const tenant = getSelectedTenant();

    if (!tenant) {
      window.location.assign("/login");
      return;
    }

    void fetchModelRegistry(tenant)
      .then(setModels)
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : "Could not load workspace activity");
      })
      .finally(() => setIsLoading(false));
  }, []);

  const definitions = useMemo(() => getModelDefinitions(models), [models]);
  const trainedModelCount = definitions.length;
  const publishedModelCount = models.filter((model) => model.status === "published").length;
  const predictionToolCount = models.filter((model) => model.toolAvailability === "available").length;
  const latestModels = [...definitions]
    .sort((left, right) => Date.parse(right.lastTrainedAt) - Date.parse(left.lastTrainedAt))
    .slice(0, 5);

  return (
    <AppShell activeSection="overview" activeTab="selection" breadcrumb="Workspace / Overview">
      <section className="overview" aria-label="Workspace overview">
        <header className="overview-heading">
          <p>Workspace activity</p>
          <h1>Models and prediction tools</h1>
        </header>

        {error && <p className="inline-error" role="alert">{error}</p>}

        <dl className="overview-stats" aria-label="Workspace counts">
          <div>
            <dt>Trained models</dt>
            <dd>{isLoading ? "—" : trainedModelCount}</dd>
          </div>
          <div>
            <dt>Published versions</dt>
            <dd>{isLoading ? "—" : publishedModelCount}</dd>
          </div>
          <div>
            <dt>Prediction tools</dt>
            <dd>{isLoading ? "—" : predictionToolCount}</dd>
          </div>
        </dl>

        <section className="overview-models" aria-labelledby="recent-models-title">
          <div className="overview-section-heading">
            <h2 id="recent-models-title">Recent models</h2>
            <a href="/">Open model controls <span aria-hidden="true">→</span></a>
          </div>
          <div className="table-wrap">
            <table className="model-table">
              <thead>
                <tr>
                  <th>Model</th>
                  <th>Prediction target</th>
                  <th>Status</th>
                  <th>Tools</th>
                  <th>Last trained</th>
                </tr>
              </thead>
              <tbody>
                {latestModels.map((model) => (
                  <tr key={model.slug}>
                    <td><a className="model-link" href={`/models/${model.slug}`}>{model.name}</a></td>
                    <td><code>{model.target}</code></td>
                    <td><span className={`status status-${model.latestStatus}`}>{model.latestStatus}</span></td>
                    <td>{model.availableTools}</td>
                    <td>{formatDate(model.lastTrainedAt)}</td>
                  </tr>
                ))}
                {!error && latestModels.length === 0 && (
                  <tr>
                    <td colSpan={5}>{isLoading ? "Loading workspace activity..." : "No trained models yet."}</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      </section>
    </AppShell>
  );
}
