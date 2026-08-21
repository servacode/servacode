import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  canonDir,
  canonVersionFile,
  storePaths,
  traceFile,
  workingFile,
  type StorePaths,
} from './paths.js';
import {
  ensureDir,
  fileExists,
  readJsonIfExists,
  readTextIfExists,
  removeIfExists,
  writeFileAtomic,
} from './fsutil.js';
import { TraceLog, type AppendInput, type TraceRecord } from './traceLog.js';
import { digestOf } from '../core/hash.js';
import { fail } from '../core/errors.js';
import type { Clock } from '../core/clock.js';
import type { IdSource } from '../core/ids.js';

/**
 * The authoritative local store.
 *
 * SPEC: 08 §2 durability tiers, 21 §3-§4, SC-POL-020 (no project truth lives only
 * in AI conversation state), SC-POL-022 (append-only truth).
 *
 * Tier mapping:
 *   T-CANON   -> canon/<type>/<id>/v<N>.json      immutable versions
 *   T-WORKING -> working/<type>/<id>.json         mutable projections
 *   T-TRACE   -> trace/<stream>.jsonl             append-only, hash-chained
 *   T-DERIVED -> derived/*.json                   rebuildable, never authoritative
 */

export const SCHEMA_VERSION = 1;

export interface CanonEnvelope<T = unknown> {
  readonly id: string;
  readonly type: string;
  readonly version: number;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly digest: string;
  /** Forward-only supersession (08 §6.2). The superseded record is never touched. */
  readonly supersedes?: string;
  readonly source: string;
  readonly body: T;
}

export interface WorkingEnvelope<T = unknown> {
  readonly id: string;
  readonly type: string;
  readonly revision: number;
  readonly updatedAt: string;
  readonly updatedBy: string;
  readonly body: T;
}

type PendingWrite =
  | { kind: 'FILE'; path: string; contents: string }
  | { kind: 'TRACE'; stream: string; input: AppendInput };

interface JournalPayload {
  readonly txId: string;
  readonly createdAt: string;
  readonly writes: readonly PendingWrite[];
}

export interface StoreDeps {
  readonly clock: Clock;
  readonly ids: IdSource;
  readonly actor: string;
}

/**
 * A transaction. Writes are staged, then committed through a write-ahead journal.
 * TX-1: a crash leaves either the old state or the new one, never a partial one.
 */
export class Transaction {
  private readonly writes: PendingWrite[] = [];
  /**
   * Read-your-writes overlay. A transaction that cannot see its own staged writes
   * would surprise every caller and force artificial commits mid-operation, so
   * reads consult the overlay first and fall back to the committed store.
   */
  private readonly canonOverlay = new Map<string, CanonEnvelope<unknown>>();
  private readonly workingOverlay = new Map<string, WorkingEnvelope<unknown>>();
  private committed = false;
  private rolledBack = false;

  constructor(
    private readonly store: Store,
    readonly id: string,
  ) {}

  /** Canon head version including this transaction's staged writes. */
  canonHeadVersion(type: string, id: string): number {
    const staged = this.canonOverlay.get(type + '/' + id);
    const committedVersion = this.store.canonHeadVersion(type, id);
    return staged === undefined ? committedVersion : Math.max(staged.version, committedVersion);
  }

  getCanon<T>(type: string, id: string): CanonEnvelope<T> | undefined {
    const staged = this.canonOverlay.get(type + '/' + id);
    if (staged !== undefined) return staged as CanonEnvelope<T>;
    return this.store.getCanon<T>(type, id);
  }

  getWorking<T>(type: string, id: string): WorkingEnvelope<T> | undefined {
    const staged = this.workingOverlay.get(type + '/' + id);
    if (staged !== undefined) return staged as WorkingEnvelope<T>;
    return this.store.getWorking<T>(type, id);
  }

  putCanon<T>(
    type: string,
    id: string,
    body: T,
    opts?: { supersedes?: string; source?: string },
  ): CanonEnvelope<T> {
    this.assertOpen();
    const p = this.store.paths;
    const nextVersion = this.canonHeadVersion(type, id) + 1;
    const env: CanonEnvelope<T> = {
      id,
      type,
      version: nextVersion,
      createdAt: this.store.deps.clock.now(),
      createdBy: this.store.deps.actor,
      digest: digestOf(body),
      ...(opts?.supersedes === undefined ? {} : { supersedes: opts.supersedes }),
      source: opts?.source ?? 'SYSTEM',
      body,
    };
    this.writes.push({
      kind: 'FILE',
      path: canonVersionFile(p, type, id, nextVersion),
      contents: JSON.stringify(env, null, 2),
    });
    this.canonOverlay.set(type + '/' + id, env as CanonEnvelope<unknown>);
    return env;
  }

