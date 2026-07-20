import pg from 'pg';
import dotenv from 'dotenv';
import path from 'path';

// Load env from current directory
dotenv.config();

const pool = new pg.Pool({
  host: process.env.MAINT_PGHOST,
  port: parseInt(process.env.MAINT_PGPORT || '5432'),
  database: process.env.MAINT_PGDATABASE,
  user: process.env.MAINT_PGUSER,
  password: process.env.MAINT_PGPASSWORD,
});

async function main() {
  console.log('Resetting DB state for Phase 2 tests...');
  
  // 1. Reset notifications for Sneha Iyer to unread
  await pool.query("UPDATE notifications SET is_read = false WHERE id = '90000000-0000-0000-0000-000000000001'");
  console.log('Notification 90000000-0000-0000-0000-000000000001 reset to unread.');
  
  // 2. Reactivate Vikram Singh (restore clean state)
  await pool.query("UPDATE users SET status = 'active' WHERE id = '10000000-0000-0000-0000-000000000005'");
  console.log('User Vikram Singh status set to active.');
  
  // 3. Reactivate any inactive medicine (Test Inactive Med, if exists)
  await pool.query("UPDATE products SET is_active = true WHERE brand_name = 'Test Inactive Med'");
  console.log('Test Inactive Med activated.');
  
  // 4. Refresh materialized views
  await pool.query('REFRESH MATERIALIZED VIEW CONCURRENTLY mv_lead_status_breakdown');
  await pool.query('REFRESH MATERIALIZED VIEW CONCURRENTLY mv_caller_performance');
  console.log('Materialized views refreshed.');
  
  await pool.end();
  console.log('DB State reset complete.');
}

main().catch((err) => {
  console.error('Error resetting DB state:', err);
  process.exit(1);
});
