import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { GovernanceState } from '../vocab/index.js';
import { Store, type StoreDeps } from '../store/store.js';
import { SERVA_DIR, storePaths } from '../store/paths.js';
import { TimeOrderedIdSource, type IdSource } from '../core/ids.js';
import { systemClock, type Clock } from '../core/clock.js';
import { fail } from '../core/errors.js';
import { AuditAction, audit } from '../events/audit.js';
import { getCatalogues } from '../catalogue/index.js';
import { ProjectSchema, parseOrThrow, type Project } from '../domain/schemas.js';

/** Serva Code implementation version. Distinct from the R4 specification baseline. */
export const SERVA_VERSION = '0.2.0';
export const SPEC_BASELINE = 'R4';

/**
 * Application runtime: project-root discovery, startup validation, graceful shutdown.
 * SPEC: 21 §2 (components), 20 §2 (governance state).
 */

/**
 * Walk upward looking for a Serva store.
 *
 * A directory merely NAMED `.serva` is not a store -- unrelated tooling uses that
 * name too. Discovery requires the store marker, so an unrelated directory higher
 * up the tree cannot be mistaken for the project root.
 */
export function discoverProjectRoot(startDir: string): string | undefined {
  let dir = resolve(startDir);
  for (;;) {
    const candidate = join(dir, SERVA_DIR);
    if (existsSync(candidate) && existsSync(join(candidate, 'SCHEMA_VERSION'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export interface RuntimeOptions {
  readonly root?: string;
  readonly cwd?: string;
  readonly clock?: Clock;
  readonly ids?: IdSource;
  readonly actor?: string;
}

export interface StartupReport {
  readonly recovered: { reapplied: number; discarded: number };
  readonly governance: GovernanceState;
  readonly degradedReasons: readonly string[];
}

export class ServaRuntime {
  readonly store: Store;
  readonly root: string;
  readonly clock: Clock;
  readonly ids: IdSource;
  readonly actor: string;
  private startup: StartupReport | undefined;
  private closed = false;

  private constructor(root: string, store: Store, deps: StoreDeps) {
    this.root = root;
    this.store = store;
    this.clock = deps.clock;
    this.ids = deps.ids;
    this.actor = deps.actor;
  }

  private static deps(opts: RuntimeOptions): StoreDeps {
    const clock = opts.clock ?? systemClock;
    return {
      clock,
      ids: opts.ids ?? new TimeOrderedIdSource(clock),
      actor: opts.actor ?? 'RUNTIME',
    };
  }

  /** Resolve the project root, or fail with an actionable message. */
  static resolveRoot(opts: RuntimeOptions): string {
    if (opts.root !== undefined) {
      return isAbsolute(opts.root) ? opts.root : resolve(opts.cwd ?? process.cwd(), opts.root);
    }
    const found = discoverProjectRoot(opts.cwd ?? process.cwd());
    if (found === undefined) {
      return fail({
        code: 'E_NOT_A_PROJECT',
        message: 'No Serva project found in this directory or any parent',
        remedy: 'Run `serva init <name>` here, or pass --root <path>.',
        details: { searchedFrom: opts.cwd ?? process.cwd() },
      });
    }
    return found;
  }

  static open(opts: RuntimeOptions = {}): ServaRuntime {
    const root = ServaRuntime.resolveRoot(opts);
    const deps = ServaRuntime.deps(opts);
    const store = Store.open(root, deps);
    const rt = new ServaRuntime(root, store, deps);
    rt.validateStartup();
    return rt;
  }

  static init(name: string, ideaText: string, opts: RuntimeOptions = {}): ServaRuntime {
    const root = opts.root === undefined ? (opts.cwd ?? process.cwd()) : resolve(opts.root);
    const deps = ServaRuntime.deps(opts);
    const p = storePaths(root);
    if (existsSync(p.serva)) {
      fail({
        code: 'E_PROJECT_EXISTS',
        message: 'A Serva project already exists at ' + root,
        remedy: 'Use `serva status` to inspect it, or initialize in a different directory.',
        details: { root },
      });
    }
    const store = Store.initialize(root, deps);
    const rt = new ServaRuntime(root, store, deps);

    const now = deps.clock.now();
    const project: Project = parseOrThrow(
      ProjectSchema,
      {
        id: deps.ids.next('SC-PROJ'),
        name,
        createdAt: now,
        // 03 §2 — the Idea is captured verbatim and never altered.
        idea: { text: ideaText, capturedAt: now, source: 'OWNER_STATED' },
        riskClass: 'R1',
        profile: 'PRF-NEW-PRODUCT',
        servaVersion: SERVA_VERSION,
      },
      'Project',
    );

    const tx = store.begin();
    tx.putCanon('project', project.id, project, { source: 'OWNER_STATED' });
    audit(tx, {
      action: AuditAction.PROJECT_INITIALIZED,
      subject: project.id,
      outcome: 'OK',
      detail: { name, root, servaVersion: SERVA_VERSION, specBaseline: SPEC_BASELINE },
    });
    tx.commit();

    rt.validateStartup();
    return rt;
  }

  /** 21 §6 / 22 §4.2 — recovery and reconciliation before anything else runs. */
  private validateStartup(): void {
    const recovered = this.store.recover();
    const degraded: string[] = [];

    for (const stream of this.store.listTraceStreams()) {
      const v = this.store.trace(stream).verify();
      if (!v.ok) degraded.push('trace stream "' + stream + '" broken: ' + v.detail);
    }

    const governance = degraded.length > 0 ? GovernanceState.DEGRADED : GovernanceState.ACTIVE;

    if (recovered.reapplied > 0 || recovered.discarded > 0) {
      const tx = this.store.begin();
      audit(tx, {
        action: AuditAction.STORE_RECOVERED,
        subject: this.root,
        outcome: 'OK',
        detail: { ...recovered },
      });
      tx.commit();
    }

    this.startup = { recovered, governance, degradedReasons: degraded };
  }

  get startupReport(): StartupReport {
    if (this.startup === undefined) {
      return fail({
        code: 'E_INTERNAL',
        message: 'Runtime was not validated at startup',
        remedy: 'Open the runtime through ServaRuntime.open or ServaRuntime.init.',
      });
    }
    return this.startup;
  }

  /** The single project in this store. Phase 2 is one project per root (21 PI-1). */
  project(): Project | undefined {
    const ids = this.store.listCanonIds('project');
    const first = ids[0];
    if (first === undefined) return undefined;
    return this.store.getCanon<Project>('project', first)?.body;
  }

  requireProject(): Project {
    const p = this.project();
    if (p === undefined) {
      return fail({
        code: 'E_NOT_A_PROJECT',
        message: 'Store at ' + this.root + ' contains no project record',
        remedy: 'The store may be damaged. Run `serva doctor`.',
        details: { root: this.root },
      });
    }
    return p;
  }

  get catalogues(): ReturnType<typeof getCatalogues> {
    return getCatalogues();
  }

  /** Graceful shutdown. No background work in Phase 2, so this is a state guard. */
  close(): void {
    this.closed = true;
  }

  get isClosed(): boolean {
    return this.closed;
  }
}
