import { execFileSync } from 'node:child_process';

/**
 * Rebuilds `crm_test` before the browser suite starts.
 *
 * The vitest suite uses the same database and leaves rows behind, as do these tests. Starting
 * from a rebuilt fixture means a failure never depends on what ran before it.
 *
 * Shells out rather than importing the builder: the server is a separate workspace with its
 * own module resolution, and this is one call.
 */
export default async function globalSetup() {
  process.stdout.write('\n  rebuilding crm_test for e2e...\n');
  execFileSync('npm', ['-w', 'server', 'run', 'test:db'], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
}
