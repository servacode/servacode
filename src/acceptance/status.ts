import { qualificationForRun } from '../substrate/qualificationRecord.js';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { SERVA_VERSION } from '../portability/version.js';
import { ACCEPTANCE_LINES, REQUIREMENTS, requirementsFor } from './requirements.js';
import { ProofStatus, resolveProof } from './proof.js';
import type {
  ContainmentVerdict,
  SecurityAssessment,
  RepositoryIdentity,
  ResolvedProof,
  RunRef,
  RunResolver,
} from './proof.js';
import type { Requirement } from './requirements.js';
import type { LiveEngineeringInput } from './liveProof.js';
import { systemClock } from '../core/clock.js';
import { TimeOrderedIdSource } from '../core/ids.js';
import { Store } from '../store/store.js';
import { listChangeSets } from '../engineering/changeset.js';
import {
  assessProducerContainment,
  assessVerificationBlock,
  resolveLiveEngineering,
  resolveLiveServa,
} from './liveProof.js';
import { ExecutionAvailability, QualificationAttempt } from '../substrate/types.js';
import { implementationProducersFrom, reviewerAuthorityOf } from './reviewAuthority.js';
import { aggregateSecurityReview } from './securityAggregate.js';
import { ContractRegistry } from '../agents/registry.js';

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
  /** The project store, when the caller already holds one open. */
  readonly store?: Store;
  readonly assessContainment?: (ref: RunRef) => ContainmentVerdict | undefined;
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
    /*
     * READ THE STORE THE WAY THE STORE WRITES IT.
     *
     * Two defects lived here, and both made a REAL governed run look like it had never
     * happened — the one direction this model must never fail in. The canonical matrix
     * refused LIVE proofs whose chains the live verifier had already resolved, which is how
     * they surfaced.
     *
     *   It read a `HEAD` file naming the current version. The Store has never written one:
     *   `grep -rn "'HEAD'" src/store/store.ts` returns nothing. Records are `v1.json`,
     *   `v2.json`, … so every lookup threw and every run resolved to `undefined`.
     *
     *   It joined `root` with `ref.storePath` unconditionally. A live fixture lives outside
     *   the repository by design, so an absolute path became `D:\SEVACODE\D:SEVACODEout…`.
     *
     * Neither had a test. Both are now covered, including the case that must still fail: a
     * run that genuinely does not exist still resolves to nothing.
     */
    const base = isAbsolute(ref.storePath) ? ref.storePath : join(root, ref.storePath);

    /*
     * A store path may name the project root or the `.serva` directory inside it. Both are
     * written by real tooling, so both are accepted rather than one being declared correct.
     */
    for (const dir of [
      join(base, 'canon', 'agentRunRecord', ref.runId),
      join(base, '.serva', 'canon', 'agentRunRecord', ref.runId),
    ]) {
      if (!existsSync(dir)) continue;
      try {
        /* Highest version wins: it is the current state of an append-only record. */
        const latest = readdirSync(dir)
          .filter((f) => /^v\d+\.json$/.test(f))
          .sort((a, b) => Number.parseInt(b.slice(1), 10) - Number.parseInt(a.slice(1), 10))[0];
        if (latest === undefined) continue;
        const envelope = JSON.parse(readFileSync(join(dir, latest), 'utf8')) as {
          body?: { agentId?: string; outcome?: string };
        };
        if (envelope.body !== undefined) return envelope.body;
      } catch {
        /* An unreadable record is an unresolved run, never a resolved one. */
        return undefined;
      }
    }
    return undefined;
  };
}

/**
 * Open a store somebody else wrote, without touching it.
 *
 * Read-only by intent rather than by enforcement: nothing on this path calls `transaction`.
 * The deps a `Store` requires are only ever consulted on write, so a real clock and id source
 * are supplied to satisfy the constructor and are never used.
 */
