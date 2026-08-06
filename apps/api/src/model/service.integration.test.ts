import { afterAll, describe, expect, test } from "bun:test";

import { databasePool } from "../database/pool";
import { publishCandidateModel } from "./service";

const schemaName = "tenant_ampersand_dev";

describe("model publication database integration", () => {
  afterAll(async () => {
    await databasePool.end();
  });

  test("publishes a candidate model", async () => {
    const client = await databasePool.connect();

    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL search_path TO ${schemaName}`);

      const candidate = await client.query<{ id: string }>(
        `
          SELECT id
          FROM model_versions
          WHERE status = 'candidate'
            AND is_active = true
          LIMIT 1
        `,
      );

      const modelVersionId = candidate.rows[0]?.id;

      if (!modelVersionId) {
        throw new Error("No candidate model version is available");
      }

      const user = await client.query<{ id: string }>(
        `
          SELECT id
          FROM users
          WHERE is_active = true
          LIMIT 1
        `,
      );

      const publisherId = user.rows[0]?.id;

      if (!publisherId) {
        throw new Error("No active tenant user is available");
      }

      const result = await publishCandidateModel(
        client,
        schemaName,
        modelVersionId,
        publisherId,
      );

      expect(result.ok).toBe(true);

      if (result.ok) {
        expect(result.body.status).toBe("published");
        expect(result.body.id).toBe(modelVersionId);
      }
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
