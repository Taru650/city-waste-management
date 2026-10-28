import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getConfig } from '@/config/env';

/**
 * Files live on local disk under STORAGE_DIR (nothing is stored in the database). Keys look like
 * "staging/<id>" or "media/2026/10/<id>.jpg"; anything else is refused, so a key can never point outside the folder.
 */
const KEY_RE = /^(staging|media)\/[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*(\.[A-Za-z0-9]+){0,2}$/;

function resolveKey(key: string): string {
  if (!KEY_RE.test(key) || key.includes('..')) throw new Error('Invalid storage key');
  const root = path.resolve(getConfig().storageDir);
  const full = path.resolve(root, key);
  if (full !== root && !full.startsWith(root + path.sep)) throw new Error('Invalid storage key');
  return full;
}

export const Storage = {
  /** Writes through a temporary file and renames, so a reader never sees half a file. */
  async put(key: string, data: Buffer): Promise<void> {
    const full = resolveKey(key);
    await mkdir(path.dirname(full), { recursive: true });
    const tmp = `${full}.${randomUUID().slice(0, 8)}.tmp`;
    try {
      await writeFile(tmp, data);
      await rename(tmp, full);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
  },

  async get(key: string, maxBytes: number): Promise<Buffer> {
    const full = resolveKey(key);
    const s = await stat(full);
    if (s.size > maxBytes) throw new Error('Stored file is larger than expected');
    return readFile(full);
  },

  async head(key: string): Promise<{ size: number } | null> {
    try {
      const s = await stat(resolveKey(key));
      return s.isFile() ? { size: s.size } : null;
    } catch {
      return null;
    }
  },

  async delete(key: string): Promise<void> {
    await rm(resolveKey(key), { force: true });
  },

  /** A readable stream of (part of) a file, for downloads. */
  stream(key: string, range?: { start: number; end: number }) {
    return createReadStream(resolveKey(key), range);
  },
};
