import { z } from 'zod';
import { artifact, enumOf } from '../artifacts/base.js';
import { RefSchema } from '../artifacts/base.js';
import { captureIsIntact } from './capture.js';
import type { SourceCapture } from './capture.js';

/**
 * SOURCE VERIFICATION — independent, and offline by construction.
 *
 * SPEC: §12, 06 (SC-AGENT-063).
 *
 * Two constraints define this department, and both are structural rather than
 * behavioural:
 *
 *   the Verifier may NOT re-fetch. It checks claims against captured evidence, so its
 *   verdict is about what the researcher actually saw. A verifier with network access
 *   would silently be doing new research, and "I found something that supports this"
 *   is a different statement from "the cited source supports this".
 *
 *   the Verifier may not be the actor that produced the claim. Marking your own homework
 *   is not verification, and the temptation is strongest exactly when the claim is
 *   convenient.
 *
 * `SOURCE_MISSING` exists as a first-class verdict because the most common real failure is
 * not a false claim — it is a claim citing a source that says nothing about it.
 */

export const ClaimVerdict = {
  SUPPORTED: 'SUPPORTED',
  PARTIALLY_SUPPORTED: 'PARTIALLY_SUPPORTED',
  NOT_SUPPORTED: 'NOT_SUPPORTED',
  /** The cited capture does not exist, or no longer matches its digest. */
  SOURCE_MISSING: 'SOURCE_MISSING',
  /** The source could mean this, or could not. Honest, and blocks authority. */
  AMBIGUOUS: 'AMBIGUOUS',
} as const;
export type ClaimVerdict = (typeof ClaimVerdict)[keyof typeof ClaimVerdict];

export const ClaimVerificationSchema = artifact({
  claimRef: RefSchema,
  claim: z.string().min(1),
  verdict: enumOf(ClaimVerdict),
  /** Which capture was checked, and the passage relied on. */
  captureRefs: z.array(RefSchema).default([]),
  reasoning: z.string().min(1),
  /** The verifying run, which must differ from the run that made the claim. */
  verifiedByRunId: z.string().min(1),
  verifiedByAgentId: z.string().min(1),
});
export type ClaimVerification = z.output<typeof ClaimVerificationSchema>;

/** Verdicts that permit a claim to become authoritative market truth. */
const AUTHORITATIVE: readonly ClaimVerdict[] = Object.freeze([
  ClaimVerdict.SUPPORTED,
  ClaimVerdict.PARTIALLY_SUPPORTED,
]);

export function claimIsAuthoritative(v: ClaimVerification): boolean {
  return AUTHORITATIVE.includes(v.verdict);
}

/**
 * Is this verification usable?
 *
 * Checks the two structural rules and the integrity of the evidence. A verification
 * produced by the claimant, or resting on a capture whose digest no longer matches, is
 * not weaker evidence — it is not evidence.
 */
export function verificationRefusal(
  v: ClaimVerification,
  o: {
    /** The run and actor that produced the claim being checked. */
    readonly claimRunId?: string;
    readonly claimAgentId?: string;
    readonly captures: readonly SourceCapture[];
  },
): string | undefined {
  if (o.claimRunId !== undefined && v.verifiedByRunId === o.claimRunId) {
    return (
      'ClaimVerification ' +
      v.id +
      ' was produced by the same run that made the claim: marking your own homework is not verification'
    );
  }
  if (o.claimAgentId !== undefined && v.verifiedByAgentId === o.claimAgentId) {
    return (
      'ClaimVerification ' +
      v.id +
      ' was produced by the same actor that made the claim (' +
      o.claimAgentId +
      ')'
    );
  }
  if (v.verdict !== ClaimVerdict.SOURCE_MISSING && v.captureRefs.length === 0) {
    return (
      'ClaimVerification ' +
      v.id +
      ' reached ' +
      v.verdict +
      ' while citing no captured source, so nothing was actually checked'
    );
  }
  for (const ref of v.captureRefs) {
    const capture = o.captures.find((c) => c.id === ref.id);
    if (capture === undefined) {
      return 'ClaimVerification ' + v.id + ' cites capture ' + ref.id + ', which is not stored';
    }
    if (!captureIsIntact(capture)) {
      return (
        'capture ' +
        capture.id +
        ' no longer matches its content digest, so it cannot support a verification'
      );
    }
  }
  return undefined;
}

/**
 * Which claims may not become authoritative.
 *
 * Returned as a list rather than thrown, because the right place for this is a gate
 * finding — an unverified claim should stop a competitive conclusion, not crash a run.
 */
export function unauthoritativeClaims(
  verifications: readonly ClaimVerification[],
): readonly { readonly claimId: string; readonly verdict: ClaimVerdict; readonly why: string }[] {
  return verifications
    .filter((v) => !claimIsAuthoritative(v))
    .map((v) => ({
      claimId: v.claimRef.id,
      verdict: v.verdict,
      why:
        v.verdict === ClaimVerdict.SOURCE_MISSING
          ? 'the cited source is missing or altered'
          : v.verdict === ClaimVerdict.NOT_SUPPORTED
            ? 'the source does not support the claim'
            : 'the source is ambiguous about the claim',
    }));
}
