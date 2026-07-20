import { app } from './app.js';
import { config } from './config.js';
import { startScheduler } from './scheduler.js';
import { appPool, maintPool } from './db.js';

const server = app.listen(config.port, () => {
  console.log(`MediCRM API listening on http://localhost:${config.port}`);
  startScheduler();
});

async function shutdown(signal: string) {
  console.log(`${signal} received, shutting down...`);
  server.close(async () => {
    await appPool.end();
    await maintPool.end();
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
