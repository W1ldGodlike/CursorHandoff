import { cpSync, rmSync } from 'fs';
import * as esbuild from 'esbuild';

rmSync('dist/client', { recursive: true, force: true });
cpSync('src/client', 'dist/client', { recursive: true });
cpSync('locales', 'dist/locales', { recursive: true });
cpSync('locales', 'dist/client/locales', { recursive: true });
cpSync(
  'node_modules/socket.io/client-dist/socket.io.min.js',
  'dist/client/vendor-socket.io.min.js'
);
cpSync(
  'node_modules/socket.io/client-dist/socket.io.min.js.map',
  'dist/client/vendor-socket.io.min.js.map'
);
esbuild.buildSync({
  entryPoints: ['scripts/build/vendor-mermaid-entry.mjs'],
  outfile: 'dist/client/vendor-mermaid.min.js',
  bundle: true,
  format: 'iife',
  minify: true,
});
