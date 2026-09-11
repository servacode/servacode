import { z } from 'zod';
import { canonicalJson, digestOf } from '../core/hash.js';
import { fail } from '../core/errors.js';
import { RunOutcome } from '../vocab/index.js';
import { projectAgentRun, readTerminalSnapshot, runStream } from '../events/agentRun.js';
import type { Store, Transaction } from '../store/store.js';
import type { JudgedInput } from './gate.js';

/**
 * The independent reviewer's verdict, and why a caller cannot simply assert one.
 *
 * SPEC: Phase 4 §19–§20, SC-POL-006, closure blocker 2.
 *
 * The defect this module closes: `verifyAttempt` accepted a `JudgedInput` from its
 * caller and fed it straight to the gate. So this made a required, BLOCKING review
 * criterion pass:
 *
 *     judged: [{ criterionId: 'EC-REVIEW', outcome: 'PASS', runRef: 'anything' }]
 *
 * No run had to exist. No reviewer had to be dispatched. The string in `runRef` was
 * never resolved against anything. A gate whose most important criterion can be
 * satisfied by a literal is not a gate — and worse, the resulting record would claim
 * an independent review that never happened, which is a lie with a signature on it.
 *
 * The production path now accepts only a PERSISTED review, and a review is persisted
 * only after ten conditions are checked against the run's own event log. Everything
 * here is derived from T-TRACE, which no agent can write to and no caller can forge.
 */

export const REVIEW_CANON_TYPE = 'engineeringReview';

/** The structured payload a reviewer AgentRun must return. Validated locally. */
export const ReviewerVerdictSchema = z
  .object({
    /** Which gate criterion this verdict answers. */
    criterionId: z.enum(['EC-REVIEW', 'EC-QA']),
    outcome: z.enum(['PASS', 'FAIL', 'NOT_VERIFIED']),
    /**
     * The ChangeSet the reviewer believes it reviewed.
     *
     * Echoed back so Serva can compare it to the one actually bound to the run. A
     * reviewer that reports on a different change than the one it was given is a
     * finding, not a verdict.
     */
    changeSetId: z.string().min(1),
    summary: z.string().min(1),
    findings: z
      .array(
        z
          .object({
            severity: z.enum(['BLOCKING', 'MAJOR', 'MINOR', 'INFO']),
            path: z.string().optional(),
            detail: z.string().min(1),
          })
          .strict(),
      )
      .default([]),
    confidence: z.enum(['LOW', 'MEDIUM', 'HIGH']),
  })
  .strict()
  .refine((v) => v.outcome !== 'FAIL' || v.findings.length > 0, {
    // A rejection with nothing to point at cannot be acted on, and a Producer told
    // only "no" will guess. 19 CX-2: rework is driven by findings, not by a mood.
    message: 'A FAIL verdict must name at least one finding.',
  });

export type ReviewerVerdict = z.output<typeof ReviewerVerdictSchema>;

/** What Serva stores once a reviewer run has been validated. T-CANON. */
export const PersistedReviewSchema = z
  .object({
    id: z.string().min(1),
    workItemId: z.string().min(1),
    changeSetId: z.string().min(1),
    criterionId: z.enum(['EC-REVIEW', 'EC-QA']),
    reviewerAgentId: z.string().regex(/^SC-AGENT-\d{3}$/),
    producerAgentId: z.string().regex(/^SC-AGENT-\d{3}$/),
    /** The reviewer's AgentRun. Resolvable, and resolved before this record exists. */
    runRef: z.string().min(1),
    /** The engine session. Proved distinct from the Producer's. */
    sessionRef: z.string().optional(),
    producerRunRef: z.string().optional(),
    outcome: z.enum(['PASS', 'FAIL', 'NOT_VERIFIED']),
    detail: z.string(),
    verdict: z.unknown(),
    /** Digest of the capability grant the reviewer actually ran under. */
    capabilityDigest: z.string().length(64),
    recordedAt: z.string(),
  })
  .strict();

export type PersistedReview = z.output<typeof PersistedReviewSchema>;

