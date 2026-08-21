import { AppShell } from "../components/app-shell";
import { formatToolDate, predictionTools } from "../tool-data";

export default function PredictionToolsPage() {
  return (
    <AppShell activeSection="tools" activeTab="selection" breadcrumb="Workspace / Prediction tools">
      <section className="registry selection-registry" aria-label="Prediction tools">
        <div className="table-wrap">
          <table className="tool-table">
            <thead>
              <tr><th>Tool</th><th>Model</th><th>Version</th><th>Inputs</th><th>Generated</th><th><span className="sr-only">Open tool</span></th></tr>
            </thead>
            <tbody>
              {predictionTools.map((tool) => (
                <tr key={tool.slug}>
                  <td><a className="model-link tool-name" href={`/tools/${tool.slug}`}>{tool.name}</a></td>
                  <td>{tool.modelName}</td>
                  <td>v{tool.modelVersion}</td>
                  <td>{tool.properties.length}</td>
                  <td>{formatToolDate(tool.generatedAt)}</td>
                  <td className="open-model"><a href={`/tools/${tool.slug}`}>View <span aria-hidden="true">→</span></a></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </AppShell>
  );
}