  putWorking<T>(type: string, id: string, body: T): WorkingEnvelope<T> {
    this.assertOpen();
    const existing = this.getWorking<T>(type, id);
    const env: WorkingEnvelope<T> = {
      id,
      type,
      revision: (existing?.revision ?? 0) + 1,
      updatedAt: this.store.deps.clock.now(),
      updatedBy: this.store.deps.actor,
      body,
    };
    this.writes.push({
      kind: 'FILE',
      path: workingFile(this.store.paths, type, id),
      contents: JSON.stringify(env, null, 2),
    });
    this.workingOverlay.set(type + '/' + id, env as WorkingEnvelope<unknown>);
    return env;
  }

  /** The only way to write T-TRACE. Runtime-authored only (SC-POL-029). */
  appendTrace(stream: string, input: Omit<AppendInput, 'at' | 'actor'> & { actor?: string }): void {
    this.assertOpen();
    this.writes.push({
      kind: 'TRACE',
      stream,
      input: {
        at: this.store.deps.clock.now(),
        actor: input.actor ?? this.store.deps.actor,
        type: input.type,
        payload: input.payload,
        ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }),
        ...(input.causationId === undefined ? {} : { causationId: input.causationId }),
      },
    });
  }

  commit(): void {
    this.assertOpen();
    this.store.commitTransaction(this.id, this.writes);
    this.committed = true;
  }

  rollback(): void {
    if (this.committed) {
      fail({
        code: 'E_TRANSACTION',
        message: 'Transaction ' + this.id + ' is already committed',
        remedy: 'A committed transaction cannot be rolled back. Append a compensating change.',
        specRef: 'SC-POL-022',
      });
    }
    this.writes.length = 0;
    this.canonOverlay.clear();
    this.workingOverlay.clear();
    this.rolledBack = true;
  }

  get pendingCount(): number {
    return this.writes.length;
  }

  private assertOpen(): void {
    if (this.committed || this.rolledBack) {
      fail({
        code: 'E_TRANSACTION',
        message: 'Transaction ' + this.id + ' is closed',
        remedy: 'Begin a new transaction.',
        details: { committed: this.committed, rolledBack: this.rolledBack },
      });
    }
  }
}

export class Store {
  readonly paths: StorePaths;
  private readonly headCache = new Map<string, number>();

  constructor(
    root: string,
    readonly deps: StoreDeps,
  ) {
    this.paths = storePaths(root);
  }

  /* ------------------------------------------------------------------ lifecycle */

  static initialize(root: string, deps: StoreDeps): Store {
    const p = storePaths(root);
    if (fileExists(p.serva)) {
      fail({
        code: 'E_PROJECT_EXISTS',
        message: 'A Serva store already exists at ' + p.serva,
        remedy: 'Open the existing project instead of initializing a new one.',
        details: { path: p.serva },
      });
    }
    for (const dir of [
      p.serva,
      p.canon,
      p.working,
      p.trace,
      p.derived,
      p.journal,
      p.quarantine,
      p.backups,
    ]) {
      ensureDir(dir);
    }
    writeFileAtomic(p.schemaVersion, String(SCHEMA_VERSION) + '\n');
    return new Store(root, deps);
  }

  static open(root: string, deps: StoreDeps): Store {
    const p = storePaths(root);
    if (!fileExists(p.serva)) {
      fail({
        code: 'E_NOT_A_PROJECT',
        message: 'No Serva store at ' + p.serva,
        remedy: 'Run `serva init` in the project root, or pass --root to point at one.',
        details: { searched: p.serva },
      });
    }
    const raw = readTextIfExists(p.schemaVersion);
    const found = raw === undefined ? 0 : Number.parseInt(raw.trim(), 10);
    if (found !== SCHEMA_VERSION) {
      fail({
        code: 'E_SCHEMA_VERSION',
        message: 'Store schema version ' + String(found) + ', expected ' + String(SCHEMA_VERSION),
        remedy: 'Run `serva doctor --migrate` to migrate the store.',
        details: { found, expected: SCHEMA_VERSION },
        specRef: '21 ST-6',
      });
    }
    const store = new Store(root, deps);
    store.recover();
    return store;
  }

  /* --------------------------------------------------------------- transactions */

  begin(): Transaction {
    return new Transaction(this, this.deps.ids.next('SC-TX'));
  }

  /**
   * Two-phase commit through a write-ahead journal.
   *   1. stage journal (fsync)   2. atomic rename to .commit  <- COMMIT POINT
   *   3. apply writes            4. remove journal
   * A crash before step 2 discards; after step 2 re-applies. Both are idempotent
   * because the journal carries absolute file contents.
   */
  commitTransaction(txId: string, writes: readonly PendingWrite[]): void {
    if (writes.length === 0) return;
    const staged = join(this.paths.journal, txId + '.json');
    const committed = join(this.paths.journal, txId + '.commit');
    const payload: JournalPayload = {
      txId,
      createdAt: this.deps.clock.now(),
      writes,
    };
    writeFileAtomic(staged, JSON.stringify(payload, null, 2));
    // Commit point. Rename is atomic on a single volume.
    writeFileAtomic(committed, JSON.stringify(payload, null, 2));
    removeIfExists(staged);
    this.applyJournal(payload);
    removeIfExists(committed);
    this.headCache.clear();
  }

