import { z } from 'zod';
import { IsoSchema } from '../../domain/schemas.js';
import { RefSchema, artifact, enumOf } from './base.js';

/**
 * DOWNSTREAM QUALITY — THE VERDICTS NOBODY MAY GIVE THEMSELVES.
 *
 * SPEC: §12, §20, 06 (SC-AGENT-213/214/220/230/240), 18, 31 §4.1.
 *
 * Phase 4 proved a change builds, passes its declared suite, stays in scope and carries no
 * secret. Those are MEASUREMENTS, and Serva already treats them as the evidence authority
 * they are: no agent opinion makes a failing check pass.
 *
 * What these families add is the part a measurement cannot answer — whether the thing that
 * builds is the thing that was asked for. A green suite says the tests the author wrote
 * agree with the code the author wrote. An acceptance verdict says a requirement is
 * actually met, and it is a JUDGEMENT, so it carries the two things a judgement needs to
 * be worth anything: who made it, and what they looked at.
 *
 * One rule shapes every schema below. A verdict names the exact subjects it judged, at the
 * versions it judged them at. Without that, a review survives the thing it reviewed — the
 * requirement changes, the verdict does not, and a stale approval quietly keeps counting.
 * `subjects` is how readiness knows to stop believing it.
 *
 * `NOT_VERIFIED` is a first-class verdict everywhere, and it is not a softer failure. A
 * verifier that could not tell has said something true and useful; forcing that into PASS
 * or FAIL would be inventing the one piece of information the run did not have.
 */

/** What a verifier concluded. `NOT_VERIFIED` is honest, and it blocks. */
export const VerificationVerdict = {
  PASS: 'PASS',
  PASS_WITH_QUALIFICATION: 'PASS_WITH_QUALIFICATION',
  FAIL: 'FAIL',
  /** The verifier could not establish it. Never treated as either outcome. */
  NOT_VERIFIED: 'NOT_VERIFIED',
} as const;
export type VerificationVerdict = (typeof VerificationVerdict)[keyof typeof VerificationVerdict];

export const DefectSeverity = {
  CRITICAL: 'CRITICAL',
  HIGH: 'HIGH',
  MEDIUM: 'MEDIUM',
  LOW: 'LOW',
} as const;
export type DefectSeverity = (typeof DefectSeverity)[keyof typeof DefectSeverity];

/** The exact artifact version a verdict rests on. */
export const SubjectSchema = z
  .object({
    id: z.string().min(1),
    version: z.number().int().positive(),
  })
  .strict();

/**
 * The fields every downstream verdict shares.
 *
 * `notVerified` is separate from `findings` on purpose: "I checked and it is wrong" and
 * "I could not check" are different results, and collapsing them is how an unverifiable
 * area comes to look like a clean one.
 */
const verdictShape = {
  verdict: enumOf(VerificationVerdict),
  /** The ChangeSet or release candidate this judges. */
  subjectRef: RefSchema,
  /** Exactly what was judged, at the versions judged. Readiness re-checks these. */
  subjects: z.array(SubjectSchema).default([]),
  summary: z.string().min(1),
  /** Areas the verifier deliberately did not cover, and why. */
  notVerified: z
    .array(z.object({ area: z.string().min(1), why: z.string().min(1) }).strict())
    .default([]),
  /** The run that produced this judgement. Attribution a reader can follow. */
  verifiedByRunId: z.string().min(1),
  verifiedByAgentId: z.string().min(1),
  verifiedAt: IsoSchema,
};

/** SC-AGENT-214 — does the change do what the acceptance criteria say? */
export const QAVerdictSchema = artifact({
  ...verdictShape,
  /** Requirements or acceptance criteria exercised, by id. */
  criteriaCovered: z.array(z.string().min(1)).default([]),
  defectRefs: z.array(RefSchema).default([]),
});
export type QAVerdict = z.output<typeof QAVerdictSchema>;

