import 'dotenv/config';
import { defineConfig } from 'prisma/config';

/**
 * Prisma 7 no longer accepts `url` inside the datasource block — the connection string for
 * migrate/studio lives here, and the runtime client gets its own adapter in src/db/prisma.ts.
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { seed: 'tsx prisma/seed.ts' },
  datasource: {
    url: process.env.DATABASE_URL!,
  },
});
