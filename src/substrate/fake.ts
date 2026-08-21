import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { EnforcementClass } from '../vocab/index.js';
import { canonicalJson, digestOf } from '../core/hash.js';
import {
  EnforcementState,
  IsolationMethod,
  deriveEnforcementClass,
  type ExecuteRequest,
  type ExecuteResult,
  type ExecutionSubstrate,
  type QualificationResult,
  type SubstrateCapabilities,
  type SubstrateProbe,
  type SubstrateQualification,
} from './types.js';
import { QUALIFICATION_CASES } from './qualification.js';
import { BoundaryPurpose, executionBoundary, type ExecutionBoundary } from './boundary.js';
import type { Clock } from '../core/clock.js';

/**
 * A deterministic SIMULATION for the automated suite. **It is not a containment
 * boundary and must never be read as evidence of one.**
 *
 * The claim, stated precisely so nobody has to infer it:
 *
 *   IT DOES     check preconditions in-process before spawning — the working directory
 *               is resolved through symlinks and compared to the granted write scope,
 *               and a non-HARD configuration refuses outright. That makes the FACTORY
 *               above it testable against something that genuinely says no.
 *   IT DOES NOT contain anything. Once a child process starts it is an ordinary host
 *               process with the ordinary privileges of the test runner. It can write
 *               anywhere the test runner can write, open any socket, and spawn anything.
 *
 * So its qualification outcomes are DECLARED, not measured. A `PASSED` here means "this
 * fixture was configured to report a pass", which is a fact about the fixture and not
 * about any boundary. `probe().simulated` is true for exactly this reason, the detail
 * on every result says so in words, and `SubstrateQualification.fingerprint` carries a
 * simulated marker so a stored qualification cannot be mistaken for a real one later.
 *
 * The consequence, which the test suite is arranged around: **no test that claims to
 * prove containment may derive its evidence from this class.** Containment is proved by
 * `SandboxedExecutionSubstrate` against a real launcher, and on a machine that cannot
 * run one the honest report is BLOCKED rather than a green simulation.
 */

export interface SimulatedSubstrateOptions {
  readonly clock: Clock;
  /** What this fake should be able to prove. Tests use it to pin a substrate class. */
  readonly enforcement?: 'HARD' | 'SOFT' | 'NONE';
  readonly engineVersion?: string;
  /** Cases to force-fail, so a single broken dimension can be tested in isolation. */
  readonly failCases?: readonly string[];
  /**
   * The boundary identity this simulation reports.
   *
   * Supplied by orchestration tests so a simulated qualification can be matched against
   * a scripted engine's location. `simulated` is forced true whatever is passed: a
   * fixture does not get to describe itself as a measured boundary.
   */
  readonly boundary?: ExecutionBoundary;
}

export class SimulatedExecutionSubstrate implements ExecutionSubstrate {
  readonly id = 'simulated';
  private readonly enforcement: 'HARD' | 'SOFT' | 'NONE';
  /** Every execution attempted, so a test can assert on what was actually run. */
  readonly executed: ExecuteRequest[] = [];

  constructor(private readonly opts: SimulatedSubstrateOptions) {
    this.enforcement = opts.enforcement ?? 'HARD';
  }

  async probe(): Promise<SubstrateProbe> {
    return {
      substrateId: this.id,
      hostPlatform: 'fake',
      hostArch: 'fake',
      isolationMethod: IsolationMethod.SIMULATED,
      // The single flag every caller can branch on without reading this file.
      simulated: true,
      engineVersion: this.opts.engineVersion ?? '0.0.0-fake',
      prerequisites: [
        {
          id: 'FAKE_READY',
          what: 'the simulated substrate',
          why: 'It exists only for tests and has no external dependency.',
          remedy: 'none',
          satisfied: this.enforcement !== 'NONE',
        },
      ],
      observations: { enforcement: this.enforcement },
      probedAt: this.opts.clock.now(),
    };
  }

