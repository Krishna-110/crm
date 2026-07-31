import 'dotenv/config';
import { app } from './app.js';
import { prisma } from './db/prisma.js';

const port = Number(process.env.PORT ?? 3001);
const server = app.listen(port, () => console.log(`MediCRM API listening on http://localhost:${port}`));

/** Finish in-flight requests before dropping the database connection. */
async function shutdown(signal: string) {
  console.log(`${signal} received, shutting down`);
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
