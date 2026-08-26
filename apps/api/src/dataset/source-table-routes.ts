import { Elysia } from "elysia";

import { CREATE_DATASET_CLAIM, getAuthContext, hasClaim } from "../auth/context";
import { resolveNucleusAuth } from "../auth/resolve-nucleus-auth";
import { withTenantTransaction } from "../database/tenant-transaction";
import { importCsvSourceTable, listSourceTables } from "./source-table-service";

const MAX_CSV_BYTES = 10 * 1024 * 1024;

export const sourceTableRoutes = new Elysia({ prefix: "/source-tables" })
  .get("/", async ({ request, set }) => {
    const auth =
      getAuthContext(request.headers) ?? (await resolveNucleusAuth(request));
    if (!auth) {
      set.status = 401;
      return { error: { code: "UNAUTHENTICATED", message: "Authentication is required" } };
    }

    const tables = await withTenantTransaction(auth.schemaName, (client) =>
      listSourceTables(client, auth.schemaName),
    );
    return { tables };
  })
  .post("/import", async ({ request, set }) => {
    const auth =
      getAuthContext(request.headers) ?? (await resolveNucleusAuth(request));
    if (!auth) {
      set.status = 401;
      return { error: { code: "UNAUTHENTICATED", message: "Authentication is required" } };
    }
    if (!hasClaim(auth, CREATE_DATASET_CLAIM)) {
      set.status = 403;
      return { error: { code: "FORBIDDEN", message: "Dataset creation permission is required" } };
    }

    const form = await request.formData().catch(() => null);
    const tableName = form?.get("tableName");
    const file = form?.get("file");
    if (typeof tableName !== "string" || !(file instanceof File)) {
      set.status = 400;
      return { error: { code: "INVALID_IMPORT_REQUEST", message: "tableName and a CSV file are required" } };
    }
    if (file.size > MAX_CSV_BYTES) {
      set.status = 413;
      return { error: { code: "CSV_FILE_TOO_LARGE", message: "CSV files are limited to 10 MB" } };
    }

    const csvText = await file.text();
    const result = await withTenantTransaction(auth.schemaName, (client) =>
      importCsvSourceTable(client, auth.schemaName, tableName, csvText),
    );
    if (!result.ok) {
      set.status = result.status;
      return { error: { code: result.code, message: result.message } };
    }

    set.status = 201;
    return { table: result.table };
  });
