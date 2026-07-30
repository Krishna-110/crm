import 'dotenv/config';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name}`);
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 3001),
  tokenTtlHours: Number(process.env.TOKEN_TTL_HOURS ?? 24),
  // There is no application `db` block any more. The request path connects through Prisma,
  // which reads DATABASE_URL (app_prisma) via prisma.config.ts, not this file. The old
  // `db` entry described app_user, whose LOGIN was revoked in 017_disable_rls.sql — keeping
  // a required('PGUSER') here would demand credentials for a role that can no longer
  // connect. PGHOST/PGPORT/PGDATABASE survive only as fallbacks for maintDb below.
  maintDb: {
    host: process.env.MAINT_PGHOST ?? process.env.PGHOST ?? 'localhost',
    port: Number(process.env.MAINT_PGPORT ?? process.env.PGPORT ?? 5432),
    database: process.env.MAINT_PGDATABASE ?? required('PGDATABASE'),
    user: required('MAINT_PGUSER'),
    password: required('MAINT_PGPASSWORD'),
  },
};
