import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { pinCursorCompat } from './resolve-cursor-version.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const version = pinCursorCompat(root);
if (!version) process.exit(1);
