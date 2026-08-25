import { z } from 'zod';
import { RefSchema, artifact, enumOf } from './base.js';
import { Confidence } from '../provenance.js';

/**
 * ORGANIZATIONAL LEARNING — and the wall around it.
 *
 * SPEC: 11, 27, 28, 06 (SC-AGENT-280/290/291).
 *
 * Two things must both be true, and they pull against each other:
 *
 *   Serva should get better at building software as it builds more of it;
 *   nothing about one client's project may reach another.
 *
 * The resolution is that the ONLY thing allowed to cross a project boundary is a
 * generalisation — a pattern, a lesson, an approach that failed — with every identifying
 * detail removed by the Knowledge Curator before it leaves. Raw requirements, code,
 * evidence, client names and secrets never cross, and `leakageRefusal` treats a
 * cross-project artifact carrying them as a defect rather than an oversight.
 *
 * The second protection is that a learned pattern arrives as a CANDIDATE, never as an
 * instruction. `SC-AGENT-291` decides independently whether it applies here, because
 * "this worked last time" is the reasoning behind most inappropriate architecture.
 */

export const CandidateStatus = {
  CANDIDATE: 'CANDIDATE',
  APPLIED: 'APPLIED',
  REJECTED: 'REJECTED',
} as const;
export type CandidateStatus = (typeof CandidateStatus)[keyof typeof CandidateStatus];

/**
 * A lesson, generalised.
 *
 * `generalised` is a required assertion by the Curator, not an inference. Something that
 * has not been through generalisation cannot become cross-project knowledge at all.
 */
export const LessonLearnedSchema = artifact({
  statement: z.string().min(1),
  context: z.string().min(1),
  generalised: z.literal(true),
  /** What kind of situation this applies to — never which project it came from. */
  applicableWhen: z.string().min(1),
});
export type LessonLearned = z.output<typeof LessonLearnedSchema>;

export const ReusablePatternSchema = artifact({
  name: z.string().min(1),
  problem: z.string().min(1),
  solution: z.string().min(1),
  generalised: z.literal(true),
  applicableWhen: z.string().min(1),
  /** The conditions under which it is a bad idea. A pattern without these is a fashion. */
  notApplicableWhen: z.array(z.string().min(1)).min(1),
  tradeoffs: z.array(z.string().min(1)).default([]),
  status: enumOf(CandidateStatus),
});
export type ReusablePattern = z.output<typeof ReusablePatternSchema>;

/**
 * Something that did not work.
 *
 * As valuable as the patterns and much rarer, because failure is what nobody writes down.
 * Recording it is what stops the company rediscovering the same dead end.
 */
export const FailedApproachSchema = artifact({
  approach: z.string().min(1),
  whyItFailed: z.string().min(1),
  generalised: z.literal(true),
  symptomsToWatchFor: z.array(z.string().min(1)).default([]),
});
export type FailedApproach = z.output<typeof FailedApproachSchema>;

/**
 * The independent judgement that a pattern fits THIS project.
 *
 * SPEC: §38 — prior success is not authority. A Decision that leans on a learned pattern
 * must cite both the pattern and one of these, so "we did it this way before" is never
 * sufficient on its own.
 */
export const ApplicabilityAssessmentSchema = artifact({
  patternRef: RefSchema,
  applies: z.boolean(),
  rationale: z.string().min(1),
  confidence: enumOf(Confidence),
  /** How this project differs from the one the pattern came from. */
  differences: z.array(z.string().min(1)).default([]),
  assessedBy: z.string().min(1),
  /**
   * The governed run that made this assessment.
   *
   * Optional only so records written before the invariant sweep still parse; a record without
   * one cannot satisfy `patternUsageRefusal`, which is the honest treatment of an assessment
   * nobody can trace to a run.
   */
  assessorRunId: z.string().min(1).optional(),
});
export type ApplicabilityAssessment = z.output<typeof ApplicabilityAssessmentSchema>;

/** Anything offered to a future project. The only shape allowed to cross a boundary. */
export const CandidateItemSchema = artifact({
  kind: z.enum(['PATTERN', 'LESSON', 'FAILED_APPROACH']),
  ref: RefSchema,
  summary: z.string().min(1),
  status: enumOf(CandidateStatus),
});
export type CandidateItem = z.output<typeof CandidateItemSchema>;

/**
 * Shapes that must never appear in cross-project knowledge.
 *
 * Deliberately blunt and deliberately conservative. This is a backstop for a rule the
 * Curator is meant to have already applied, and a false positive costs a rewrite while a
 * false negative costs a client's confidentiality.
 */
const LEAKAGE_PATTERNS: readonly { readonly what: string; readonly re: RegExp }[] = Object.freeze([
  /*
   * INSTANCE ids, not catalogue ids.
   *
   * `SC-REQ-000042` names one project's requirement and must never cross; `SC-GATE-QA`
   * names a canonical gate every project shares and is exactly the vocabulary a general
   * lesson needs. The numeric suffix tells them apart, so the rule matches on that rather
   * than on the family — widening this to every `SC-` token would refuse the sentences the
   * library exists to carry.
   */
  { what: 'a Serva project identifier', re: /\bSC-[A-Z]{2,}-(?:\d{4,}|[0-9A-Z]{12,})\b/ },
  /*
   * A Windows drive with EITHER separator. The original pattern required a backslash, so
   * `d:/clients/acme/src/checkout.ts` — the form most tools print — went straight through.
   * Harmless while a lesson stayed inside its own project; not harmless now that one can
   * cross into somebody else's.
   */
  {
    what: 'a file path',
    re: /(^|\s)(?:[A-Za-z]:[\\/]|\/(?:home|Users|var|opt|mnt|srv|clients)\/)/,
  },
  /* A path-shaped token with a file extension, wherever it sits in a sentence. */
  { what: 'a file path', re: /\b[\w.-]+\/[\w.-]+\/[\w.-]+\.[A-Za-z0-9]{1,6}\b/ },
  {
    what: 'a source-code fragment',
    /* Inline backticks around a call are as much code as a fenced block is. */
    re: /```|`[^`]*\w+\s*\([^`]*`|\bfunction\s+\w+\s*\(|\bclass\s+\w+\s*\{/,
  },
  { what: 'a URL', re: /https?:\/\//i },
  { what: 'an email address', re: /[\w.+-]+@[\w-]+\.[\w.]+/ },
  { what: 'a credential-shaped value', re: /\b(api[_-]?key|secret|token|password|bearer)\b/i },
  { what: 'a connection string', re: /\b(postgres|mysql|mongodb|redis|amqp):\/\//i },
]);

/**
 * Does this generalisation still carry project-specific material?
 *
 * Returns every reason it must not cross, so a Curator sees the whole list rather than
 * fixing them one run at a time.
 */
export function leakageRefusal(text: string): readonly string[] {
  const found: string[] = [];
  for (const p of LEAKAGE_PATTERNS) {
    if (p.re.test(text)) found.push('cross-project knowledge must not contain ' + p.what);
  }
  return found;
}