  async capabilities(): Promise<SubstrateCapabilities> {
    const hard = this.enforcement === 'HARD';
    const soft = this.enforcement === 'SOFT';
    const fs = hard || soft ? EnforcementState.ENFORCED : EnforcementState.NOT_ENFORCED;
    const os = hard ? EnforcementState.ENFORCED : EnforcementState.NOT_ENFORCED;
    return {
      filesystemEnforcement: fs,
      // A SOFT substrate constrains the model's own calls and not a child process,
      // which is precisely the distinction that makes it unusable for engineering.
      processEnforcement: os,
      networkEnforcement: os,
      credentialProtection: fs,
      hostEscapeProtection: os,
      canWrite: hard,
      canExecute: hard,
    };
  }

  async qualify(fixtureDir: string): Promise<SubstrateQualification> {
    const at = this.opts.clock.now();
    const capabilities = await this.capabilities();
    const forcedFailures = new Set(this.opts.failCases ?? []);

    const tests: QualificationResult[] = QUALIFICATION_CASES.map((c) => {
      if (forcedFailures.has(c.id)) {
        return {
          id: c.id,
          title: c.title,
          expectation: c.expectation,
          outcome: 'FAILED' as const,
          detail: 'SIMULATED: forced failure for this fixture. Nothing was contained.',
          blocking: c.blocking,
          at,
        };
      }
      if (this.enforcement === 'NONE') {
        return {
          id: c.id,
          title: c.title,
          expectation: c.expectation,
          outcome: 'NOT_RUN' as const,
          detail: 'SIMULATED: no boundary exists to test.',
          blocking: c.blocking,
          at,
        };
      }
      // A SOFT substrate genuinely fails the cases that need OS-level enforcement.
      const needsOsEnforcement =
        c.id === 'Q-F' || c.id === 'Q-I' || c.id === 'Q-J' || c.id === 'Q-K';
      if (this.enforcement === 'SOFT' && needsOsEnforcement) {
        return {
          id: c.id,
          title: c.title,
          expectation: c.expectation,
          outcome: 'FAILED' as const,
          detail:
            "A harness-level boundary governs the model's own tool calls and cannot constrain this.",
          blocking: c.blocking,
          at,
        };
      }
      return {
        id: c.id,
        title: c.title,
        expectation: c.expectation,
        outcome: 'PASSED' as const,
        detail:
          'SIMULATED: declared as refused by this fixture (' +
          fixtureDir +
          '). No process was contained and nothing was measured.',
        blocking: c.blocking,
        at,
      };
    });

    const derived = deriveEnforcementClass(tests, capabilities);
    return {
      probe: await this.probe(),
      capabilities,
      tests,
      ...derived,
      qualifiedAt: at,
      engineVersion: this.opts.engineVersion ?? '0.0.0-simulated',
      // Marked in the fingerprint itself, so a persisted qualification cannot later be
      // mistaken for a measurement of a real machine.
      fingerprint: digestOf(
        canonicalJson({ substrateId: this.id, simulated: true, enforcement: this.enforcement }),
      ),
      /*
       * A simulated boundary, marked as such in its own identity.
       *
       * `boundaryMismatch` compares `simulated`, so a qualification taken here can
       * never match a real engine's boundary — a simulation cannot accidentally
       * authorize a Producer no matter how the surrounding code is wired.
       */
      boundary:
        this.opts.boundary === undefined
          ? executionBoundary({
              boundaryId: 'SC-BOUNDARY-SIMULATED',
              purpose: BoundaryPurpose.RECIPE,
              transport: 'simulated',
              engineVersion: this.opts.engineVersion ?? '0.0.0-simulated',
              sandboxMechanism: 'simulated',
              simulated: true,
            })
          : executionBoundary({ ...this.opts.boundary, simulated: true }),
    };
  }

  /**
   * Execute, enforcing the write scope for real.
   *
   * The check resolves symlinks before comparing, because a boundary checked on the
   * path as written rather than as resolved is a boundary with a documented bypass.
   */
  async execute(request: ExecuteRequest): Promise<ExecuteResult> {
    this.executed.push(request);
    const startedAt = this.opts.clock.now();

    const refusal = this.refuse(request);
    if (refusal !== undefined) {
      return {
        exitCode: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        truncated: { stdout: false, stderr: false },
        startedAt,
        endedAt: this.opts.clock.now(),
        durationMs: 0,
        refusedBySubstrate: true,
        refusalReason: refusal,
      };
    }

    const began = Date.now();
    const r = await runChild(request);
    return {
      ...r,
      startedAt,
      endedAt: this.opts.clock.now(),
      durationMs: Date.now() - began,
      refusedBySubstrate: false,
    };
  }

