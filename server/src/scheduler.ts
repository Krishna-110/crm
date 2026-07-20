import { maintPool } from './db.js';

const FIVE_MINUTES = 5 * 60 * 1000;
const ONE_HOUR = 60 * 60 * 1000;
const ONE_DAY = 24 * 60 * 60 * 1000;

// pg_cron is not installed on this host (confirmed: shared_preload_libraries is empty,
// no pg_cron extension, no cron.job table) — schema.sql's own bootstrap detected this
// and only logged a warning, so nothing refreshes matviews/partitions/sessions unless
// this process does it.

async function refreshDashboards() {
  await maintPool.query('REFRESH MATERIALIZED VIEW CONCURRENTLY mv_lead_status_breakdown');
  await maintPool.query('REFRESH MATERIALIZED VIEW CONCURRENTLY mv_caller_performance');
}

async function ensurePartitions() {
  const now = new Date();
  for (let i = 0; i <= 2; i++) {
    const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i, 1));
    const monthStr = month.toISOString().slice(0, 10);
    for (const table of ['lead_activities', 'notifications', 'audit_log']) {
      await maintPool.query('SELECT ensure_monthly_partition($1, $2::date)', [table, monthStr]);
    }
  }
}

async function cleanupSessions() {
  await maintPool.query('DELETE FROM sessions WHERE expires_at < now()');
}

function every(intervalMs: number, fn: () => Promise<void>, label: string) {
  setInterval(() => {
    fn().catch((err) => console.error(`[scheduler] ${label} failed:`, err));
  }, intervalMs);
}

export function startScheduler() {
  refreshDashboards().catch((err) => console.error('[scheduler] refreshDashboards failed:', err));
  ensurePartitions().catch((err) => console.error('[scheduler] ensurePartitions failed:', err));
  cleanupSessions().catch((err) => console.error('[scheduler] cleanupSessions failed:', err));

  every(FIVE_MINUTES, refreshDashboards, 'refreshDashboards');
  every(ONE_DAY, ensurePartitions, 'ensurePartitions');
  every(ONE_HOUR, cleanupSessions, 'cleanupSessions');
}