  private applyJournal(payload: JournalPayload): void {
    for (const w of payload.writes) {
      if (w.kind === 'FILE') {
        writeFileAtomic(w.path, w.contents);
      } else {
        new TraceLog(traceFile(this.paths, w.stream)).append(w.input);
      }
    }
  }

  /**
   * Crash recovery. 22 §4.2.
   * Committed journals are re-applied; staged-but-uncommitted journals are discarded.
   */
  recover(): { reapplied: number; discarded: number } {
    ensureDir(this.paths.journal);
    let reapplied = 0;
    let discarded = 0;
    const entries = readdirSync(this.paths.journal).sort();
    for (const name of entries) {
      const full = join(this.paths.journal, name);
      if (name.endsWith('.commit')) {
        const payload = readJsonIfExists<JournalPayload>(full);
        if (payload !== undefined) {
          this.applyJournal(payload);
          reapplied += 1;
        }
        removeIfExists(full);
      } else if (name.endsWith('.json')) {
        removeIfExists(full);
        discarded += 1;
      }
    }
    if (reapplied > 0 || discarded > 0) this.headCache.clear();
    return { reapplied, discarded };
  }

  /* -------------------------------------------------------------------- readers */

  canonHeadVersion(type: string, id: string): number {
    const key = type + '/' + id;
    const cached = this.headCache.get(key);
    if (cached !== undefined) return cached;
    const dir = canonDir(this.paths, type, id);
    if (!fileExists(dir)) {
      this.headCache.set(key, 0);
      return 0;
    }
    let max = 0;
    for (const f of readdirSync(dir)) {
      const m = /^v(\d+)\.json$/.exec(f);
      if (m !== null && m[1] !== undefined) {
        const n = Number.parseInt(m[1], 10);
        if (n > max) max = n;
      }
    }
    this.headCache.set(key, max);
    return max;
  }

  getCanon<T>(type: string, id: string, version?: number): CanonEnvelope<T> | undefined {
    const v = version ?? this.canonHeadVersion(type, id);
    if (v === 0) return undefined;
    return readJsonIfExists<CanonEnvelope<T>>(canonVersionFile(this.paths, type, id, v));
  }

  listCanonVersions(type: string, id: string): number[] {
    const dir = canonDir(this.paths, type, id);
    if (!fileExists(dir)) return [];
    const out: number[] = [];
    for (const f of readdirSync(dir)) {
      const m = /^v(\d+)\.json$/.exec(f);
      if (m !== null && m[1] !== undefined) out.push(Number.parseInt(m[1], 10));
    }
    return out.sort((a, b) => a - b);
  }

  listCanonIds(type: string): string[] {
    const dir = join(this.paths.canon, type);
    if (!fileExists(dir)) return [];
    return readdirSync(dir).sort();
  }

  getWorking<T>(type: string, id: string): WorkingEnvelope<T> | undefined {
    return readJsonIfExists<WorkingEnvelope<T>>(workingFile(this.paths, type, id));
  }

  listWorkingIds(type: string): string[] {
    const dir = join(this.paths.working, type);
    if (!fileExists(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -5))
      .sort();
  }

  trace(stream: string): TraceLog {
    return new TraceLog(traceFile(this.paths, stream));
  }

  /**
   * Stream names may contain '/', e.g. "agentrun/SC-RUN-...", so the trace root is
   * a tree rather than a flat directory. A non-recursive listing silently hides
   * whole classes of stream -- which is how an interrupted run could go unnoticed.
   */
  listTraceStreams(): string[] {
    if (!fileExists(this.paths.trace)) return [];
    const out: string[] = [];
    const walk = (dir: string, prefix: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          walk(join(dir, entry.name), prefix + entry.name + '/');
        } else if (entry.name.endsWith('.jsonl')) {
          out.push(prefix + entry.name.slice(0, -6));
        }
      }
    };
    walk(this.paths.trace, '');
    return out.sort();
  }

  readTrace(stream: string): TraceRecord[] {
    return this.trace(stream).readAll();
  }

  /**
   * Derived reverse index for supersession (08 §6.2).
   * superseded_by is NEVER stored; it is computed from forward links.
   */
  supersededBy(type: string, targetId: string): string[] {
    const out: string[] = [];
    for (const id of this.listCanonIds(type)) {
      for (const v of this.listCanonVersions(type, id)) {
        const env = this.getCanon<unknown>(type, id, v);
        if (env?.supersedes === targetId) out.push(id + '@v' + String(v));
      }
    }
    return out;
  }

  /** T-DERIVED. Freely rewritable, never authoritative. */
  putDerived(name: string, value: unknown): void {
    writeFileAtomic(join(this.paths.derived, name + '.json'), JSON.stringify(value, null, 2));
  }

  getDerived<T>(name: string): T | undefined {
    return readJsonIfExists<T>(join(this.paths.derived, name + '.json'));
  }
}
