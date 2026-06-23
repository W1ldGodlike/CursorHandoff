import esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

const shared = {
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  minify: production,
  sourcemap: !production,
  sourcesContent: false,
  logLevel: 'info',
};

async function main() {
  const epipeGuard = [
    "process.on('uncaughtException', (e) => { if (e && e.code === 'EPIPE') return; });",
    "process.on('warning', () => {});",
    "process.stderr?.on?.('error', (e) => { if (e && e.code === 'EPIPE') return; });",
    "process.stdout?.on?.('error', (e) => { if (e && e.code === 'EPIPE') return; });",
    "process.noDeprecation = true;",
  ].join('\n');

  const extCtx = await esbuild.context({
    ...shared,
    entryPoints: ['extension/src/extension.ts'],
    outfile: 'dist/extension.cjs',
    external: ['vscode'],
    banner: { js: epipeGuard },
  });

  const serverCtx = await esbuild.context({
    ...shared,
    format: 'esm',
    entryPoints: ['src/core/main.ts'],
    outfile: 'dist/server/bundle.mjs',
    banner: { js: [
      "process.on('uncaughtException', (e) => { if (e && e.code === 'EPIPE') return; });",
      "process.on('warning', () => {});",
      "process.stderr?.on?.('error', (e) => { if (e && e.code === 'EPIPE') return; });",
      "process.stdout?.on?.('error', (e) => { if (e && e.code === 'EPIPE') return; });",
      "process.noDeprecation = true;",
      "import { createRequire as __createRequire } from 'module';",
      "import { fileURLToPath as __fu } from 'url';",
      "import { dirname as __dn } from 'path';",
      "const require = __createRequire(import.meta.url);",
      "const __filename = __fu(import.meta.url);",
      "const __dirname = __dn(__filename);",
    ].join('\n') },
  });

  if (watch) {
    await Promise.all([extCtx.watch(), serverCtx.watch()]);
    console.log('[esbuild] Watching for changes...');
  } else {
    await Promise.all([extCtx.rebuild(), serverCtx.rebuild()]);
    await Promise.all([extCtx.dispose(), serverCtx.dispose()]);
    const { execSync } = await import('child_process');
    execSync('node scripts/build/write-build-manifest.mjs', { cwd: process.cwd(), stdio: 'inherit' });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
