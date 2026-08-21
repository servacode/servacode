import { join, resolve, sep } from 'node:path';
import { fail } from '../core/errors.js';

/**
 * Store layout and path confinement.
 *
 * SPEC: 21 §3 (ST-1..ST-10), 08 §2 durability tiers, 21 PI-1..PI-5 (isolation).
 *
 * Every byte is UTF-8 JSON or JSONL, readable with ordinary text tooling and with
 * no Serva Code component running (ST-2). Backup is a directory copy (BK-1).
 *
 * Every path-producing API in this module is CONFINED to the project's .serva
 * subtree. Component-supplied identifiers (canon type/id, working type/id, trace
 * stream, derived name) reach the filesystem, so they are validated as path
 * segments and the resolved result is proven to stay inside its base directory.
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

/* ------------------------------------------------------------------ confinement */

/**
 * A single safe path segment: letters, digits, dot, underscore, hyphen.
 *
 * Deliberately restrictive. Identifiers in this system are `SC-TYPE-SUFFIX`,
 * entity type names, and stream names -- none of which need anything wider, and a
 * permissive rule here is what turns a caller-supplied string into a traversal.
 */
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function assertSafeSegment(value: string, what: string): void {
  if (
    value.length === 0 ||
    value.length > 200 ||
    !SAFE_SEGMENT.test(value) ||
    value.includes('..')
  ) {
    fail({
      code: 'E_VALIDATION',
      message: 'Unsafe ' + what + ': ' + JSON.stringify(value),
      remedy:
        'Path segments must match [A-Za-z0-9][A-Za-z0-9._-]* and may not contain "..", separators, or absolute paths.',
      details: { value, what },
      specRef: '21 PI-1',
    });
  }
}

/**
 * A trace stream name may be nested (e.g. "agentrun/SC-RUN-..."), so it is
 * validated per segment. Backslash is rejected outright: on Windows it is a
 * separator, and accepting it would make confinement platform-dependent.
 */
export function assertSafeStreamName(stream: string): void {
  if (stream.includes('\\')) {
    fail({
      code: 'E_VALIDATION',
      message: 'Unsafe trace stream name: ' + JSON.stringify(stream),
      remedy: 'Use "/" to nest stream names. Backslash is not a valid separator here.',
      details: { stream },
      specRef: '21 PI-1',
    });
  }
  const segments = stream.split('/');
  if (segments.length === 0 || segments.length > 8) {
    fail({
      code: 'E_VALIDATION',
      message: 'Trace stream name has too many segments: ' + JSON.stringify(stream),
      remedy: 'Stream names may nest at most 8 levels.',
      details: { stream },
    });
  }
  for (const s of segments) assertSafeSegment(s, 'trace stream segment');
}

/**
 * Prove a resolved path lies inside `base`. Belt-and-braces after segment
 * validation: segment rules can be reasoned about, containment can be checked.
 */
export function assertWithin(base: string, candidate: string, what: string): string {
  const resolvedBase = resolve(base);
  const resolvedCandidate = resolve(candidate);
  const prefix = resolvedBase.endsWith(sep) ? resolvedBase : resolvedBase + sep;
  if (resolvedCandidate !== resolvedBase && !resolvedCandidate.startsWith(prefix)) {
    fail({
      code: 'E_ISOLATION',
      message: what + ' resolves outside the store: ' + resolvedCandidate,
      remedy: 'Store operations are confined to the project .serva subtree.',
      details: { base: resolvedBase, candidate: resolvedCandidate, what },
      specRef: '21 PI-1..PI-5',
    });
  }
  return resolvedCandidate;
}

/** True when `candidate` is inside `base`. Non-throwing form, used by recovery. */
export function isWithin(base: string, candidate: string): boolean {
  const resolvedBase = resolve(base);
  const resolvedCandidate = resolve(candidate);
  const prefix = resolvedBase.endsWith(sep) ? resolvedBase : resolvedBase + sep;
  return resolvedCandidate === resolvedBase || resolvedCandidate.startsWith(prefix);
}

/* ------------------------------------------------------------- derived paths */

export function canonDir(p: StorePaths, type: string, id: string): string {
  assertSafeSegment(type, 'canon type');
  assertSafeSegment(id, 'canon id');
  return assertWithin(p.canon, join(p.canon, type, id), 'canon directory');
}

export function canonVersionFile(p: StorePaths, type: string, id: string, v: number): string {
  if (!Number.isInteger(v) || v < 1) {
    fail({
      code: 'E_VALIDATION',
      message: 'Canon version must be a positive integer, got ' + String(v),
      remedy: 'Versions start at 1 and increase by one.',
      details: { type, id, version: v },
    });
  }
  return assertWithin(
    p.canon,
    join(canonDir(p, type, id), 'v' + String(v) + '.json'),
    'canon version file',
  );
}

export function workingFile(p: StorePaths, type: string, id: string): string {
  assertSafeSegment(type, 'working type');
  assertSafeSegment(id, 'working id');
  return assertWithin(p.working, join(p.working, type, id + '.json'), 'working file');
}

export function traceFile(p: StorePaths, stream: string): string {
  assertSafeStreamName(stream);
  return assertWithin(p.trace, join(p.trace, ...stream.split('/')) + '.jsonl', 'trace file');
}

export function derivedFile(p: StorePaths, name: string): string {
  assertSafeSegment(name, 'derived name');
  return assertWithin(p.derived, join(p.derived, name + '.json'), 'derived file');
}
