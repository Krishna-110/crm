import bcrypt from 'bcryptjs';
import { maintPool } from '../src/db.js';

async function main() {
  // The app_user password reset that used to live here is gone: the request path connects
  // as app_prisma via DATABASE_URL, and app_user was made NOLOGIN in 017_disable_rls.sql.
  console.log('Resetting seed user password hashes...');
  const adminHash = await bcrypt.hash('admin123', 10);
  const callerHash = await bcrypt.hash('caller123', 10);
  await maintPool.query('UPDATE users SET password_hash = $1 WHERE role = $2', [adminHash, 'admin']);
  await maintPool.query('UPDATE users SET password_hash = $1 WHERE role = $2', [callerHash, 'caller']);

  console.log('Refreshing dashboard materialized views...');
  await maintPool.query('REFRESH MATERIALIZED VIEW CONCURRENTLY mv_lead_status_breakdown');
  await maintPool.query('REFRESH MATERIALIZED VIEW CONCURRENTLY mv_caller_performance');

  await maintPool.end();

  console.log('\nDev setup complete. Demo credentials:');
  console.log('  Admin:  aarav.sharma@medicrm.in / admin123');
  console.log('  Caller: sneha.iyer@medicrm.in / caller123');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
