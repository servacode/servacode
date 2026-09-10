import { execFileSync } from 'node:child_process';
import { EnforcementClass } from '../vocab/index.js';
import { QualificationAttempt } from '../substrate/types.js';

import { readAudit } from '../events/audit.js';
import { listChangeSets, readChangeSet } from '../engineering/changeset.js';
import { listReviews } from '../engineering/review.js';
import { listEvidence } from '../engineering/execution.js';
import { runStream } from '../events/agentRun.js';
import { RoleAuthority, actorRefusal } from '../core/actorAuthority.js';
import { ContractRegistry } from '../agents/registry.js';
import type { Store } from '../store/store.js';
import type { SubstrateQualification } from '../substrate/types.js';

/**
 * LIVE EVIDENCE, RESOLVED FROM WHAT ACTUALLY HAPPENED.
 *
 * SPEC: Phase 6 final acceptance sequence §2.
 *
 * The live suites now reach real governed execution: a Producer run, a ChangeSet, deterministic
 * checks, an independent Reviewer, an Engineering Gate and an accepted commit. That is exactly
 * the moment the temptation appears — write down the ids, mint a PASS, move on.
 *
 * A caller must not be able to produce
 *
 *   LIVE PASS + an invented run id + an invented fingerprint
 *
 * so nothing here trusts an id. **Caller-provided ids are lookup hints, not authority.** Every
 * one is resolved against the Store, the trace and Git, and then checked to belong to the SAME
 * execution as all the others — because six real ids from six different runs would otherwise
 * assemble into a chain that never existed.
 *
 * THE MACHINE IS THE EXCEPTION, AND SAYING SO IS THE POINT.
 *
 * SPEC: finding SSA-RLC-1 (MEDIUM), 1.0.1 security review.
 *
 * This paragraph used to say "and this machine". The MACHINE check compares two fields the
 * caller supplied against each other, and on the acceptance path both are the literal
 * `resolver-does-not-remeasure`: nothing can re-measure, after the fact, the machine a past
 * run happened on. `status.ts` has always said that plainly where it supplies them; this
 * header claimed more than the function does, which is how a reader comes to believe a
 * comparison was made that was not.
 *
 * What IS re-derived is everything else, and it is not little: the ChangeSet bound to that
 * producer run, the measured evidence, an independent authorised reviewer, the gate, an
 * accepted commit that exists in git, and for LIVE-SERVA the owner request in front of it.
 *
 * The checks are ordered cheapest-first only where that does not change the answer. Each one
 * exists because skipping it admits a specific lie, and the comment on each says which.
 */

/**
 * Read a run's TERMINAL record, without projecting its event log.
 *
 * `projectAgentRun` rebuilds a run from its stream and throws when there is no stream, which
 * is the wrong shape for an acceptance check twice over: an absent run is a REFUSAL rather
 * than an exception, and the durable artifact — the one that survives a restart and the one
 * `serva acceptance` already resolves — is the terminal record itself.
 */
