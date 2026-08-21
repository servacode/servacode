import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';

/**
 * Durable filesystem primitives.
 *
 * SPEC: 27 NFR-4. "Committed" means the durable log has acknowledged the write
 * after a successful flush to disk, under the stated assumptions: a filesystem
 * that honours fsync and hardware that does not acknowledge writes it has not
 * persisted. Media failure and lying filesystems are explicitly outside the
 * guarantee and are addressed by backups (21 §7).
 */

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

/** Write a file durably: temp file, fsync, atomic rename, fsync the directory. */
export function writeFileAtomic(path: string, contents: string): void {
  ensureDir(dirname(path));
  const tmp = path + '.tmp-' + process.pid + '-' + Date.now();
  const fd = openSync(tmp, 'w');
  try {
    writeSync(fd, contents, null, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  syncDir(dirname(path));
}

/** Append a line durably to a file opened in append mode. */
export function appendLineDurable(path: string, line: string): void {
  ensureDir(dirname(path));
  const fd = openSync(path, 'a');
  try {
    writeSync(fd, line.endsWith('\n') ? line : line + '\n', null, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * fsync a directory so a rename is durable. Not supported on every platform;
 * failure here is non-fatal because the rename itself is already atomic.
 */
export function syncDir(path: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    fsyncSync(fd);
  } catch {
    // Directory fsync is unavailable on some platforms (notably Windows).
    // The rename remains atomic; only the metadata flush timing is affected.
    // Deliberately ignored, and stated in NFR-4's assumption set.
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Closing a descriptor we failed to fsync is best-effort.
      }
    }
  }
}

export function readTextIfExists(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  return readFileSync(path, 'utf8');
}

export function readJsonIfExists<T>(path: string): T | undefined {
  const text = readTextIfExists(path);
  if (text === undefined) return undefined;
  return JSON.parse(text) as T;
}

export function removeIfExists(path: string): void {
  if (existsSync(path)) rmSync(path, { recursive: true, force: true });
}

export function fileExists(path: string): boolean {
  return existsSync(path);
}
