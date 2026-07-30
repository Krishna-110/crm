import pg from 'pg';
import { config } from './config.js';

const { Pool } = pg;

/**
 * Maintenance pool — the schema-owner role, used only by scheduler.ts and the scripts in
 * scripts/. Everything on the request path now goes through Prisma (src/prisma.ts).
 *
 * This is deliberately NOT a Prisma client: its whole job is work Prisma cannot do —
 * `REFRESH MATERIALIZED VIEW CONCURRENTLY` (which cannot run inside a transaction and
 * requires the view's owner) and `ensure_monthly_partition()`.
 *
 * The former `appPool` + `withUserTx()` lived here to give every request an RLS session via
 * set_app_session(). Both are gone: Prisma connects as a BYPASSRLS role and authorization
 * is enforced in application code by src/scope.ts, applied automatically through the client
 * extension in src/scopedPrisma.ts. The one place a session GUC is still needed — the
 * SECURITY DEFINER routines that run their own ownership checks — is handled by
 * scopedPrisma.withDbSession().
 */
export const maintPool = new Pool({
  host: config.maintDb.host,
  port: config.maintDb.port,
  database: config.maintDb.database,
  user: config.maintDb.user,
  password: config.maintDb.password,
});
