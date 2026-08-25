import { VerificationVerdict } from '../artifacts/quality.js';

/**
 * A VERDICT IS SUPPORTED BY WHAT WAS EXERCISED, OR IT IS NOT A VERDICT.
 *
 * SPEC: Phase 6 security invariant sweep; findings
 * ORGANIZATIONAL-LEARNING-DEPARTMENTS-B/F1 and F2.
 *
 * This is the authority defect in a second costume. There the question was "who says you may
 * act", and the answer was the actor itself. Here it is "who says the work was checked", and
 * the answer was the same: the verifying agent, believed.
 *
 * Two departments already computed the honest answer, under a comment reading "Serva computes
 * this; a verdict that says PASS while half the criteria were never looked at is the failure
 * acceptance exists to catch". Three others — QA, accessibility and SECURITY — wrote
 * `verdict: output.verdict` straight into canon. An agent could report PASS for the security
 * stage with `threatsExercised: []` and every threat listed in `notVerified`, and Serva
 * persisted a clean bill of health.
 *
 * And where the downgrade did exist it tested `=== PASS` alone, so `PASS_WITH_QUALIFICATION`
 * bypassed it — while the Release department reads exactly that field to choose RECOMMEND or
 * HOLD.
 *
 * One helper, used by every department, so the next one written cannot quietly omit it.
 */

/** What the agent says it actually exercised, counted rather than described. */
export interface VerdictSupport {
  /** Criteria judged, threats exercised, NFRs measured — whatever this stage checks. */
  readonly exercised: number;
  /** Areas the agent itself says it did not verify. */
  readonly notVerified: number;
}

/** Verdicts that assert something was checked, and therefore need support. */
const CLAIMS_SUCCESS: ReadonlySet<string> = new Set([
  VerificationVerdict.PASS,
  VerificationVerdict.PASS_WITH_QUALIFICATION,
]);

/**
 * The verdict Serva records, which is the agent's verdict or something weaker.
 *
 * Only ever weakens. A FAIL stays a FAIL and a NOT_VERIFIED stays NOT_VERIFIED — this exists
 * to stop an unsupported success, not to second-guess a refusal.
 *
 * "Unsupported" is deliberately narrow: exercising NOTHING while claiming success. Partial
 * coverage is what `PASS_WITH_QUALIFICATION` and `notVerified` are for, and treating it as a
 * failure would push agents toward reporting less rather than more.
 */
export function supportedVerdict<T extends string>(
  verdict: T,
  support: VerdictSupport,
): T | typeof VerificationVerdict.NOT_VERIFIED {
  if (!CLAIMS_SUCCESS.has(verdict)) return verdict;
  if (support.exercised > 0) return verdict;
  return VerificationVerdict.NOT_VERIFIED;
}

/**
 * THE VERDICT FAMILIES, AND WHAT COUNTS AS AFFIRMATIVE IN EACH.
 *
 * SPEC: Phase 6 targeted hardening, class 2; finding
 * ORGANIZATIONAL-LEARNING-DEPARTMENTS-A/F2.
 *
 * `supportedVerdict` closed the unsupported-success hole for PASS/FAIL, and the next review
 * found it intact one enum over: four reviewer departments compared `output.verdict ===
 * 'ACCEPTABLE'` against a `findings` array declared `.default([])` with no `minItems`, so a
 * reviewer could record a met judgement having examined nothing.
 *
 * The comment above claimed the fix held "by every department, so the next one written cannot
 * quietly omit it". It did not hold, because it understood one vocabulary. This understands
 * both, and refuses a verdict answered in the wrong one — a department cannot launder a
 * judgement by replying PASS to an ACCEPTABLE question.
 */
export const VerdictFamily = {
  /** PASS / PASS_WITH_QUALIFICATION / FAIL / NOT_VERIFIED. */
  VERIFICATION: 'VERIFICATION',
  /** ACCEPTABLE / NOT_ACCEPTABLE. */
  REVIEW: 'REVIEW',
} as const;
export type VerdictFamily = (typeof VerdictFamily)[keyof typeof VerdictFamily];

const AFFIRMATIVE: Readonly<Record<VerdictFamily, readonly string[]>> = Object.freeze({
  VERIFICATION: [VerificationVerdict.PASS, VerificationVerdict.PASS_WITH_QUALIFICATION],
  REVIEW: ['ACCEPTABLE'],
});

export interface VerdictEvidence {
  /** Criteria judged, findings raised, threats exercised — whatever this decision rests on. */
  readonly examined: number;
  /**
   * Which vocabulary the answer must be in.
   *
   * Omitted where a call site accepts either, in which case a verdict affirmative in EITHER
   * family counts. Naming it is stronger and every production call site does.
   */
  readonly family?: VerdictFamily;
}

/**
 * Does this verdict actually assert success, in its own family, with something behind it?
 *
 * Three ways to answer no, and each was a real finding: the value is not an affirmative
 * verdict at all, it is affirmative in a different vocabulary than the one being asked, or it
 * is affirmative and nothing was examined.
 */
export function verdictIsAffirmative(verdict: string, evidence: VerdictEvidence): boolean {
  const families =
    evidence.family === undefined
      ? [VerdictFamily.VERIFICATION, VerdictFamily.REVIEW]
      : [evidence.family];

  const affirmative = families.some((f) => AFFIRMATIVE[f].includes(verdict));
  if (!affirmative) return false;

  /* A success that examined nothing examined nothing, whatever it is called. */
  return evidence.examined > 0;
}

/**
 * A reviewer's judgement, resolved against what was actually under review.
 *
 * SPEC: Phase 6 targeted hardening, class 2.
 *
 * The obvious evidence for a review is its findings — and it is the wrong one. A CLEAN review
 * legitimately raises zero findings, so counting them conflates "found nothing wrong" with
 * "looked at nothing", and the first is what a healthy project produces most of the time.
 *
 * `subjects` is the honest measure: the artifacts the judgement records itself as covering,
 * computed from the STORE by `currentSubjects` rather than written by the agent. Nothing the
 * reviewer says can move that number, which is the property wanted — a review of no subjects
 * examined nothing whatever it concluded, and a review of five that raised no finding is
 * simply a clean review.
 */
export function reviewJudgement(verdict: string, subjects: readonly unknown[]): boolean {
  return verdictIsAffirmative(verdict, {
    examined: subjects.length,
    family: VerdictFamily.REVIEW,
  });
}
