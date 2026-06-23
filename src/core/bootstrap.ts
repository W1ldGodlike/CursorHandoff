import { ensureDataDirEnv } from './paths.js';
import { setLocale } from '../i18n/t.js';

ensureDataDirEnv();
setLocale(process.env.CURSOR_HANDOFF_LOCALE ?? process.env.HANDOFF_LOCALE ?? 'en');
