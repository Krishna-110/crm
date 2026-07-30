import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { maintPool } from '../src/db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function run() {
  const sqlPath = path.resolve(__dirname, '../../db/migrations/014_convert_sold_lead_to_paid_order.sql');
  const sql = fs.readFileSync(sqlPath, 'utf8');
  console.log('Running Migration 014...');
  await maintPool.query(sql);
  console.log('Migration 014 applied successfully!');
  await maintPool.end();
}

run().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
