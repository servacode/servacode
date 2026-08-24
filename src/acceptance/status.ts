import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SERVA_VERSION } from '../portability/version.js';
import { ACCEPTANCE_LINES, REQUIREMENTS, requirementsFor } from './requirements.js';
import { ProofStatus, resolveProof } from './proof.js';
import type { RepositoryIdentity, ResolvedProof, RunResolver } from './proof.js';
import type { Requirement } from './requirements.js';

/**
 * SERVA CODE 1.0 — THE STATUS SERVA ISSUES ABOUT ITSELF.
 *
 * SPEC: Phase 6 closure §1; §59, §63.
 *
 * The previous version of this file read prose. `Independent reviewer: Jane Roe` in a
 * markdown file produced a green Security Acceptance; `RESULT: ACCEPTED` in a text file
 * produced a green Live Acceptance; three phrases in a walkthrough produced a green
 * Portability. An independent audit found all three — and my own test suite had proved that
 * a synthetic file passed. I wrote that test believing it strengthened something.
 *
 * That was a category error rather than a parsing bug. A file somebody can edit is not an
 * authority boundary however carefully it is parsed, and EVIDENCE FILE TEXT IS NOT
 * AUTHORITY.
 *
 * Nothing here reads prose. Every line is the conjunction of the REQUIREMENTS that roll up
 * to it, and every requirement resolves a typed proof against the world: the exact commit
 * and git tree re-derived from the repository, every cited file re-digested, and for a
 * judged or live proof a real AgentRun that has to resolve in a real store.
 *
 * The summary stays a conjunction. If one mandatory requirement is unproven, `READY FOR
 * OWNER USE` is not printed — not in yellow, not with an asterisk.
 */

export const AcceptanceState = {
  PASS: 'PASS',
  /** Measured and failing. */
  FAIL: 'FAIL',
  /** Nothing resolvable establishes it. Blocks, and reads differently from FAIL. */
  NOT_VERIFIED: 'NOT_VERIFIED',
} as const;
export type AcceptanceState = (typeof AcceptanceState)[keyof typeof AcceptanceState];

export interface RequirementStatus {
  readonly id: string;
  readonly requirement: string;
  readonly expects: string;
  readonly mandatory: boolean;
  readonly state: AcceptanceState;
  /** The proof that established it, or why none did. */
  readonly resolution: ResolvedProof;
  readonly implementation?: string;
  readonly limitation?: string;
}

export interface AcceptanceLine {
  readonly label: string;
  readonly state: AcceptanceState;
  /** Every requirement under this line. A line is the conjunction of them. */
  readonly requirements: readonly RequirementStatus[];
  readonly detail: string;
}

export interface AcceptanceStatus {
  readonly servaVersion: string;
  readonly repository?: RepositoryIdentity;
  readonly lines: readonly AcceptanceLine[];
  readonly requirements: readonly RequirementStatus[];
  readonly readyForOwnerUse: boolean;
  readonly notProven: readonly string[];
  readonly rendered: string;
}

export interface StatusOptions {
  readonly root?: string;
  /** Overridden in tests; read from git otherwise. */
  readonly repository?: RepositoryIdentity;
  readonly resolveRun?: RunResolver;
  readonly implementationProducers?: readonly string[];
}

/**
 * The commit and tree this package actually is.
 *
 * Read from git rather than from any file in the package, because the whole point is that a
 * proof is checked against the world instead of against its own claims. Where git is
 * unavailable the identity is unknown and every proof fails to bind — which is correct: a
 * package nobody can locate in history is one whose proofs are tied to nothing.
 */