function terminalRun(
  store: Store,
  runId: string,
): { readonly agentId?: string; readonly outcome?: string } | undefined {
  try {
    const body = store.getCanon<{ agentId?: string; outcome?: string }>(
      'agentRunRecord',
      runId,
    )?.body;
    return body ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Outcomes that mean no work exists to accept.
 *
 * Named as a set rather than "anything but COMPLETED", because the interesting case sits
 * between the two: a run can produce a real, checkable change AND misreport what it did.
 */
const PRODUCED_NOTHING: ReadonlySet<string> = new Set([
  'FAILED',
  'REFUSED',
  'BLOCKED',
  'INVALID_OUTPUT',
  'SCOPE_VIOLATION',
]);

/** A trace record's payload, without asserting a shape the stream does not guarantee. */
function payloadOf(entry: { readonly payload?: unknown }): Record<string, unknown> {
  return (entry.payload ?? {}) as Record<string, unknown>;
}

export interface LiveRefusal {
  readonly check: string;
  readonly detail: string;
}

export interface LiveEngineeringChain {
  readonly workItemId: string;
  readonly producerRunId: string;
  readonly producerAgentId: string;
  /**
   * How the Producer's run ended.
   *
   * Carried so a reader cannot miss it. `EVIDENCE_VIOLATION` here means the agent
   * misrepresented its own work and Serva caught it; the change was accepted on measured
   * evidence and an independent review, not on the agent's account of itself.
   */
  readonly producerOutcome: string;
  /**
   * The analysis of the Producer's claim integrity.
   *
   * Present whatever the outcome, so a reader can see that a violation happened AND that it
   * was contained. Recording only the clean case would make the honest one invisible.
   */
  readonly containment: ProducerContainment;
  readonly reviewerRunId: string;
  readonly reviewerAgentId: string;
  readonly changeSetId: string;
  readonly acceptedCommit: string;
  readonly checkIds: readonly string[];
  readonly machineFingerprint: string;
}

export interface LiveResolution<T> {
  readonly resolved: boolean;
  readonly chain?: T;
  readonly refusals: readonly LiveRefusal[];
}

export interface LiveEngineeringInput {
  /** The store the live run actually wrote to. */
  readonly store: Store;
  /** The git repository the accepted commit should exist in. */
  readonly repoRoot: string;
  /** This machine, measured now. */
  readonly machineFingerprint: string;
  /**
   * The qualification in force for the run, as MEASURED.
   *
   * SPEC: finding SC-SSA-REV-Q1 (MEDIUM), 1.0.1 review.
   *
   * Optional because a machine that never measured its boundary has none to report, and the
   * resolver must be able to say so. It was required, so every caller satisfied it with a
   * literal and the guard below could never fail.
   */
  readonly qualification?: SubstrateQualification;
  /** The fingerprint recorded when the run happened. */
  readonly recordedFingerprint: string;
  /** Lookup hints. Never authority. */
  readonly hints?: {
    readonly producerRunId?: string;
    readonly reviewerRunId?: string;
    readonly changeSetId?: string;
    readonly acceptedCommit?: string;
  };
  /** Overridden in tests; asks git whether a commit exists. */
  readonly commitExists?: (repoRoot: string, commit: string) => boolean;
}

/** Does this commit exist in this repository? Asked of git, never of a record. */
export function gitCommitExists(repoRoot: string, commit: string): boolean {
  try {
    execFileSync('git', ['cat-file', '-e', commit + '^{commit}'], {
      cwd: repoRoot,
      stdio: ['ignore', 'ignore', 'ignore'],
      timeout: 15_000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * PRODUCER CLAIM INTEGRITY IS A DIFFERENT QUESTION FROM CHANGE ENGINEERING VALIDITY.
 *
 * SPEC: Phase 6 live Producer evidence-violation semantics.
 *
 * The first real live run ended `EVIDENCE_VIOLATION`: the Producer asserted it had attempted
 * to run the test suite, Serva's own verifier CONTRADICTED that against the run's event log,
 * and the change was still accepted. Nothing was wrong with the acceptance — the code was
 * measured by runtime components and judged by an independent reviewer, and the Producer's
 * account of itself was never part of it.
 *
 * That is the thesis of this whole product, so LIVE-ENGINEERING may rest on such a run. But
 * only when the violation is demonstrably CONTAINED, which is a claim with content:
 *
 *   the violation is DURABLY RECORDED, so nobody has to take this analysis on trust;
 *   NOT ONE contradicted claim is credited as acceptance evidence;
 *   the acceptance rests on independently MEASURED evidence;
 *   nothing the Producer got wrong leaves a material effect of that KIND unmeasured.
 *
 * THE LAST LINE SAYS "KIND" BECAUSE THAT IS WHAT IT CHECKS.
 *
 * SPEC: finding SSA-RLC-REV-2 (MEDIUM), 1.0.1 security review.
 *
 * It used to say "a material effect", which reads as the specific effect. What
 * `assessProducerContainment` actually requires is that evidence bound to this ChangeSet was
 * produced by a runtime component that MEASURES that kind of effect — SC-RTC-005 for a
 * FILE_WRITTEN claim, say — not that the measurement concerned the same file.
 *
 * Matching the specific effect is not possible against what evidence records: `claim` and
 * `detail` are free text and there is no structured subject to compare a contradicted claim
 * against. Adding one is a data-model change across every runtime component, not a tightening
 * here — so the wording is corrected to what the check does, and the residual is named rather
 * than implied: a contradicted FILE_WRITTEN claim about file X is treated as covered when the
 * only SC-RTC-005 measurement for that ChangeSet concerned file Y.
 *
 * The last one is the subtle one and the reason this is a function rather than a flag. A
 * contradicted claim about having read a file is noise; a contradicted claim about having
 * WRITTEN one is an assertion about the filesystem, and if nothing independently measured the
 * filesystem then something the Producer said happened has not been checked by anyone.
 */
export const MATERIAL_CLAIM_KINDS: ReadonlySet<string> = new Set([
  'FILE_WRITTEN',
  'COMMAND_RUN',
  'TEST_RESULT',
  'TOOL_EXECUTION',
]);

/**
 * Which runtime component independently answers a material claim of each kind.
 *
 * A table rather than a rule over the claim text: the recurring lesson in this codebase is
 * that anything routing on how something described itself eventually misses a case, and the
 * cost here would be crediting a Producer's word for an effect nobody measured.
 */
const COVERING_COMPONENTS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  FILE_WRITTEN: ['SC-RTC-005'],
  COMMAND_RUN: ['SC-RTC-012'],
  TEST_RESULT: ['SC-RTC-012'],
  TOOL_EXECUTION: ['SC-RTC-005', 'SC-RTC-012'],
});

export interface ProducerContainment {
  readonly contained: boolean;
  readonly producerOutcome: string;
  /** Every claim the runtime contradicted, kept verbatim. */
  readonly contradictedClaims: readonly { readonly kind: string; readonly statement: string }[];
  /** Acceptance evidence that would credit the Producer's own account. Must be empty. */
  readonly creditedFromProducer: readonly string[];
  readonly measuredEvidence: readonly string[];
  readonly reasons: readonly string[];
}

/**
 * Is a Producer's evidence violation contained?
 *
 * Returns the analysis whatever the answer, because a live proof must record the outcome
 * honestly rather than only when it is convenient — an `EVIDENCE_VIOLATION` that was contained
 * and one that was not must be distinguishable in the evidence, not merely in a verdict.
 */
export function assessProducerContainment(
  store: Store,
  producerRunId: string,
  changeSetId: string,
): ProducerContainment {
  const reasons: string[] = [];
  const record = terminalRun(store, producerRunId) as
    { outcome?: string; claimAssessments?: unknown; evidenceRefs?: unknown } | undefined;
  const outcome = record?.outcome ?? 'UNKNOWN';

  /*
   * THE CLAIM IS RECORDED FLAT, AND ALSO NESTED.
   *
   * `AgentRuntime` builds assessments as `{ claim, verification, reason }`, and the terminal
   * record persists them flattened to `{ kind, statement, verification }`. A first version of
   * this read only the nested shape, so every real contradicted claim arrived as kind `OTHER`
   * with an empty statement — and the material-kind check below therefore never fired on a
   * single one of them.
   *
   * That is the failure mode this codebase keeps meeting: a check that reads the wrong field
   * does not error, it just quietly agrees with you. Both shapes are read, and the fallback is
   * `OTHER` only when neither carries a kind.
   */
  const assessments = Array.isArray(record?.claimAssessments)
    ? (record.claimAssessments as {
        verification?: string;
        kind?: string;
        statement?: string;
        claim?: { kind?: string; statement?: string };
      }[])
    : [];
  const contradicted = assessments
    .filter((a) => a.verification === 'CONTRADICTED')
    .map((a) => ({
      kind: String(a.kind ?? a.claim?.kind ?? 'OTHER'),
      statement: String(a.statement ?? a.claim?.statement ?? ''),
    }));

  /*
   * A run terminated for an evidence violation whose contradicted claims were not recorded
   * leaves nothing to analyse. Refusing here is the difference between a contained violation
   * and an unexamined one.
   */
  if (outcome === 'EVIDENCE_VIOLATION' && contradicted.length === 0) {
    reasons.push(
      'the run ended EVIDENCE_VIOLATION and records no contradicted claim, so the violation is not durably recorded',
    );
  }

  const evidence = listEvidence(store).filter((e) => e.changeSetId === changeSetId);

  /*
   * EVIDENCE THAT CREDITS THE PRODUCER'S OWN ACCOUNT, IN EITHER OF ITS TWO FORMS.
   *
   * SPEC: finding SSA-2 (MEDIUM), from the independent security review.
   *
   * This read `.filter(runRef === producerRunId || basis === 'JUDGED').filter(runRef ===
   * producerRunId)`, and the second call deleted the first one's JUDGED clause outright — so
   * the comment above described a check the code had stopped performing. The drift went in the
   * dangerous direction: agent-judged evidence not tied to the producer run was never counted
   * as self-certification at all.
   *
   * Both forms belong here, for the same reason:
   *
   *   evidence from the Producer's own run is the Producer vouching for itself;
   *   JUDGED evidence is an agent's opinion, whoever produced it, and crediting that would let
   *   a second agent vouch for the first — self-certification with an extra step.
   *
   * Widening this narrows what may be accepted, never the reverse: nothing here can turn
   * JUDGED evidence into measurement, which `measured` below still decides on its own.
   */
  const creditedFromProducer = evidence
    .filter((e) => e.runRef === producerRunId || e.basis === 'JUDGED')
    .map((e) => e.id);
  if (creditedFromProducer.length > 0) {
    reasons.push(
      'acceptance evidence credits the Producer run: ' + creditedFromProducer.join(', '),
    );
  }

  const measured = evidence.filter((e) => e.basis === 'MEASURED' || e.basis === 'DERIVED');
  if (measured.length === 0) {
    reasons.push('no independently measured evidence supports this change');
  }

  /*
   * Every contradicted claim of a MATERIAL kind must be answered by a component that measured
   * that dimension for itself. A Producer wrong about a file is harmless when something else
   * checked the files; it is a hole when nothing did.
   */
  const componentsPresent = new Set(
    measured.map((e) => e.runtimeComponentId).filter((c): c is string => c !== undefined),
  );
  for (const claim of contradicted) {
    if (!MATERIAL_CLAIM_KINDS.has(claim.kind)) continue;
    const covering = COVERING_COMPONENTS[claim.kind] ?? [];
    if (!covering.some((c) => componentsPresent.has(c))) {
      reasons.push(
        'a contradicted ' +
          claim.kind +
          ' claim is not covered by any independent measurement (expected one of ' +
          covering.join(', ') +
          ')',
      );
    }
  }

  return {
    contained: reasons.length === 0,
    producerOutcome: outcome,
    contradictedClaims: contradicted,
    creditedFromProducer,
    measuredEvidence: measured.map((e) => e.id),
    reasons,
  };
}

/**
 * The capability grant the runtime bound for a run, read from its own event log.
 *
 * Returns an empty grant when the event is absent, which callers must treat as "unknown"
 * rather than "nothing was granted" — the two look identical here and only the first is
 * honest about what the store actually said.
 */
function capabilityGrantOf(
  store: Store,
  runId: string,
): { available?: unknown; approve?: unknown } {
  try {
    for (const entry of store.readTrace(runStream(runId))) {
      if (entry.type !== 'CAPABILITY_BOUND') continue;
      return payloadOf(entry) as { available?: unknown; approve?: unknown };
    }
  } catch {
    /* An unreadable trace grants nothing knowable, and the caller refuses on that. */
  }
  return {};
}

export interface VerificationBlock {
  /** True only when every condition below was derived from governed evidence. */
  readonly contained: boolean;
  readonly producerOutcome: string;
  /** The tool whose denial blocked verification, when one was found. */
  readonly blockedTool?: string;
  /** The command the Producer was refused, kept verbatim. */
  readonly blockedCommand?: string;
  /** Independent measurements that answered the check the Producer could not run. */
  readonly coveringEvidence: readonly string[];
  readonly reasons: readonly string[];
}

/**
 * IS A `PARTIAL` AN HONEST VERIFICATION BLOCK, OR AN UNFINISHED CHANGE?
 *
 * SPEC: Phase 6 LIVE-ENGINEERING PARTIAL semantics (locked).
 *
 * A Producer holds `Bash` in its available toolset and NO approving `Bash(...)` rule in its
 * grant, so under `dontAsk` every Bash call is denied. That is deliberate — `dispatch.ts:122`
 * calls it "the right default" — and it is precisely why a test result can be trusted:
 * `SC-RTC-012` is the executor "whose result a Producer cannot assert".
 *
 * So the correct behaviour for a Producer that cannot run the declared test is to say so and
 * stop. When one does, its run ends `PARTIAL`. Refusing that acceptance would punish the exact
 * honesty the trust model is built to reward, while the thing that actually verifies the
 * change — the independent measured check — passed.
 *
 * The danger is obvious, and is why this function is long: `PARTIAL` also means "I did not
 * finish". The two must never be confused, so nothing here is read from a field the Producer
 * authored about itself. `VERIFICATION_BLOCKED` in an escalation is a starting point, not a
 * finding — the attribution is proved from the CAPABILITY GRANT THE RUNTIME BOUND and the TOOL
 * DECISIONS THE RUNTIME RECORDED:
 *
 *   the denied tool was AVAILABLE, so it was not withheld by absence;
 *   it carried NO APPROVING RULE, which is the intentional policy and not an environment fault;
 *   the implementation itself landed, evidenced by an allowed write;
 *   nothing the Producer claimed was contradicted;
 *   and something independent measured the dimension the Producer could not.
 *
 * An arbitrary `PARTIAL` fails at the first of these. That is the point.
 */
/**
 * WHICH CONTAINMENT QUESTION THIS RUN HAS TO ANSWER, DECIDED ONCE.
 *
 * SPEC: finding SSA-RLC-PARTIAL-1 (MEDIUM), 1.0.1 security review.
 *
 * There were two consumers and two rules. `defaultContainmentAssessor` in status.ts read the
 * run's outcome from the STORE and, for a PARTIAL run, asked `assessVerificationBlock` — the
 * function written precisely to tell an honest verification block from an unfinished change,
 * and the only one that demands an independent measurement of the check the Producer could not
 * run. `resolveLiveEngineering` asked `assessProducerContainment` unconditionally.
 *
 * The weaker rule was on the MINTING path: `scripts/prove-live.mjs` resolves through
 * `resolveLiveEngineering`. So an unfinished PARTIAL change with some measured evidence and a
 * passing review could resolve as a valid engineering chain, while the acceptance status view
 * of the same run applied the stricter test.
 *
 * The outcome is read from the store here too, for the reason status.ts already gave: a proof
 * cannot select the more forgiving assessment by describing itself differently.
 */
export function assessContainmentForRun(
  store: Store,
  producerRunId: string,
  changeSetId: string,
): ProducerContainment {
  const outcome = terminalRun(store, producerRunId)?.outcome;
  if (String(outcome) === 'PARTIAL') {
    const block = assessVerificationBlock(store, producerRunId, changeSetId);
    return {
      contained: block.contained,
      producerOutcome: block.producerOutcome,
      reasons: block.reasons,
    } as ProducerContainment;
  }
  return assessProducerContainment(store, producerRunId, changeSetId);
}

export function assessVerificationBlock(
  store: Store,
  producerRunId: string,
  changeSetId: string,
): VerificationBlock {
  const reasons: string[] = [];
  const record = terminalRun(store, producerRunId) as
    | {
        outcome?: string;
        toolCalls?: unknown;
        escalations?: unknown;
        capabilityGrant?: unknown;
        claimAssessments?: unknown;
      }
    | undefined;

  if (record === undefined) {
    return {
      contained: false,
      producerOutcome: 'UNKNOWN',
      coveringEvidence: [],
      reasons: [producerRunId + ' does not resolve to a terminal run'],
    };
  }

  const outcome = record.outcome ?? 'UNKNOWN';
  if (outcome !== 'PARTIAL') {
    reasons.push('the run ended ' + outcome + ', and this rule covers PARTIAL only');
  }

  /* ------------------------------------------------- the block, as the Producer reported it */

  const escalations = Array.isArray(record.escalations)
    ? (record.escalations as { condition?: string; detail?: string }[])
    : [];
  /*
   * AN ESCALATION MUST EXIST, BUT ITS LABEL DOES NOT DECIDE ANYTHING.
   *
   * A first version matched `condition === 'VERIFICATION_BLOCKED'`. A later real run described
   * exactly the same situation — the same denied `node test.js`, the same refusal to claim an
   * unobserved result, the same edit landed — and labelled it `AUTHORITY_EXCEEDED`. The rule
   * refused it on the strength of a word the agent had chosen for itself.
   *
   * That is the failure this codebase keeps meeting: anything routing on how something
   * classified ITSELF eventually misses a case. What must exist is an escalation that refers to
   * the denial the RUNTIME recorded — checked below against the tool actually refused — and the
   * condition string is left to the agent's own vocabulary.
   */
  const blocked = escalations.find((e) => e.condition !== undefined && e.detail !== undefined);
  if (blocked === undefined) {
    reasons.push('the run records no escalation at all, so this PARTIAL is unexplained');
  }

  /* ------------------------------------------ the block, as the RUNTIME actually recorded it */

  const toolCalls = Array.isArray(record.toolCalls)
    ? (record.toolCalls as { tool?: string; allowed?: boolean; subject?: string }[])
    : [];
  const denied = toolCalls.filter((c) => c.allowed === false);

  /*
   * THE GRANT LIVES IN THE TRACE, NOT ON THE TERMINAL RECORD.
   *
   * A first version of this read `record.capabilityGrant`, which the AgentRun projection has
   * never written — so `available` and `approve` were empty for every real run and the
   * attribution below could never succeed. It failed CLOSED, which is the one direction this
   * may fail in, but it still proved nothing about the run it was asked about.
   *
   * `CAPABILITY_BOUND` is where the runtime records the grant it actually bound, before the
   * first tool call. That is the authority: it is written by the binder rather than reported
   * by the agent, and it is the same record `assertGrantWithinContract` was checked against.
   */
  const grant = capabilityGrantOf(store, producerRunId);
  const available = Array.isArray(grant.available) ? grant.available.map(String) : [];
  const approve = Array.isArray(grant.approve) ? grant.approve.map(String) : [];
  if (available.length === 0) {
    reasons.push(
      'no CAPABILITY_BOUND event records the grant this run was given, so no denial can be ' +
        'attributed to the Producer execution policy',
    );
  }

  /*
   * ATTRIBUTION. A tool denied because the policy never approved it is the invariant working;
   * a tool denied for any other reason is an unexplained environment failure, and an
   * unexplained failure is never a contained one.
   */
  const byPolicy = denied.find((c) => {
    const tool = String(c.tool ?? '');
    if (tool === '' || !available.includes(tool)) return false;
    return !approve.some((rule) => rule.startsWith(tool + '('));
  });

  if (byPolicy === undefined) {
    reasons.push(
      denied.length === 0
        ? 'no tool call was denied, so no verification block is attributable to the Producer policy'
        : 'the denied tool call is not attributable to the intentional Producer execution policy: ' +
            'it was either unavailable or already approved, which makes the denial an unexplained ' +
            'environment failure rather than the boundary working',
    );
  } else if (blocked !== undefined) {
    /*
     * The escalation must be ABOUT the denial, not merely present alongside it. A run that
     * escalated an unrelated ambiguity and happened to be denied a tool has explained nothing,
     * so the escalation has to name the tool the runtime actually refused.
     */
    /*
     * THE TOOL OR THE COMMAND — an agent describes what it tried to run.
     *
     * This required the detail to contain the TOOL name, and a real run wrote "`node test.js`
     * returned a permission denial from the sandbox in don't-ask mode". Unambiguously about
     * the denial, and refused, because `Bash` is the wrapper Serva denied rather than the
     * thing the agent was doing.
     *
     * Same mistake as matching the escalation's condition label, one field over: both
     * spellings name the same denied call and the runtime recorded both, so either identifies
     * it. What is still required is that the escalation refer to THAT call rather than to an
     * unrelated concern.
     */
    const tool = String(byPolicy.tool ?? '');
    const command = String(byPolicy.subject ?? '')
      .trim()
      .split(/[\s;|&]+/)[0];
    const detail = String(blocked.detail ?? '').toLowerCase();
    const names =
      (tool !== '' && detail.includes(tool.toLowerCase())) ||
      (command !== undefined && command !== '' && detail.includes(command.toLowerCase()));

    if (!names) {
      reasons.push(
        'the escalation does not refer to the denied ' +
          (tool === '' ? 'call' : tool + ' call') +
          ', so it does not explain this block',
      );
    }
  }

  /* ------------------------------------------------------- the implementation itself landed */

  const wrote = toolCalls.some(
    (c) => c.allowed === true && (c.tool === 'Edit' || c.tool === 'Write'),
  );
  if (!wrote) {
    reasons.push(
      'the run records no file the Producer was allowed to change, so no implementation work ' +
        'was completed and this PARTIAL is an unfinished change rather than a blocked check',
    );
  }

  /* ------------------------------------------------------------- nothing it said was wrong */

  const assessments = Array.isArray(record.claimAssessments)
    ? (record.claimAssessments as {
        verification?: string;
        kind?: string;
        claim?: { kind?: string };
      }[])
    : [];
  const contradicted = assessments.filter((a) => a.verification === 'CONTRADICTED');
  if (contradicted.length > 0) {
    reasons.push(
      String(contradicted.length) +
        ' Producer claim(s) were contradicted by the runtime, so this run is not merely blocked',
    );
  }

  /* --------------------------------------- something independent answered what it could not */

  const evidence = listEvidence(store).filter((e) => e.changeSetId === changeSetId);
  const measured = evidence.filter((e) => e.basis === 'MEASURED' || e.basis === 'DERIVED');

  /*
   * The justification for accepting this run at all is that the check the Producer was denied
   * WAS RUN by something that could. `SC-RTC-012` is that component, so its absence is fatal
   * however clean the rest of the run looks.
   */
  const testChecks = measured.filter((e) => e.runtimeComponentId === 'SC-RTC-012');
  if (testChecks.length === 0) {
    reasons.push(
      'no SC-RTC-012 measurement is bound to ' +
        changeSetId +
        ', so nothing independently ran the verification the Producer could not',
    );
  }
  const failing = measured.filter((e) => e.outcome !== undefined && e.outcome !== 'PASS');
  if (failing.length > 0) {
    reasons.push(
      'independent measurement did not pass: ' +
        failing.map((e) => String(e.runtimeComponentId) + ' ' + String(e.outcome)).join(', '),
    );
  }

  return {
    contained: reasons.length === 0,
    producerOutcome: outcome,
    ...(byPolicy?.tool === undefined ? {} : { blockedTool: String(byPolicy.tool) }),
    ...(byPolicy?.subject === undefined ? {} : { blockedCommand: String(byPolicy.subject) }),
    coveringEvidence: testChecks.map((e) => e.id),
    reasons,
  };
}

/**
 * Resolve the engineering half of the live chain.
 *
 * Returns refusals rather than throwing, and returns ALL of them rather than the first: an
 * owner or an auditor looking at a failed live acceptance needs to see everything that did not
 * line up, not the earliest thing to trip.
 */
export function resolveLiveEngineering(
  input: LiveEngineeringInput,
): LiveResolution<LiveEngineeringChain> {
  const refusals: LiveRefusal[] = [];
  const refuse = (check: string, detail: string): void => {
    refusals.push({ check, detail });
  };
  const commitExists = input.commitExists ?? gitCommitExists;

  /* ------------------------------------------------------------------ the machine */

  /*
   * A live result that happened somewhere else is not evidence about here. Checked first
   * because it is the one claim an author could otherwise make about any machine at all.
   */
  if (input.recordedFingerprint !== input.machineFingerprint) {
    refuse(
      'MACHINE',
      'the run records fingerprint ' +
        input.recordedFingerprint.slice(0, 12) +
        ' and this machine is ' +
        input.machineFingerprint.slice(0, 12),
    );
  }

  /*
   * HARD, and MEASURED. A SOFT boundary does not authorise a Producer, and an attempt that
   * never reached the guest measured nothing at all — the transport invariant reaching the
   * acceptance layer, where it matters most.
   */
  if (input.qualification === undefined) {
    /*
     * NO MEASUREMENT IS NOT A PASS, AND IT IS NOT A CRASH EITHER.
     *
     * SPEC: finding SERVA-SELF-ACCEPTANCE-AUTHORITY/SC-SSA-REV-Q1 (MEDIUM), 1.0.1 review.
     *
     * The field was typed as required and every caller satisfied it with a literal, so the
     * absent case had never occurred — and dereferencing it threw. Now that callers read the
     * measurement instead of supplying one, absence is a state that genuinely happens: a
     * machine that never measured its boundary has none to report.
     *
     * It refuses, because "we did not measure" and "we measured HARD" must not be the same
     * answer, and a thrown error is not a verdict anyone can act on.
     */
    refuse(
      'QUALIFICATION',
      'no substrate qualification was measured for this store, so nothing shows the Producer ' +
        'ran under a HARD boundary',
    );
  } else if (input.qualification.attempt !== QualificationAttempt.MEASURED) {
    refuse(
      'QUALIFICATION',
      'the qualification attempt was ' + input.qualification.attempt + ', so nothing was measured',
    );
  } else if (input.qualification.enforcementClass !== EnforcementClass.HARD) {
    refuse(
      'QUALIFICATION',
      'the boundary measured ' +
        input.qualification.enforcementClass +
        ', and a Producer requires HARD',
    );
  }

  /* -------------------------------------------------------------- the change set */

  const changeSets = listChangeSets(input.store);
  const changeSet =
    input.hints?.changeSetId !== undefined
      ? readChangeSet(input.store, input.hints.changeSetId)
      : changeSets[changeSets.length - 1];

  if (changeSet === undefined) {
    refuse('CHANGESET', 'no ChangeSet resolves in this store');
    return { resolved: false, refusals };
  }

  /* ------------------------------------------------------------- the producer run */

  const producerRunId = changeSet.producerRunId ?? input.hints?.producerRunId;
  if (producerRunId === undefined) {
    refuse('PRODUCER_RUN', 'the ChangeSet names no Producer run, so nothing produced it');
  }

  let producerAgentId = changeSet.producerAgentId;
  if (producerRunId !== undefined) {
    const run = terminalRun(input.store, producerRunId);
    if (run === undefined || run.outcome === undefined) {
      refuse('PRODUCER_RUN', producerRunId + ' does not resolve to a run in this store');
    } else if (PRODUCED_NOTHING.has(run.outcome)) {
      refuse('PRODUCER_RUN', producerRunId + ' ended ' + run.outcome + ', so it produced nothing');
    }
    /*
     * EVIDENCE_VIOLATION IS NOT A REASON TO REFUSE, AND IT IS ALWAYS REPORTED.
     *
     * The first real live run ended exactly this way: the Producer made a claim Serva's own
     * verifier CONTRADICTED, the run was terminated `EVIDENCE_VIOLATION`, and the change was
     * still accepted — because acceptance never rested on the Producer's word. Deterministic
     * checks measured the code and an independent reviewer judged it.
     *
     * That is this product's central thesis working rather than a hole in it, so demanding
     * COMPLETED here would refuse the strongest demonstration available: governance catching
     * an agent misrepresenting its own work and proceeding on measured evidence instead.
     *
     * What must never happen is this passing SILENTLY, so the outcome travels on the chain and
     * the report prints it.
     */
    /*
     * The run's OWN actor, not the one the ChangeSet claims. A ChangeSet is written by Serva
     * from what it observed, but binding the two here is what stops a real run being pasted
     * beside a change it did not make.
     */
    if (run?.agentId !== undefined && run.agentId !== changeSet.producerAgentId) {
      refuse(
        'PRODUCER_RUN',
        'run ' +
          producerRunId +
          ' was made by ' +
          run.agentId +
          ' and the ChangeSet names ' +
          changeSet.producerAgentId,
      );
    }
    if (run?.agentId !== undefined) producerAgentId = run.agentId;
  }

  /* ------------------------------------------------------- deterministic evidence */

  const evidence = listEvidence(input.store).filter((e) => e.changeSetId === changeSet.changeSetId);
  if (evidence.length === 0) {
    refuse(
      'CHECKS',
      'no deterministic check evidence is bound to ChangeSet ' + changeSet.changeSetId,
    );
  }

  /* ---------------------------------------------------------------- the reviewer */

  const reviews = listReviews(input.store).filter((r) => r.changeSetId === changeSet.changeSetId);
  const review =
    input.hints?.reviewerRunId !== undefined
      ? reviews.find((r) => r.runRef === input.hints?.reviewerRunId)
      : reviews[0];

  if (review === undefined) {
    refuse(
      'REVIEW',
      'no persisted review is bound to ChangeSet ' +
        changeSet.changeSetId +
        (reviews.length === 0 ? '' : ', and the named reviewer run is not among the ones that are'),
    );
  } else {
    const reviewerRun = terminalRun(input.store, review.runRef);
    if (reviewerRun === undefined || reviewerRun.outcome === undefined) {
      refuse('REVIEW', review.runRef + ' does not resolve to a run in this store');
    } else if (reviewerRun.outcome !== 'COMPLETED') {
      refuse('REVIEW', review.runRef + ' ended ' + reviewerRun.outcome + ', so it judged nothing');
    }
    /*
     * Independence, from the runs rather than from the record. A reviewer that is the
     * Producer is the system asking itself for permission, and the whole engineering gate
     * rests on this one comparison.
     */
    /*
     * THE REVIEWER IS RESOLVED, NOT MERELY DIFFERENT.
     *
     * SPEC: Phase 6 security invariant sweep; finding SSA-REV-1.
     *
     * This compared two names and stopped. Any agent with a different id and a persisted review
     * record showing PASS satisfied the "independent Reviewer" requirement — a second Producer,
     * or an agent holding no verifier contract at all. The round that added exactly this check
     * to `proof.ts` and `reviewAuthority.ts` never carried it here.
     *
     * `actorRefusal` answers the whole question at once: the cited run resolves, it COMPLETED,
     * it was made by the agent the review names, that agent holds a verifier's authority by
     * contract, and it is not the agent that produced the work.
     */
    const reviewerRefusal = actorRefusal({
      store: input.store,
      registry: ContractRegistry.shared(),
      actorRunId: review.runRef,
      claimedAgentId: review.reviewerAgentId,
      requiredAuthority: RoleAuthority.VERIFY,
      ...(producerRunId === undefined ? {} : { mustDifferFromRunId: producerRunId }),
    });
    if (reviewerRefusal !== undefined) {
      refuse(
        'INDEPENDENCE',
        'the review was not made by an independent verifier: ' + reviewerRefusal,
      );
    }
    if (review.outcome !== 'PASS') {
      refuse('REVIEW', 'the review outcome is ' + review.outcome);
    }
    /* Same work item, or these are two unrelated executions standing next to each other. */
    if (review.workItemId !== changeSet.workItemId) {
      refuse(
        'SAME_EXECUTION',
        'the review belongs to work item ' +
          review.workItemId +
          ' and the ChangeSet to ' +
          changeSet.workItemId,
      );
    }
  }

  /* ------------------------------------------------------------ the accepted commit */

  /*
   * THE ACCEPTANCE IS IN THE TRACE, NOT IN THE WORKTREE HEAD.
   *
   * An earlier draft required the accepted commit to EQUAL `changeSet.headCommit`, and the
   * first real live run refused because of it. That draft was wrong: the ChangeSet head is
   * what the Producer built in its worktree, and the accepted commit is the INTEGRATION
   * commit Serva creates afterwards by staging exactly the verified change onto the branch.
   * Two different commits, both legitimate, and only one of them is the acceptance.
   *
   * The binding that actually exists is the `CHANGE_ACCEPTED` audit entry, which Serva writes
   * to T-TRACE — a stream no agent can write and no caller can forge — naming the ChangeSet,
   * the commit, the gate result and the evidence together. So the commit is resolved FROM the
   * trace rather than compared to a record, and a hand-written commit has nothing to appear in.
   */
  const accepted = readAudit(input.store).filter(
    (e) => e.type === 'CHANGE_ACCEPTED' && payloadOf(e)['subject'] === changeSet.changeSetId,
  );
  const tracedCommit = accepted
    .map((e) => String((payloadOf(e)['detail'] as Record<string, unknown>)?.['commit'] ?? ''))
    .find((c) => c !== '');

  if (tracedCommit === undefined) {
    refuse(
      'ACCEPTED_COMMIT',
      'no CHANGE_ACCEPTED entry in the trace names ChangeSet ' +
        changeSet.changeSetId +
        ', so nothing was ever accepted',
    );
  }

  const acceptedCommit = tracedCommit ?? '';
  const claimed = input.hints?.acceptedCommit;
  if (claimed !== undefined && tracedCommit !== undefined && claimed !== tracedCommit) {
    /* A commit somebody typed in, next to the one Serva actually integrated. */
    refuse(
      'ACCEPTED_COMMIT',
      'the named commit ' +
        claimed.slice(0, 12) +
        ' is not the one the trace records as accepted (' +
        tracedCommit.slice(0, 12) +
        ')',
    );
  }
  if (acceptedCommit === '' || !commitExists(input.repoRoot, acceptedCommit)) {
    refuse('ACCEPTED_COMMIT', acceptedCommit.slice(0, 12) + ' is not a commit in this repository');
  }

  /*
   * CLAIM INTEGRITY, ASSESSED SEPARATELY FROM ENGINEERING VALIDITY.
   *
   * Run for every chain rather than only for a violating one: a clean Producer still has to
   * be shown not to have certified itself, and a check that only ran when something looked
   * wrong would never have caught the case where nothing looked wrong.
   */
  const containment =
    producerRunId === undefined
      ? undefined
      : assessContainmentForRun(input.store, producerRunId, changeSet.changeSetId);

  if (containment !== undefined && !containment.contained) {
    for (const reason of containment.reasons) refuse('PRODUCER_CONTAINMENT', reason);
  }

  if (refusals.length > 0) return { resolved: false, refusals };

  return {
    resolved: true,
    chain: {
      workItemId: changeSet.workItemId,
      producerRunId: String(producerRunId),
      producerAgentId,
      producerOutcome: containment?.producerOutcome ?? 'UNKNOWN',
      containment: containment as ProducerContainment,
      reviewerRunId: String(review?.runRef),
      reviewerAgentId: String(review?.reviewerAgentId),
      changeSetId: changeSet.changeSetId,
      acceptedCommit,
      checkIds: evidence.map((e) => e.id),
      machineFingerprint: input.machineFingerprint,
    },
    refusals: [],
  };
}

/**
 * DID THE OWNER'S REQUEST ACTUALLY CAUSE GOVERNED WORK?
 *
 * ONE definition, called by both resolvers that need it, because there were two and they
 * drifted. `resolveServaChain` was hardened to require QUEUED after a regression showed that
 * refusing only REFUSED let a HALTED request — Serva stopping honestly at classification or
 * planning — resolve as a proven whole-product chain whenever engineering artifacts happened
 * to exist for the same work item. That hardening never reached `resolveLiveServa`, which is
 * the function the LIVE-SERVA requirement is wired to, so the weaker rule survived exactly
 * where it mattered most.
 *
 * The distinguishing property of LIVE-SERVA over LIVE-ENGINEERING is the request → work
 * causation link. A turn that did not queue work did not cause it, whatever else is true, and
 * only QUEUED says work followed. Anything not QUEUED — including an outcome this build does
 * not recognise, or none at all — is refused, so a new turn outcome fails closed.
 */
export function requestQueuedWork(turn: Record<string, unknown>): LiveRefusal | undefined {
  const outcome = String(turn['outcome'] ?? '');
  if (outcome === 'QUEUED') return undefined;
  const haltReason = turn['haltReason'];
  return {
    check: 'OWNER_REQUEST',
    detail:
      'the request ended ' +
      (outcome === '' ? '(no outcome recorded)' : outcome) +
      ', so no governed work followed it' +
      (haltReason === undefined ? '' : ': ' + String(haltReason)),
  };
}

export interface LiveServaChain extends LiveEngineeringChain {
  readonly requestId: string;
  readonly turnId: string;
  readonly classification?: string;
  readonly queuedDepartments: readonly string[];
}

export interface LiveServaInput extends LiveEngineeringInput {
  /** Where the owner's request and the governed intelligence live. */
  readonly companyStore: Store;
  readonly hints2?: { readonly turnId?: string };
}

/**
 * Resolve the whole-product chain: an owner asked, and governed work followed.
 *
 * SPEC: §2.
 *
 * The engineering half is resolved by the function above and reused rather than re-checked,
 * so there is one definition of what a real Producer chain is. What this adds is the front of
 * it — the owner's request, recorded verbatim, and the governed runs it caused.
 */
export function resolveLiveServa(input: LiveServaInput): LiveResolution<LiveServaChain> {
  const engineering = resolveLiveEngineering(input);
  const refusals: LiveRefusal[] = [...engineering.refusals];

  const turns = input.companyStore
    .listWorkingIds('conversationTurn')
    .map((id) => input.companyStore.getWorking<Record<string, unknown>>('conversationTurn', id))
    .filter((e): e is NonNullable<typeof e> => e !== undefined)
    .map((e) => e.body);

  const turn =
    input.hints2?.turnId !== undefined
      ? turns.find((t) => t['id'] === input.hints2?.turnId)
      : turns[turns.length - 1];

  if (turn === undefined) {
    refusals.push({ check: 'OWNER_REQUEST', detail: 'no owner request is recorded in this store' });
    return { resolved: false, refusals };
  }

  const runIds = Array.isArray(turn['runIds']) ? (turn['runIds'] as string[]) : [];
  if (runIds.length === 0) {
    refusals.push({
      check: 'GOVERNED_INTELLIGENCE',
      detail: 'the request caused no governed run, so nothing reasoned about it',
    });
  }

  /*
   * Each run the request claims to have caused, resolved. A turn is written by Serva, but a
   * turn naming runs that do not exist would let a transcript stand in for execution.
   */
  for (const runId of runIds) {
    const run = terminalRun(input.companyStore, runId);
    if (run === undefined) {
      refusals.push({
        check: 'GOVERNED_INTELLIGENCE',
        detail: runId + ' is named by the request and does not resolve',
      });
    } else if (run.outcome !== 'COMPLETED') {
      refusals.push({
        check: 'GOVERNED_INTELLIGENCE',
        detail: runId + ' ended ' + String(run.outcome),
      });
    }
  }

  /*
   * THE LINK THAT MAKES THIS ONE CHAIN.
   *
   * Without it, a real owner request and a real engineering run could be presented side by
   * side as though one caused the other. The turn records the work item its request opened and
   * the ChangeSet records the one it was built for; if they differ, these are two things that
   * happened, not a chain.
   */
  if (engineering.chain !== undefined && turn['workItemId'] !== engineering.chain.workItemId) {
    refusals.push({
      check: 'SAME_EXECUTION',
      detail:
        'the request opened work item ' +
        String(turn['workItemId']) +
        ' and the change was built for ' +
        engineering.chain.workItemId,
    });
  }

  const notQueued = requestQueuedWork(turn);
  if (notQueued !== undefined) refusals.push(notQueued);

  if (refusals.length > 0 || engineering.chain === undefined) {
    return { resolved: false, refusals };
  }

  return {
    resolved: true,
    chain: {
      ...engineering.chain,
      requestId: String(turn['requestId'] ?? ''),
      turnId: String(turn['id']),
      ...(turn['classification'] === undefined
        ? {}
        : { classification: String(turn['classification']) }),
      queuedDepartments: Array.isArray(turn['queued']) ? (turn['queued'] as string[]) : [],
    },
    refusals: [],
  };
}
