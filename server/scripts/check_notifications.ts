import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const pool = new pg.Pool({
  host: process.env.MAINT_PGHOST,
  port: parseInt(process.env.MAINT_PGPORT || '5432'),
  database: process.env.MAINT_PGDATABASE,
  user: process.env.MAINT_PGUSER,
  password: process.env.MAINT_PGPASSWORD,
});

async function main() {
  const res = await pool.query("SELECT id, recipient_user_id, title, is_read FROM notifications");
  console.log(res.rows);
  await pool.end();
}

main().catch(console.error);
