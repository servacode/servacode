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