function openStoreAt(storePath: string): Store | undefined {
  const base = isAbsolute(storePath) ? storePath : join(process.cwd(), storePath);
  for (const root of [base, dirname(base)]) {
    if (!existsSync(join(root, '.serva', 'canon'))) continue;
    try {
      const clock = systemClock;
      return new Store(root, { clock, ids: new TimeOrderedIdSource(clock), actor: 'acceptance' });
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * RE-DERIVE CONTAINMENT FROM THE STORE, NEVER FROM THE PROOF.
 *
 * SPEC: Phase 6 Producer evidence-violation semantics (locked).
 *
 * A LIVE-ENGINEERING proof whose Producer ended in an evidence violation may still resolve —
 * but only on this answer, computed here by the same `assessProducerContainment` the live
 * chain verifier uses. The proof document's own account of its containment is not read, and
 * could not be trusted if it were: `"contained": true` in a file is a claim about evidence,
 * and this whole model exists because claims about evidence are not evidence.
 *
 * The ChangeSet is found by the Producer run that produced it. Naming it in the proof would
 * hand the document a say in which evidence gets assessed, which is the same defect wearing
 * a different hat.
 */
export function defaultContainmentAssessor(): (ref: RunRef) => ContainmentVerdict | undefined {
  return (ref) => {
    const store = openStoreAt(ref.storePath);
    if (store === undefined) return undefined;
    try {
      const changeSet = listChangeSets(store).find((c) => c.producerRunId === ref.runId);
      if (changeSet === undefined) return undefined;

      /*
       * WHICH QUESTION TO ASK DEPENDS ON HOW THE RUN ENDED, AND THE STORE DECIDES THAT TOO.
       *
       * The outcome is read from the terminal record rather than taken from the caller, so a
       * proof cannot select the more forgiving assessment by describing itself differently.
       */
      const outcome = store.getCanon<{ outcome?: string }>('agentRunRecord', ref.runId)?.body
        ?.outcome;

      if (outcome === 'PARTIAL') {
        const block = assessVerificationBlock(store, ref.runId, changeSet.changeSetId);
        return {
          contained: block.contained,
          producerOutcome: block.producerOutcome,
          reasons: block.reasons,
        };
      }
      return assessProducerContainment(store, ref.runId, changeSet.changeSetId);
    } catch {
      /* An unreadable store decides nothing, and deciding nothing is a refusal. */
      return undefined;
    }
  };
}

/**
 * The agents that produced this project's implementation, from its own governed history.
 *
 * Opened read-only and best-effort: a package shipped without its store still resolves every
 * DETERMINISTIC proof, and a JUDGED one then finds an empty producer set — which is honest.
 * It does not mean "nobody produced this"; it means this package carries no history to
 * check against, and the authority check below still has to pass on its own.
 */
function producersFromProject(root: string, store?: Store): ReadonlySet<string> {
  if (store !== undefined) return implementationProducersFrom(store);
  try {
    if (!existsSync(join(root, '.serva', 'canon'))) return new Set();
    const clock = systemClock;
    const opened = new Store(root, {
      clock,
      ids: new TimeOrderedIdSource(clock),
      actor: 'acceptance',
    });
    return implementationProducersFrom(opened);
  } catch {
    return new Set();
  }
}

/**
 * RE-DERIVE THE SECURITY REVIEW, FROM THE SAME MACHINERY THAT MINTED IT.
 *
 * SPEC: HIGH finding SERVA-SELF-ACCEPTANCE-AUTHORITY/SC-SSA-REV-F1.
 *
 * `resolveProof` re-derived who reviewed and then trusted `proof.status` for what they found,
 * so a hand-authored PASS over a CRITICAL resolved green. The only thing preventing that was a
 * minting script declining to write the file — a trustworthy writer guarding an untrustworthy
 * resolver, which is the inversion this model exists to prevent.
 *
 * This calls `aggregateSecurityReview` rather than re-implementing its rules, so there is one
 * definition of a clean security review and the resolver and the writer cannot drift apart.
 * Its refusals are returned verbatim: coverage, commit binding, run re-resolution, reviewer
 * authority and unresolved blockers are all already its job.
 */
function defaultSecurityAssessor(
  repository: RepositoryIdentity | undefined,
): (ref: RunRef) => SecurityAssessment | undefined {
  return (ref) => {
    if (repository === undefined) return undefined;
    const store = openStoreAt(ref.storePath);
    if (store === undefined) return undefined;
    try {
      const outcome = aggregateSecurityReview({
        store,
        repository,
        registry: ContractRegistry.shared(),
        reviewedAt: new Date().toISOString(),
        storePath: ref.storePath,
      });
      return { refusals: outcome.refusals };
    } catch {
      /* An unreadable review establishes nothing, which is a refusal rather than a pass. */
      return undefined;
    }
  };
}

/**
 * RE-DERIVE THE GOVERNED CHAIN A LIVE PROOF RESTS ON.
 *
 * SPEC: Phase 6 bounded writer-vs-resolver sweep.
 *
 * `prove-live.mjs` refuses to mint unless `resolveLiveEngineering` finds the whole chain, and
 * `resolveProof` re-derived none of it — it confirmed the named run resolved and took the rest
 * from the document. A hand-authored LIVE proof naming any real COMPLETED run resolved green
 * with no ChangeSet, no review and no accepted commit anywhere in the store.
 *
 * This calls the same resolver rather than restating its rules, so the writer and the resolver
 * cannot drift apart.
 *
 * WHAT THIS STILL CANNOT DO, stated rather than papered over: the machine fingerprint is taken
 * from the proof for both sides of its own comparison, because nothing can re-measure after
 * the fact the machine a past run happened on. What IS re-derived is everything a forged proof
 * would lack — the ChangeSet bound to that producer run, the measured evidence, an independent
 * authorised reviewer, the engineering gate, and an accepted commit that exists in git.
 */
/**
 * How each LIVE requirement is re-derived. Exhaustive by construction.
 *
 * SPEC: HIGH finding SERVA-SELF-ACCEPTANCE-AUTHORITY/SC-SSA-REV-LIVE-SERVA.
 *
 * The previous assessor took `requirementId` and ignored it, calling `resolveLiveEngineering`
 * for everything — so LIVE-SERVA was gated by LIVE-ENGINEERING's semantics and its
 * distinguishing content, that an OWNER REQUEST caused the work, went unverified.
 *
 * A table rather than a switch with a default, because a permissive default is precisely how
 * that happened. A LIVE requirement added later and not named here is refused, loudly, by a
 * test that reads the requirement catalogue.
 */
export const LIVE_ASSESSORS: Readonly<
  Record<string, (store: Store, ref: RunRef) => readonly string[]>
> = Object.freeze({
  'LIVE-ENGINEERING': (store, ref) =>
    resolveLiveEngineering(liveInput(store, ref)).refusals.map((r) => r.detail),
  /*
   * The whole-product join. `resolveLiveServa` resolves the engineering half by calling the
   * function above and adds the front of the chain — the owner's request, recorded verbatim,
   * and the governed runs it caused — which is the only thing that distinguishes this
   * requirement from the one above it.
   */
  'LIVE-SERVA': (store, ref) =>
    resolveLiveServa({ ...liveInput(store, ref), companyStore: store }).refusals.map(
      (r) => r.detail,
    ),
});

/**
 * The inputs both live resolvers share.
 *
 * WHAT THIS CANNOT DO, stated rather than assumed: the machine fingerprint is supplied to both
 * sides of its own comparison, because nothing can re-measure after the fact the machine a
 * past run happened on. Everything else — the ChangeSet bound to that producer run, the
 * measured evidence, an independent authorised reviewer, the gate, an accepted commit that
 * exists in git, and for LIVE-SERVA the owner request in front of all of it — is re-derived.
 */
function liveInput(store: Store, ref: RunRef): LiveEngineeringInput {
  const fingerprint = 'resolver-does-not-remeasure';

  /*
   * THE QUALIFICATION IS READ, NOT SUPPLIED.
   *
   * SPEC: finding SERVA-SELF-ACCEPTANCE-AUTHORITY/SC-SSA-REV-Q1 (MEDIUM), 1.0.1 security review.
   *
   * This handed `MEASURED / HARD / AVAILABLE` to the resolver as literals, which made the
   * QUALIFICATION branch of `resolveLiveEngineering` — the one enforcing that a Producer ran
   * under a measured HARD boundary — permanently inert on the only path `acceptanceStatus`
   * drives. The comment above even listed what could not be re-derived and named only the
   * fingerprint, while the fabricated qualification sat beside it unmentioned.
   *
   * READ BY RUN, NOT BY RECENCY.
   *
   * The first fix here read `lastValidQualification`, which answers "what did this machine
   * most recently measure" — and the question is "what did THAT Producer run under". Those
   * come apart the moment anything measures again, and they did: running
   * `serva engineering doctor` against a preserved live store wrote a fresh measurement hours
   * after the run it was being used to judge, so a proof reading it would have credited a
   * later measurement to an earlier run. A historical HARD is not evidence that a particular
   * execution happened inside one.
   *
   * `qualificationForRun` is written at dispatch against the run id, so nothing measured
   * afterwards can move it.
   *
   * `recordRunQualification` is the persisted measurement for this run, and
   * `recordQualification` writes one ONLY for a MEASURED attempt — so its existence is the
   * evidence that a measurement happened, and its class is what was measured.
   *
   * When there is none, NOTHING is supplied. The resolver then refuses for want of a
   * qualification, which is the correct answer: a machine that never measured its boundary has
   * not shown a Producer ran inside one.
   */
  const measured = qualificationForRun(store, ref.runId);

  return {
    store,
    repoRoot: store.paths.root,
    machineFingerprint: fingerprint,
    recordedFingerprint: fingerprint,
    ...(measured === undefined
      ? {}
      : {
          qualification: {
            attempt: QualificationAttempt.MEASURED,
            availability: ExecutionAvailability.AVAILABLE,
            enforcementClass: measured.enforcementClass,
          },
        }),
    hints: { producerRunId: ref.runId },
  } as LiveEngineeringInput;
}

/**
 * RE-DERIVE THE GOVERNED CHAIN A LIVE PROOF RESTS ON — THE RIGHT ONE FOR THE REQUIREMENT.
 *
 * `prove-live.mjs` refuses to mint unless the whole chain resolves, and `resolveProof`
 * re-derived none of it until the writer-vs-resolver sweep. This closes the second half of
 * that fix: which chain gets re-derived is decided by the requirement, not by whichever
 * resolver happened to be wired first.
 */
export function defaultLiveChainAssessor(): (
  ref: RunRef,
  requirementId: string,
) => SecurityAssessment | undefined {
  return (ref, requirementId) => {
    const assessor = LIVE_ASSESSORS[requirementId];
    if (assessor === undefined) {
      return {
        refusals: [
          requirementId +
            ' has no canonical live resolver, so its chain cannot be re-derived; a LIVE ' +
            "requirement must not inherit another requirement's semantics by default",
        ],
      };
    }
    const store = openStoreAt(ref.storePath);
    if (store === undefined) return undefined;
    try {
      return { refusals: assessor(store, ref) };
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
  const assessContainment = opts.assessContainment ?? defaultContainmentAssessor();
  const assessSecurityReview = defaultSecurityAssessor(repository);
  const assessLiveChain = defaultLiveChainAssessor();

  /*
   * INDEPENDENCE IS ENFORCED HERE, NOT WHEN A CALLER REMEMBERS TO ASK FOR IT.
   *
   * SPEC: finding SSA-1 (HIGH), from the independent security review.
   *
   * `resolveProof` refused a non-independent reviewer only when `implementationProducers`
   * arrived, and this function never sent one. The guard gating READY FOR OWNER USE was
   * therefore inert on the only path anyone runs, while every test passed because each one
   * supplied the list by hand.
   *
   * A check that works in tests and not in production is worse than no check: it produces the
   * documentation and the confidence of enforcement without the enforcement. So the producer
   * set is now DERIVED from governed execution history in this project's own store, and a
   * caller-supplied list can only narrow the question, never invent an answer.
   */
  const implementationProducers = opts.implementationProducers ?? [
    ...producersFromProject(root, opts.store),
  ];

  const requirements: RequirementStatus[] = REQUIREMENTS.map((r: Requirement) => {
    const base = resolveProof(r.id, {
      root,
      ...(repository === undefined ? {} : { repository }),
      resolveRun,
      assessContainment,
      implementationProducers,
      reviewerAuthority: (agentId) => reviewerAuthorityOf(agentId, ContractRegistry.shared()),
      assessSecurityReview,
      assessLiveChain,
    });
    const wrongKind = base.status === ProofStatus.PASS && base.verificationType !== r.expects;
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
