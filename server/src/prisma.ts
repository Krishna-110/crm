// Loaded here rather than relying on config.ts being imported first — standalone scripts
// (scripts/*.ts) import this module directly, with no other entrypoint to pull in dotenv.
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

// Prisma connects as `app_prisma`, a BYPASSRLS role (db/migrations/016_prisma_role.sql).
//
// That is deliberate and load-bearing: a Prisma call runs outside any transaction, so
// set_app_session() has never run, so app_current_user_id() is NULL and every FORCE'd RLS
// policy would filter the result to zero rows. Bypassing RLS means **authorization for
// every Prisma-backed route must come from src/scope.ts instead** — there is no database
// backstop on this connection. Never query a user-scoped table through this client
// without applying the matching scope helper.
//
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('Missing required env var DATABASE_URL');

export const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString }),
});
