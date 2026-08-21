import { join } from 'node:path';

/**
 * Store layout. SPEC: 21 §3 (ST-1..ST-10) and 08 §2 durability tiers.
 *
 * Every byte is UTF-8 JSON or JSONL, readable with ordinary text tooling and with
 * no Serva Code component running (ST-2). Backup is a directory copy (BK-1).
 */

export const SERVA_DIR = '.serva';

export interface StorePaths {
  readonly root: string;
  readonly serva: string;
  readonly project: string;
  readonly canon: string;
  readonly working: string;
  readonly trace: string;
  readonly derived: string;
  readonly journal: string;
  readonly quarantine: string;
  readonly backups: string;
  readonly schemaVersion: string;
}

export function storePaths(root: string): StorePaths {
  const serva = join(root, SERVA_DIR);
  return {
    root,
    serva,
    project: join(serva, 'project.json'),
    canon: join(serva, 'canon'),
    working: join(serva, 'working'),
    trace: join(serva, 'trace'),
    derived: join(serva, 'derived'),
    journal: join(serva, 'journal'),
    quarantine: join(serva, 'quarantine'),
    backups: join(serva, 'backups'),
    schemaVersion: join(serva, 'SCHEMA_VERSION'),
  };
}

export function canonDir(p: StorePaths, type: string, id: string): string {
  return join(p.canon, type, id);
}

export function canonVersionFile(p: StorePaths, type: string, id: string, v: number): string {
  return join(canonDir(p, type, id), 'v' + String(v) + '.json');
}

export function workingFile(p: StorePaths, type: string, id: string): string {
  return join(p.working, type, id + '.json');
}

export function traceFile(p: StorePaths, stream: string): string {
  return join(p.trace, stream + '.jsonl');
}
