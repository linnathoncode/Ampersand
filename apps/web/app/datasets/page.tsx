"use client";

import type { SourceTable, SourceTableListResponse } from "@ampersand/contracts";
import { useEffect, useRef, useState } from "react";

import {
  createTenantHeaders,
  fetchWithAuthRedirect,
  getSelectedTenant,
  nucleusUrl,
} from "../auth/client";
import { AppShell } from "../components/app-shell";

export default function DatasetsPage() {
  const [tables, setTables] = useState<SourceTable[]>([]);
  const [tableName, setTableName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isImporting, setIsImporting] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  async function loadTables(): Promise<void> {
    const tenant = getSelectedTenant();
    if (!tenant) return;

    const response = await fetchWithAuthRedirect(`${nucleusUrl}/source-tables`, {
      credentials: "include",
      headers: createTenantHeaders(tenant),
      cache: "no-store",
    });
    if (!response.ok) throw new Error(await readApiError(response, "Could not load tables"));
    const body = (await response.json()) as SourceTableListResponse;
    setTables(body.tables);
  }

  useEffect(() => {
    void loadTables()
      .catch((reason: unknown) => setError(errorMessage(reason)))
      .finally(() => setIsLoading(false));
  }, []);

  async function importTable(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const tenant = getSelectedTenant();
    if (!tenant || !file) return;

    setError(null);
    setIsImporting(true);
    const body = new FormData();
    body.set("tableName", tableName.trim());
    body.set("file", file);

    try {
      const response = await fetchWithAuthRedirect(`${nucleusUrl}/source-tables/import`, {
        method: "POST",
        credentials: "include",
        headers: createTenantHeaders(tenant),
        body,
      });
      if (!response.ok) throw new Error(await readApiError(response, "Could not import the table"));

      setTableName("");
      setFile(null);
      if (fileInput.current) fileInput.current.value = "";
      await loadTables();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setIsImporting(false);
    }
  }

  return (
    <AppShell activeSection="datasets" activeTab="selection" breadcrumb="Workspace / Datasets">
      <section className="dataset-page" aria-label="Datasets">
        <form className="dataset-import" onSubmit={(event) => void importTable(event)}>
          <label>
            <span>Table name</span>
            <input
              autoComplete="off"
              onChange={(event) => setTableName(event.target.value)}
              pattern="[A-Za-z_][A-Za-z0-9_]*"
              placeholder="energy_readings"
              required
              value={tableName}
            />
          </label>
          <label className="file-field">
            <span>CSV file</span>
            <input
              accept=".csv,text/csv"
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              ref={fileInput}
              required
              type="file"
            />
          </label>
          <button disabled={isImporting || !file || !tableName.trim()} type="submit">
            {isImporting ? "Importing..." : "Import table"}
          </button>
        </form>

        {error && <p className="inline-error dataset-error" role="alert">{error}</p>}

        <div className="registry dataset-registry">
          <div className="table-wrap">
            <table className="dataset-table">
              <thead>
                <tr><th>Table</th><th>Rows</th><th>Columns</th><th>Detected types</th></tr>
              </thead>
              <tbody>
                {tables.map((table) => (
                  <tr key={table.name}>
                    <td><code className="dataset-name">{table.name}</code></td>
                    <td>{table.rowCount.toLocaleString()}</td>
                    <td>{table.columns.map((column) => column.name).join(", ")}</td>
                    <td>{table.columns.map((column) => column.dataType ?? "unsupported").join(", ")}</td>
                  </tr>
                ))}
                {!error && tables.length === 0 && (
                  <tr><td colSpan={4}>{isLoading ? "Loading tables..." : "No source tables yet. Import a CSV to begin."}</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </AppShell>
  );
}

async function readApiError(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: string } };
    return body.error?.message ?? fallback;
  } catch {
    return fallback;
  }
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : "The request failed";
}
