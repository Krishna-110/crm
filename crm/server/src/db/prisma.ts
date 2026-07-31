import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

/**
 * The database client.
 *
 * Connects as an ordinary owner role. There is no BYPASSRLS role and no session-variable
 * handshake, because there is no RLS and there are no triggers reading session state — the
 * previous design needed both, and the coupling between them was the source of its worst
 * bug: writes issued outside the handshake silently skipped every privilege check.
 *
 * This client is UNSCOPED. Use `scopedFor(actor)` on the request path; reach for this one
 * only where there is deliberately no actor yet, such as resolving a session during
 * authentication.
 */
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is not set');

export const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString }),
});

export type Tx = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$extends'
>;