/**
 * WHICH REVIEW DECIDES, WHEN REVIEWERS DISAGREE.
 *
 * A DISSENT IS NOT OVERRULED BY BEING SECOND. Two reviewers disagreeing is not a tie to be
 * broken by array order — it is a reason not to accept the change, so a FAIL outranks a PASS
 * however the records happen to be ordered, and NOT_VERIFIED outranks a PASS because unproven
 * is not proven.
 *
 * ONE rule, applied wherever reviews are consulted. It was written twice before: the gate
 * honoured dissent (finding EAA-2) while `acceptChange` checked only that SOME review existed
 * and never read its outcome (finding EAA-R1) — a gap the gate's own comment described and did
 * not close. A rule stated at one boundary and not the next is how the weak boundary survives.
 */
export function decisiveReview<T extends { readonly outcome: string }>(
  reviews: readonly T[],
): T | undefined {
  return (
    reviews.find((r) => r.outcome === 'FAIL') ??
    reviews.find((r) => r.outcome === 'NOT_VERIFIED') ??
    reviews[0]
  );
}

export interface ReviewValidationInput {
  readonly store: Store;
  readonly runRef: string;
  readonly expectedReviewerAgentId: string;
  readonly producerAgentId: string;
  readonly producerRunRef?: string;
  readonly changeSetId: string;
  readonly workItemId: string;
  readonly verdict: unknown;
}

export interface ReviewValidation {
  readonly ok: boolean;
  /** Every condition that failed, so a reader sees the whole picture at once. */
  readonly problems: readonly string[];
  readonly verdict?: ReviewerVerdict;
  readonly sessionRef?: string;
  readonly capabilityDigest?: string;
}

/** The capability grant recorded for a run, read from its own event log. */
export function capabilityBoundOf(
  store: Store,
  runId: string,
): Record<string, unknown> | undefined {
  const events = store.readTrace(runStream(runId));
  const bound = [...events].reverse().find((e) => e.type === 'CAPABILITY_BOUND');
  return bound === undefined ? undefined : (bound.payload as Record<string, unknown>);
}

/** Tools that must not be available to anything called a reviewer. */
export const REVIEWER_FORBIDDEN_TOOLS: readonly string[] = Object.freeze([
  'Edit',
  'Write',
  'NotebookEdit',
  'Bash',
  'PowerShell',
]);

/**
 * Is this a real, independent review of THIS change?
 *
 * Ten conditions, every one derived from the run's own event log. They are collected
 * rather than short-circuited: an operator fixing a broken dispatch wants the whole
 * list, not the first thing that went wrong.
 */
