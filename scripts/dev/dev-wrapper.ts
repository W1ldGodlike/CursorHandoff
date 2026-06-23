/**
 * Runs tsx watch for development. Separate from bare tsx watch so stdin is not
 * captured as "restart" when the dev process needs interactive input.
 */
import { spawn } from 'child_process';
import { resolve } from 'path';

async function main(): Promise<void> {
  const tsxPath = resolve(process.cwd(), 'node_modules', '.bin', 'tsx');
  const child = spawn(tsxPath, ['watch', '--exclude', './data/**', '--exclude', './temp/**', 'src/core/main.ts'], {
    stdio: 'inherit',
    cwd: process.cwd(),
  });
  child.on('error', (err) => {
    console.error('[dev-wrapper] Failed to start:', err.message);
    process.exit(1);
  });
  child.on('exit', (code, signal) => {
    process.exit(code ?? (signal ? 1 : 0));
  });
}

main().catch((err) => {
  console.error('[dev-wrapper] Fatal:', err);
  process.exit(1);
});
