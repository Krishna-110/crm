import { execFileSync } from 'node:child_process';

/**
 * Rebuilds `medcrm_test` before the browser suite starts.
 *
 * Runs the builder as a child process rather than importing it: the server package has its
 * own tsconfig and module resolution, and shelling out avoids dragging that across the
 * package boundary for one function call.
 *
 * This matters because the vitest suite also uses medcrm_test and leaves rows behind, as do
 * these tests. Rebuilding here means the fixture is identical on every run no matter what
 * ran before, so a failure is always reproducible.
 */
export default async function globalSetup() {
  process.stdout.write('\n  rebuilding medcrm_test for e2e...\n');
  execFileSync('npm', ['--prefix', 'server', 'run', 'test:db'], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
}
