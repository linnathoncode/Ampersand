import pg from "pg";

const { Pool } = pg;

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

export const databasePool = new Pool({
  connectionString: databaseUrl,
  connectionTimeoutMillis: 5_00,
});
