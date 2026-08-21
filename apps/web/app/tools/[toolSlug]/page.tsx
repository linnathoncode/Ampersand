import { notFound } from "next/navigation";

import { AppShell } from "../../components/app-shell";
import { findPredictionTool, formatToolDate } from "../../tool-data";

type ToolPageProps = {
  params: Promise<{ toolSlug: string }>;
  searchParams: Promise<{ view?: string }>;
};

export default async function ToolPage({ params, searchParams }: ToolPageProps) {
  const { toolSlug } = await params;
  const { view } = await searchParams;
  const tool = findPredictionTool(toolSlug);

  if (!tool) notFound();

  const activeView = view === "activity" ? "activity" : "schema";

  return (
    <AppShell
      activeSection="tools"
      activeTab="controls"
      breadcrumb={`Prediction tools / ${tool.name}`}
      toolHref={`/tools/${tool.slug}`}
      toolName={tool.name}
    >
      <div className="tool-heading">
        <div>
          <h1>{tool.name}</h1>
          <p>{tool.description}</p>
        </div>
        <div className="tool-model-reference">
          <span>{tool.modelName}</span>
          <span>v{tool.modelVersion}</span>
        </div>
      </div>

      <nav className="detail-tabs" aria-label="Tool details">
        <a className={activeView === "schema" ? "active" : ""} href={`/tools/${tool.slug}`}>Schema</a>
        <a className={activeView === "activity" ? "active" : ""} href={`/tools/${tool.slug}?view=activity`}>Activity</a>
      </nav>

      {activeView === "schema" ? (
        <section className="tool-detail" aria-label="Tool schema">
          <div className="detail-section-heading">
            <h2>Inputs</h2>
            <span>{tool.properties.length} fields</span>
          </div>
          <div className="table-wrap">
            <table className="schema-table">
              <thead><tr><th>Name</th><th>Type</th><th>Description</th><th>Constraint</th><th>Required</th></tr></thead>
              <tbody>
                {tool.properties.map((property) => (
                  <tr key={property.name}>
                    <td><code>{property.name}</code></td>
                    <td>{property.type}</td>
                    <td>{property.description}</td>
                    <td>{property.constraint}</td>
                    <td>{property.required ? "Yes" : "No"}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="output-schema-row">
                  <td>Output</td>
                  <td><code>{tool.outputType}</code></td>
                  <td colSpan={3}></td>
                </tr>
              </tfoot>
            </table>
          </div>
        </section>
      ) : (
        <section className="tool-detail" aria-label="Inference audit history">
          <div className="detail-section-heading"><h2>Audit history</h2><span>{tool.calls.length} calls</span></div>
          {tool.calls.length === 0 ? <p className="empty-state">No prediction calls have been recorded.</p> : (
            <div className="audit-list">
              {tool.calls.map((call) => (
                <details className="audit-entry" key={call.id}>
                  <summary>
                    <span className={`outcome outcome-${call.outcome}`}>{call.outcome}</span>
                    <span>{formatToolDate(call.createdAt)}</span>
                    <span>{call.caller}</span>
                    <span>{call.latencyMs} ms</span>
                    <span className="audit-result">{call.outcome === "prediction" ? call.prediction : call.rejection?.code}</span>
                  </summary>
                  <div className="audit-detail">
                    <div className="audit-detail-section">
                      <h3>Inputs</h3>
                      <dl>{Object.entries(call.inputs).map(([name, value]) => <div key={name}><dt><code>{name}</code></dt><dd>{String(value)}</dd></div>)}</dl>
                    </div>
                    {call.outcome === "prediction" ? (
                      <div className="audit-detail-section">
                        <h3>Result</h3>
                        <dl><div><dt>Prediction</dt><dd>{call.prediction}</dd></div><div><dt>Uncertainty</dt><dd>{call.uncertainty ?? "Not provided"}</dd></div></dl>
                        {call.warnings.length > 0 && <div className="audit-message warning-message"><span>Warning</span>{call.warnings.map((warning) => <p key={warning}>{warning}</p>)}</div>}
                      </div>
                    ) : (
                      <div className="audit-detail-section">
                        <h3>Rejection</h3>
                        <div className="audit-message rejection-message"><span>{call.rejection?.code}</span><p>{call.rejection?.message}</p></div>
                        <dl>{call.rejection?.fields.map((field) => <div key={field.name}><dt><code>{field.name}</code></dt><dd>{field.message}</dd></div>)}</dl>
                      </div>
                    )}
                  </div>
                </details>
              ))}
            </div>
          )}
        </section>
      )}
    </AppShell>
  );
}
