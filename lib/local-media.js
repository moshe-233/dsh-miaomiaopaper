/** Local media policy only: no configuration writes, scans, subprocesses or WSL discovery. */
import { createHash } from 'node:crypto';
import { basename, extname } from 'node:path';

const MIB = 1024 * 1024;
export const DEFAULT_UPLOAD_LIMIT_MB = 512;
export const MAX_UPLOAD_LIMIT_MB = 8192;

/** Invalid/unbounded input falls back to the upstream default, never disables the cap. */
export function uploadLimitBytes(raw) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!/^\d+$/.test(text)) return DEFAULT_UPLOAD_LIMIT_MB * MIB;
  const n = Number(text);
  return Number.isSafeInteger(n) && n >= 1 && n <= MAX_UPLOAD_LIMIT_MB
    ? n * MIB : DEFAULT_UPLOAD_LIMIT_MB * MIB;
}

/** Direct-child file names only. IDs include the extension, never an absolute user path. */
export function localMediaDescriptor(name, platform = process.platform) {
  if (typeof name !== 'string' || !name || name.startsWith('.')
    || /[\\/:\x00-\x1f]/.test(name) || name !== basename(name)
    || /[. ]$/.test(name)) return null;
  const extension = extname(name).toLowerCase();
  if (!['.mp4', '.jpg', '.jpeg', '.png'].includes(extension)) return null;
  const canonical = platform === 'win32' ? name.toLowerCase() : name;
  const stem = name.slice(0, -extension.length);
  return {
    id: 'local-' + createHash('sha256').update(canonical).digest('hex'),
    legacyId: 'file-' + Buffer.from(stem, 'utf8').toString('base64url'),
    type: extension === '.mp4' ? 'video' : 'image',
    title: stem,
  };
}
