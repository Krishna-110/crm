import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

// Prisma 7 no longer accepts `url` inside the datasource block in schema.prisma — the
// connection string for CLI commands (db pull / generate) lives here instead, while the
// runtime client gets its connection via the driver adapter in src/prisma.ts.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    url: env('DATABASE_URL'),
  },
});