/** Something observed to be wrong. Raised by QA, never by the author. */
export const DefectSchema = artifact({
  title: z.string().min(1),
  detail: z.string().min(1),
  severity: enumOf(DefectSeverity),
  /** What it breaks: a requirement, a criterion, a flow. */
  affects: z.array(RefSchema).default([]),
  reproduction: z.string().min(1),
  state: z.enum(['OPEN', 'FIXED', 'ACCEPTED_AS_IS', 'NOT_A_DEFECT']).default('OPEN'),
  foundByAgentId: z.string().min(1),
});
export type Defect = z.output<typeof DefectSchema>;

/** SC-AGENT-213 — is the accessibility specification actually honoured? */
export const AccessibilityVerdictSchema = artifact({
  ...verdictShape,
  standard: z.string().min(1),
  /**
   * Checks a machine performed, separate from what a person judged.
   *
   * Kept apart because automated accessibility checking finds a minority of real problems
   * and finding none proves very little. Reporting the two together would let a clean
   * automated sweep read as a compliant product, which is the claim §37 refuses to make.
   */
  automatedChecks: z
    .array(
      z
        .object({
          check: z.string().min(1),
          passed: z.boolean(),
          detail: z.string().min(1).optional(),
        })
        .strict(),
    )
    .default([]),
  findings: z
    .array(
      z
        .object({
          issue: z.string().min(1),
          severity: enumOf(DefectSeverity),
          where: z.string().min(1),
        })
        .strict(),
    )
    .default([]),
});
export type AccessibilityVerdict = z.output<typeof AccessibilityVerdictSchema>;

/** SC-AGENT-220 — was the threat model actually tested against the built thing? */
export const SecurityVerdictSchema = artifact({
  ...verdictShape,
  /** Abuse cases and threats exercised, by id. Coverage nobody can infer from a summary. */
  threatsExercised: z.array(RefSchema).default([]),
  findingRefs: z.array(RefSchema).default([]),
});
export type SecurityVerdict = z.output<typeof SecurityVerdictSchema>;

export const SecurityFindingSchema = artifact({
  title: z.string().min(1),
  detail: z.string().min(1),
  severity: enumOf(DefectSeverity),
  /** The threat or abuse case this realises, where one was modelled. */
  threatRef: RefSchema.optional(),
  evidence: z.string().min(1),
  remediation: z.string().min(1),
  state: z.enum(['OPEN', 'FIXED', 'RISK_ACCEPTED', 'FALSE_POSITIVE']).default('OPEN'),
  /** A risk accepted by anybody other than the owner is not accepted. */
  acceptedByOwnerDecisionRef: RefSchema.optional(),
  foundByAgentId: z.string().min(1),
});
export type SecurityFinding = z.output<typeof SecurityFindingSchema>;

/** SC-AGENT-230 — do the measured numbers meet the declared NFR targets? */
export const PerformanceVerdictSchema = artifact({
  ...verdictShape,
  /**
   * Measurements against targets.
   *
   * `measured` is optional because an NFR nobody could measure is the common case and the
   * honest record of it is a missing number, not a zero. A target with no measurement
   * makes the verdict NOT_VERIFIED rather than PASS.
   */
  measurements: z
    .array(
      z
        .object({
          nfrRef: RefSchema,
          target: z.string().min(1),
          measured: z.string().min(1).optional(),
          met: z.boolean().optional(),
          method: z.string().min(1),
        })
        .strict(),
    )
    .default([]),
});
export type PerformanceVerdict = z.output<typeof PerformanceVerdictSchema>;

/** SC-AGENT-240 — is what was asked for actually there? */
export const AcceptanceVerdictSchema = artifact({
  ...verdictShape,
  /** Every acceptance criterion, with the judgement made about it. */
  criteria: z
    .array(
      z
        .object({
          criterionRef: RefSchema,
          met: z.boolean(),
          evidence: z.string().min(1),
        })
        .strict(),
    )
    .default([]),
  /** Accepted, but not entirely. Recorded so nobody later reads PASS as unqualified. */
  qualifications: z.array(z.string().min(1)).default([]),
});
export type AcceptanceVerdict = z.output<typeof AcceptanceVerdictSchema>;