export function repositoryIdentity(root: string): RepositoryIdentity | undefined {
  const git = (args: readonly string[]): string | undefined => {
    try {
      const out = execFileSync('git', [...args], {
        cwd: root,
        encoding: 'utf8',
        timeout: 15_000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      return out === '' ? undefined : out;
    } catch {
      return undefined;
    }
  };
  const commit = git(['rev-parse', 'HEAD']);
  const tree = git(['rev-parse', 'HEAD^{tree}']);
  if (commit === undefined || tree === undefined) return undefined;
  return { commit, tree };
}

/**
 * Resolve a run id in a store on disk.
 *
 * Used when a caller supplies no resolver. It reads the terminal record the AgentRun
 * projection writes, so a run that never terminated does not resolve — the correct answer
 * for a proof that cites it.
 */
export function defaultRunResolver(root: string): RunResolver {
  return (ref) => {
    const dir = join(root, ref.storePath, 'canon', 'agentRunRecord', ref.runId);
    if (!existsSync(dir)) return undefined;
    try {
      const head = readFileSync(join(dir, 'HEAD'), 'utf8').trim();
      const envelope = JSON.parse(readFileSync(join(dir, head + '.json'), 'utf8')) as {
        body?: { agentId?: string; outcome?: string };
      };
      return envelope.body;
    } catch {
      return undefined;
    }
  };
}

function stateOf(resolution: ResolvedProof, expects: string): AcceptanceState {
  if (resolution.status === ProofStatus.FAIL) return AcceptanceState.FAIL;
  if (resolution.status !== ProofStatus.PASS) return AcceptanceState.NOT_VERIFIED;
  /*
   * A weaker kind of proof does not satisfy a stronger requirement. A DETERMINISTIC proof
   * offered where a LIVE one is required is not a partial pass — it is evidence about a
   * different question.
   */
  return resolution.verificationType === expects
    ? AcceptanceState.PASS
    : AcceptanceState.NOT_VERIFIED;
}

/** Compute Serva's own acceptance status from resolvable proofs alone. */
export function acceptanceStatus(o: StatusOptions | string = {}): AcceptanceStatus {
  const opts: StatusOptions = typeof o === 'string' ? { root: o } : o;
  const root = opts.root ?? process.cwd();
  const repository = opts.repository ?? repositoryIdentity(root);
  const resolveRun = opts.resolveRun ?? defaultRunResolver(root);

  const requirements: RequirementStatus[] = REQUIREMENTS.map((r: Requirement) => {
    const base = resolveProof(r.id, {
      root,
      ...(repository === undefined ? {} : { repository }),
      resolveRun,
      ...(opts.implementationProducers === undefined
        ? {}
        : { implementationProducers: opts.implementationProducers }),
    });
    const wrongKind =
      base.status === ProofStatus.PASS && base.verificationType !== r.expects;
    const resolution: ResolvedProof = wrongKind
      ? {
          ...base,
          refusals: [
            ...base.refusals,
            'the proof is ' + base.verificationType + ' and this requirement needs ' + r.expects,
          ],
        }
      : base;
    return {
      id: r.id,
      requirement: r.requirement,
      expects: r.expects,
      mandatory: r.mandatory,
      state: stateOf(base, r.expects),
      resolution,
      ...(r.implementation === undefined ? {} : { implementation: r.implementation }),
      ...(r.limitation === undefined ? {} : { limitation: r.limitation }),
    };
  });

  const byId = new Map(requirements.map((r) => [r.id, r]));

  const lines: AcceptanceLine[] = ACCEPTANCE_LINES.map((label) => {
    const under = requirementsFor(label)
      .map((r) => byId.get(r.id))
      .filter((r): r is RequirementStatus => r !== undefined);
    const failed = under.filter((r) => r.state === AcceptanceState.FAIL);
    const unproven = under.filter((r) => r.state === AcceptanceState.NOT_VERIFIED);
    const state =
      under.length === 0
        ? AcceptanceState.NOT_VERIFIED
        : failed.length > 0
          ? AcceptanceState.FAIL
          : unproven.length > 0
            ? AcceptanceState.NOT_VERIFIED
            : AcceptanceState.PASS;
    return {
      label,
      state,
      requirements: under,
      detail:
        under.length === 0
          ? 'no requirement rolls up to this line'
          : state === AcceptanceState.PASS
            ? String(under.length) + '/' + String(under.length) + ' proven'
            : String(under.length - unproven.length - failed.length) +
              '/' +
              String(under.length) +
              ' proven — ' +
              [...failed, ...unproven].map((r) => r.id).join(', '),
    };
  });

  const mandatory = requirements.filter((r) => r.mandatory);
  const notProven = mandatory
    .filter((r) => r.state !== AcceptanceState.PASS)
    .map((r) => r.id + ' (' + r.state + ': ' + (r.resolution.refusals[0] ?? 'unproven') + ')');

  const width = 30;
  const rendered = [
    'SERVA CODE ' + SERVA_VERSION,
    repository === undefined
      ? 'commit  (git identity unavailable — no proof can bind to this tree)'
      : 'commit  ' + repository.commit.slice(0, 12) + '   tree ' + repository.tree.slice(0, 12),
    '',
    ...lines.map((l) => l.label.padEnd(width, '.') + ' ' + l.state.padEnd(14) + l.detail),
    '',
    notProven.length === 0
      ? 'READY FOR OWNER USE'
      : 'NOT READY — ' +
        String(notProven.length) +
        ' of ' +
        String(mandatory.length) +
        ' mandatory requirement(s) are not proven:',
    ...notProven.map((n) => '  - ' + n),
  ].join('\n');

  return {
    servaVersion: SERVA_VERSION,
    ...(repository === undefined ? {} : { repository }),
    lines,
    requirements,
    readyForOwnerUse: notProven.length === 0,
    notProven,
    rendered,
  };
}
