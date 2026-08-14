import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import pg from "pg";

import { createFilesystemArtifactReader } from "../../filesystem-reader";
import { verifyStoredModelArtifact } from "../../service";

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

const integrationPool = new Pool({ connectionString: databaseUrl });
const schemaName = "tenant_ampersand_dev";

describe("artifact verification database integration", () => {
  afterAll(async () => {
    await integrationPool.end();
  });

  test("verifies stored metadata and detects modified artifact content", async () => {
    const artifactDirectory = await mkdtemp(
      join(tmpdir(), "ampersand-artifact-integration-"),
    );
    const client = await integrationPool.connect();

    try {
      await client.query("BEGIN");

      const storedArtifact = await client.query<{
        id: string;
        model_version_id: string;
      }>(
        `
          SELECT ma.id, ma.model_version_id
          FROM ${schemaName}.model_artifacts ma
          INNER JOIN ${schemaName}.model_versions mv
            ON mv.id = ma.model_version_id
          WHERE ma.is_active = true
            AND mv.is_active = true
            AND mv.status = 'published'
          LIMIT 1
        `,
      );

      const artifact = storedArtifact.rows[0];

      if (!artifact) {
        throw new Error("No published model artifact is available");
      }

      const filename = `${randomUUID()}.onnx`;
      const bytes = new TextEncoder().encode("integration model bytes");
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      await writeFile(join(artifactDirectory, filename), bytes);

      await client.query(
        `
          UPDATE ${schemaName}.model_artifacts
          SET storage_uri = $1,
              content_sha256 = $2,
              size_bytes = $3,
              producer_worker_id = $4
          WHERE id = $5
        `,
        [filename, sha256, bytes.byteLength, "integration-worker", artifact.id],
      );

      const readArtifact = createFilesystemArtifactReader(artifactDirectory);
      const trustedWorkers = new Set(["integration-worker"]);
      const verified = await verifyStoredModelArtifact(
        client,
        schemaName,
        artifact.model_version_id,
        trustedWorkers,
        readArtifact,
      );

      expect(verified.ok).toBe(true);
      if (verified.ok) expect(verified.bytes).toEqual(bytes);

      const modifiedBytes = bytes.slice();
      modifiedBytes[0] = modifiedBytes[0]! ^ 0xff;
      await writeFile(join(artifactDirectory, filename), modifiedBytes);

      const modified = await verifyStoredModelArtifact(
        client,
        schemaName,
        artifact.model_version_id,
        trustedWorkers,
        readArtifact,
      );

      expect(modified.ok).toBe(false);
      if (!modified.ok) expect(modified.reason).toBe("CHECKSUM_MISMATCH");

      console.log(
        "PASS artifact verification: trusted artifact accepted; modified artifact rejected",
      );
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
      await rm(artifactDirectory, { recursive: true, force: true });
    }
  });
});
