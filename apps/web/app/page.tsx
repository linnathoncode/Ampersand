import { AppShell } from "./components/app-shell";
import { formatDate, modelDefinitions } from "./model-data";

export default function ModelSelectionPage() {
  return (
    <AppShell activeTab="selection" breadcrumb="Workspace / Models">
      <section className="registry selection-registry" aria-label="Models">
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
            </tbody>
          </table>
        </div>
      </section>
    </AppShell>
  );
}
