import pg from 'pg';
import { config } from './config.js';

const { Pool } = pg;

export const appPool = new Pool({
  host: config.db.host,
  port: config.db.port,
  database: config.db.database,
  user: config.db.user,
  password: config.db.password,
});

export const maintPool = new Pool({
  host: config.maintDb.host,
  port: config.maintDb.port,
  database: config.maintDb.database,
  user: config.maintDb.user,
  password: config.maintDb.password,
});

/**
 * Every authenticated request-path query must go through here. It opens a transaction,
 * derives app.current_user_id/app.current_role server-side from the trusted users row
 * (set_app_session), and only then hands the client to the caller — RLS is not in effect
 * until that call has run. GUCs are set with is_local=true (transaction-scoped), which is
 * what makes this safe under PgBouncer transaction-mode pooling.
 */
export async function withUserTx<T>(
  userId: string,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await appPool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_app_session($1)', [userId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
