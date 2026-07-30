/**
 * A maintenance connection for tests.
 *
 * Some things the suite needs cannot be done as `app_prisma`: REFRESH MATERIALIZED VIEW
 * requires the view's owner, and reading pg_catalog/information_schema for the schema-drift
 * checks is clearer through a plain client than through Prisma's raw API.
 */
import pg from 'pg';

const TEST_DB = process.env.TEST_PGDATABASE ?? 'medcrm_test';

export async function withMaint<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({
    host: process.env.MAINT_PGHOST ?? 'localhost',
    port: Number(process.env.MAINT_PGPORT ?? 5432),
    user: process.env.MAINT_PGUSER,
    password: process.env.MAINT_PGPASSWORD,
    database: TEST_DB,
  });
  await client.connect();
  try {
    const { rows } = await client.query('SELECT current_database() AS db');
    if (rows[0]?.db !== TEST_DB) {
      throw new Error(`maint client connected to "${rows[0]?.db}", expected "${TEST_DB}"`);
    }
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** Brings both dashboard matviews up to date with the base tables. */
export async function refreshMatviews(): Promise<void> {
  await withMaint(async (c) => {
    await c.query('REFRESH MATERIALIZED VIEW CONCURRENTLY mv_lead_status_breakdown');
    await c.query('REFRESH MATERIALIZED VIEW CONCURRENTLY mv_caller_performance');
  });
}
