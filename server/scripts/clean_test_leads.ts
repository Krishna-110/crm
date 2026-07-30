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
  console.log('Cleaning up test-generated leads from database...');
  const res = await pool.query(`
    DELETE FROM leads 
    WHERE customer_name LIKE 'DASH Cache Test%'
       OR customer_name LIKE 'Source %'
       OR customer_name LIKE 'Test Deactivated Assign%'
       OR customer_name LIKE 'Offline Submit%'
       OR customer_name LIKE 'Soon Inactive%'
       OR customer_name LIKE 'Offline Address%'
       OR customer_name LIKE 'Test Cache Address%'
       OR customer_name LIKE 'Source Phone Default Test%'
  `);
  console.log(`Deleted ${res.rowCount} test leads.`);
  await pool.end();
}

main().catch((err) => {
  console.error('Error cleaning test leads:', err);
  process.exit(1);
});
