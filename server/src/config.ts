import 'dotenv/config';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name}`);
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 3001),
  tokenTtlHours: Number(process.env.TOKEN_TTL_HOURS ?? 24),
  db: {
    host: process.env.PGHOST ?? 'localhost',
    port: Number(process.env.PGPORT ?? 5432),
    database: required('PGDATABASE'),
    user: required('PGUSER'),
    password: required('PGPASSWORD'),
  },
  maintDb: {
    host: process.env.MAINT_PGHOST ?? process.env.PGHOST ?? 'localhost',
    port: Number(process.env.MAINT_PGPORT ?? process.env.PGPORT ?? 5432),
    database: process.env.MAINT_PGDATABASE ?? required('PGDATABASE'),
    user: required('MAINT_PGUSER'),
    password: required('MAINT_PGPASSWORD'),
  },
};