export function validateReviewerResult(input: ReviewValidationInput): ReviewValidation {
  const problems: string[] = [];

  // 1. The run exists at all. `projectAgentRun` throws for an unknown id, which is the
  //    single check that stops a fabricated `runRef` string in its tracks.
  let projection;
  try {
    projection = projectAgentRun(input.store, input.runRef);
  } catch {
    return {
      ok: false,
      problems: [
        'No AgentRun ' +
          input.runRef +
          ' exists. A reviewer verdict is a fact about a run that happened, not a value a caller supplies.',
      ],
    };
  }

  // 2. It terminated, and there is an immutable record of how.
  if (!projection.terminal) {
    problems.push('Run ' + input.runRef + ' has no terminal event; it may still be in flight.');
  }
  const record = readTerminalSnapshot(input.store, input.runRef) as
    Record<string, unknown> | undefined;
  if (record === undefined) {
    problems.push(
      'Run ' + input.runRef + ' has no AgentRunRecord, so nothing about it is settled.',
    );
  }

  // 3. It completed. A BLOCKED or FAILED reviewer run produced no opinion worth having.
  if (projection.outcome !== RunOutcome.COMPLETED) {
    problems.push(
      'Run ' + input.runRef + ' ended ' + String(projection.outcome) + ', not COMPLETED.',
    );
  }

  // 4. The reviewer is the expected canonical verifier.
  if (projection.agentId !== input.expectedReviewerAgentId) {
    problems.push(
      'Run ' +
        input.runRef +
        ' was executed by ' +
        String(projection.agentId) +
        ', not by the expected reviewer ' +
        input.expectedReviewerAgentId +
        '.',
    );
  }

  // 5. The reviewer is not the Producer. SC-POL-006, checked on the RUN rather than on
  //    the work item, because the work item is a plan and this is what happened.
  if (projection.agentId === input.producerAgentId) {
    problems.push(
      'The reviewing agent is the producing agent. An agent never certifies its own work (SC-POL-006).',
    );
  }

  // 6. The run is bound to this work item.
  if (projection.workItemId !== undefined && projection.workItemId !== input.workItemId) {
    problems.push(
      'Run ' +
        input.runRef +
        ' belongs to work item ' +
        String(projection.workItemId) +
        ', not ' +
        input.workItemId +
        '.',
    );
  }

  // 7. The run had a read-only capability grant. Read from CAPABILITY_BOUND, which the
  //    runtime writes before invoking the engine, so it records what was actually
  //    granted rather than what somebody intended.
  const capability = capabilityBoundOf(input.store, input.runRef);
  if (capability === undefined) {
    problems.push('Run ' + input.runRef + ' has no CAPABILITY_BOUND event.');
  } else {
    /*
     * A GRANT THAT CANNOT BE READ IS NOT A GRANT OF NOTHING.
     *
     * SPEC: finding EAA-SR-1 (MEDIUM), 1.0.1 security review.
     *
     * These read `available` and `filesystem.write` and treated a missing or malformed field
     * as an empty list — so a capability event whose shape did not match silently satisfied
     * the read-only guarantee that independent acceptance rests on. The check degraded OPEN,
     * which is the one direction a check about authority must never degrade.
     *
     * Measured before tightening: real CAPABILITY_BOUND events carry `available` as an array
     * and `filesystem` as `{read, write, readDenied}`, so requiring the shape refuses nothing
     * that legitimately happens today.
     */
    if (!Array.isArray(capability['available'])) {
      problems.push(
        'Run ' +
          input.runRef +
          ' records a capability grant with no readable tool list, so it cannot be shown read-only.',
      );
    } else {
      const available = (capability['available'] as unknown[]).filter(
        (x): x is string => typeof x === 'string',
      );
      const forbidden = available.filter((t) => REVIEWER_FORBIDDEN_TOOLS.includes(t));
      if (forbidden.length > 0) {
        problems.push(
          'The reviewer run had write or execute tools available (' +
            forbidden.join(', ') +
            '), so it was not read-only.',
        );
      }
    }

    const filesystem = capability['filesystem'] as { write?: unknown } | undefined;
    if (filesystem === undefined || !Array.isArray(filesystem.write)) {
      problems.push(
        'Run ' +
          input.runRef +
          ' records no readable filesystem scope, so its write authority is unknown.',
      );
    } else if (filesystem.write.length > 0) {
      problems.push('The reviewer run had a writable filesystem scope.');
    }
  }

  // 8. A distinct engine session. Two runs sharing one session share context, and a
  //    reviewer that can see the Producer's reasoning is reviewing the argument rather
  //    than the artifact (19 SM-3).
  const sessionRef =
    typeof record?.['engineSessionRef'] === 'string'
      ? (record['engineSessionRef'] as string)
      : undefined;
  /*
   * NOT SUPPLIED IS NOT THE SAME AS DISTINCT.
   *
   * SPEC: finding ENGINEERING-ACCEPTANCE-AUTHORITY/EAA-1 (MEDIUM), 1.0.1 security review.
   *
   * This whole check sat inside `if (input.producerRunRef !== undefined)`, and the field is
   * optional on both the input and the persisted schema. So omitting it did not fail the
   * check — it removed the check. A reviewer that had shared the Producer's engine session,
   * reviewing the argument rather than the artifact (19 SM-3), validated and persisted
   * cleanly whenever the caller left the reference out.
   *
   * Independence then rested on an optional input rather than on the validator, which is the
   * one place it cannot rest: the caller supplying the reference is the same caller whose
   * independence is in question.
   *
   * Absence now means the opposite of what it meant. Serva cannot show the sessions differed,
   * so it does not claim they did.
   */
  if (input.producerRunRef === undefined) {
    problems.push(
      'The Producer run was not identified, so the reviewer cannot be shown to have used a ' +
        'different engine session from the one that wrote the change.',
    );
  } else {
    const producerRecord = readTerminalSnapshot(input.store, input.producerRunRef) as
      Record<string, unknown> | undefined;
    if (producerRecord === undefined) {
      /* A reference that resolves to nothing is not evidence of anything. Accepting it would
         let the requirement be satisfied by inventing a run id. */
      problems.push(
        'The Producer run ' +
          input.producerRunRef +
          ' does not resolve to a recorded run, so the reviewer cannot be compared against it.',
      );
    } else {
      const producerSession = producerRecord['engineSessionRef'];
      /*
       * THE RESIDUAL, MEASURED AND THEN CLOSED.
       *
       * SPEC: finding EAA-SESSION-RESIDUAL (MEDIUM), 1.0.1 security review, second pass.
       *
       * This used to compare the two sessions only when BOTH runs recorded one, and said so as
       * a known residual. That is the same shape as the defect above it, one field along:
       * absence removed the check instead of failing it, so a reviewer sharing the Producer's
       * session passed whenever the engine reported no session.
       *
       * The reason given for leaving it was that demanding the field would refuse every review
       * under an engine that does not report one. That is a measurable claim and it was
       * measured rather than repeated: across the 29 governed runs of the 0fe5215d security
       * round, 29 recorded an `engineSessionRef`, and the fake adapter reports one per run.
       *
       * So the field is present in practice, and requiring it fails CLOSED for an engine that
       * stops reporting one - which is the direction this check must fail in. Serva cannot show
       * the sessions differed without both of them, and it no longer claims it can.
       */
      if (sessionRef === undefined || typeof producerSession !== 'string') {
        problems.push(
          'The ' +
            (sessionRef === undefined ? 'reviewer' : 'Producer') +
            ' run recorded no engine session, so the reviewer cannot be shown to have used a ' +
            'different engine session from the one that wrote the change.',
        );
      } else if (sessionRef === producerSession) {
        problems.push("The reviewer shared the Producer's engine session.");
      }
    }
  }

  /*
   * 9. The payload is a valid reviewer verdict by Serva's own schema.
   *
   * WHAT THIS DOES NOT DO, MEASURED RATHER THAN ASSUMED.
   *
   * SPEC: finding EAA-SR-A1 (MEDIUM), 1.0.1 security review, and the reason it is not fixed
   * here rather than not noticed.
   *
   * The verdict's CONTENT comes from the caller. Everything around it is re-derived — the run
   * exists, terminated COMPLETED, was made by the expected agent, under a read-only capability
   * grant, in a session distinct from the Producer's, by an agent that is not the Producer —
   * but the outcome itself is not compared against what the reviewer actually returned.
   *
   * It cannot be, from what this store holds. The trace records that a structured output
   * existed and how long it was (`OUTPUT_RECEIVED`: `hasStructuredOutput`, `textLength`) and
   * does not keep the output. Persisting model output verbatim into the trace so that it could
   * be compared is a much larger decision than this finding, and it runs directly at the
   * boundary that keeps such content bounded and redacted.
   *
   * So the gap is real, narrow, and named: a caller that fabricates a verdict while citing a
   * genuine, independent, read-only reviewer run is not caught here. It is caught nowhere else
   * either, and saying so is worth more than a check that looks like it would.
   */
  const parsed = ReviewerVerdictSchema.safeParse(input.verdict);
  if (!parsed.success) {
    problems.push(
      'The reviewer result is not a valid verdict: ' +
        parsed.error.issues
          .slice(0, 5)
          .map((i) => i.path.join('.') + ': ' + i.message)
          .join('; '),
    );
    return { ok: false, problems };
  }

  // 10. It is about THIS ChangeSet. A verdict on a different change is stale, however
  //     recently it was produced and however positive it was.
  if (parsed.data.changeSetId !== input.changeSetId) {
    problems.push(
      'The verdict reports on ChangeSet ' +
        parsed.data.changeSetId +
        ', not ' +
        input.changeSetId +
        '.',
    );
  }

  return {
    ok: problems.length === 0,
    problems,
    verdict: parsed.data,
    ...(sessionRef === undefined ? {} : { sessionRef }),
    ...(capability === undefined ? {} : { capabilityDigest: digestOf(canonicalJson(capability)) }),
  };
}