  private refuse(request: ExecuteRequest): string | undefined {
    if (this.enforcement !== 'HARD') {
      return (
        'Substrate enforcement is ' +
        this.enforcement +
        '; engineering execution requires HARD (33 PC-5).'
      );
    }
    if (request.networkAllowed) {
      return undefined; // an explicit grant, which the caller had to justify
    }
    if (!withinAny(request.cwd, request.writeScope)) {
      return 'Working directory ' + request.cwd + ' is outside the granted write scope.';
    }
    return undefined;
  }

  async explain(): Promise<string> {
    return [
      'Simulated substrate (' + this.enforcement + ').',
      'It enforces write scope in-process, resolving symlinks before comparing, so',
      'containment tests above it are testing a boundary that genuinely refuses.',
      'It cannot constrain an arbitrary running child process, and does not claim to:',
      'a SOFT configuration reports the OS-level cases as FAILED rather than skipping them.',
    ].join('\n');
  }
}

/** Is `candidate` inside one of `roots`, after resolving symlinks on both sides? */
export function withinAny(candidate: string, roots: readonly string[]): boolean {
  const real = safeRealpath(candidate);
  return roots.some((r) => {
    const root = safeRealpath(r);
    if (real === root) return true;
    return real.startsWith(root.endsWith(sep) ? root : root + sep);
  });
}

/**
 * `realpathSync` on a path that does not exist yet throws, and a write target usually
 * does not exist yet. Resolve the deepest existing ancestor instead, so a symlinked
 * parent is still followed.
 */
export function safeRealpath(p: string): string {
  let current = resolve(p);
  const trailing: string[] = [];
  for (;;) {
    if (existsSync(current)) {
      try {
        return resolve(realpathSync(current), ...trailing.reverse());
      } catch {
        return current;
      }
    }
    const parent = resolve(current, '..');
    if (parent === current) return resolve(p);
    trailing.push(current.slice(parent.length + 1));
    current = parent;
  }
}

async function runChild(
  request: ExecuteRequest,
): Promise<Omit<ExecuteResult, 'startedAt' | 'endedAt' | 'durationMs' | 'refusedBySubstrate'>> {
  return new Promise((resolveP) => {
    let stdout = '';
    let stderr = '';
    let outTrunc = false;
    let errTrunc = false;
    let timedOut = false;
    let settled = false;

    const child = spawn(request.executable, [...request.args], {
      cwd: request.cwd,
      // No shell. There is nothing for an argument to escape into.
      shell: false,
      windowsHide: true,
      env: { ...request.env },
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, request.timeoutMs);

    const cap = (chunk: string, current: string, truncated: boolean): [string, boolean] => {
      if (truncated) return [current, true];
      const next = current + chunk;
      if (next.length > request.maxOutputBytes) {
        return [next.slice(0, request.maxOutputBytes), true];
      }
      return [next, false];
    };

    child.stdout?.on('data', (d: Buffer) => {
      [stdout, outTrunc] = cap(d.toString('utf8'), stdout, outTrunc);
    });
    child.stderr?.on('data', (d: Buffer) => {
      [stderr, errTrunc] = cap(d.toString('utf8'), stderr, errTrunc);
    });
    child.on('error', (e: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveP({
        exitCode: null,
        stdout,
        stderr: stderr + '\n' + e.message,
        timedOut,
        truncated: { stdout: outTrunc, stderr: errTrunc },
      });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveP({
        exitCode: code,
        stdout,
        stderr,
        timedOut,
        truncated: { stdout: outTrunc, stderr: errTrunc },
      });
    });
  });
}

/** A disposable fixture directory for a qualification run. */
export function makeFixtureDir(prefix = 'serva-qual-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function writeFixtureFile(dir: string, name: string, content: string): string {
  const p = join(dir, name);
  writeFileSync(p, content, 'utf8');
  return p;
}

export function removeFixtureDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/** A substrate that refuses everything. The safe default when nothing is qualified. */
export function unqualifiedSubstrate(clock: Clock): SimulatedExecutionSubstrate {
  return new SimulatedExecutionSubstrate({ clock, enforcement: 'NONE' });
}

export { EnforcementClass };