export interface RecordReviewInput extends ReviewValidationInput {
  readonly id: string;
  readonly recordedAt: string;
}

/**
 * Validate and persist. Refuses rather than recording a review it could not verify.
 *
 * Throwing rather than returning a flag is deliberate: a caller that wanted a review
 * and got "no review" must not be able to continue by ignoring a return value.
 */
export function recordReview(tx: Transaction, input: RecordReviewInput): PersistedReview {
  const validation = validateReviewerResult(input);
  if (!validation.ok || validation.verdict === undefined) {
    return fail({
      code: 'E_VALIDATION',
      message:
        'Refusing to record a reviewer result for ' +
        input.changeSetId +
        ': ' +
        validation.problems.join(' '),
      remedy:
        'A required review is satisfied by a real, independent, terminated AgentRun bound to this ChangeSet. NO EVIDENCE = NOT VERIFIED.',
      details: { runRef: input.runRef, problems: validation.problems },
      specRef: 'Phase 4 §19, SC-POL-006',
    });
  }

  const review = PersistedReviewSchema.parse({
    id: input.id,
    workItemId: input.workItemId,
    changeSetId: input.changeSetId,
    criterionId: validation.verdict.criterionId,
    reviewerAgentId: input.expectedReviewerAgentId,
    producerAgentId: input.producerAgentId,
    runRef: input.runRef,
    ...(validation.sessionRef === undefined ? {} : { sessionRef: validation.sessionRef }),
    ...(input.producerRunRef === undefined ? {} : { producerRunRef: input.producerRunRef }),
    outcome: validation.verdict.outcome,
    detail:
      validation.verdict.summary +
      (validation.verdict.findings.length === 0
        ? ''
        : ' | ' +
          validation.verdict.findings
            .map((f) => '[' + f.severity + '] ' + (f.path ?? '') + ' ' + f.detail)
            .join('; ')),
    verdict: validation.verdict,
    capabilityDigest: validation.capabilityDigest ?? digestOf('none'),
    recordedAt: input.recordedAt,
  });

  tx.putCanon(REVIEW_CANON_TYPE, review.id, review);
  return review;
}

export function listReviews(store: Store): PersistedReview[] {
  return store
    .listCanonIds(REVIEW_CANON_TYPE)
    .map((id) => {
      const env = store.getCanon<unknown>(REVIEW_CANON_TYPE, id);
      if (env === undefined) return undefined;
      const parsed = PersistedReviewSchema.safeParse(env.body);
      return parsed.success ? parsed.data : undefined;
    })
    .filter((r): r is PersistedReview => r !== undefined);
}

/**
 * The judged inputs the gate may consume for one ChangeSet.
 *
 * Only persisted reviews, and only those bound to this exact ChangeSet. A review of an
 * earlier ChangeSet is not carried forward: the reviewer looked at different code.
 */
export function judgedForChangeSet(store: Store, changeSetId: string): JudgedInput[] {
  return listReviews(store)
    .filter((r) => r.changeSetId === changeSetId)
    .map((r) => ({
      criterionId: r.criterionId,
      outcome: r.outcome,
      detail: r.detail,
      runRef: r.runRef,
      reviewerRole: r.criterionId === 'EC-QA' ? 'QA_VERIFICATION' : 'CODE_REVIEW',
    }));
}

/** JSON Schema for the reviewer's structured output, sent to the engine. */
export const REVIEWER_RESULT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['criterionId', 'outcome', 'changeSetId', 'summary', 'findings', 'confidence'],
  properties: {
    criterionId: { type: 'string', enum: ['EC-REVIEW', 'EC-QA'] },
    outcome: { type: 'string', enum: ['PASS', 'FAIL', 'NOT_VERIFIED'] },
    changeSetId: { type: 'string' },
    summary: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'detail'],
        properties: {
          severity: { type: 'string', enum: ['BLOCKING', 'MAJOR', 'MINOR', 'INFO'] },
          path: { type: 'string' },
          detail: { type: 'string' },
        },
      },
    },
    confidence: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH'] },
  },
};
