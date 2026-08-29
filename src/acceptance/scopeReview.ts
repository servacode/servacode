import { z } from 'zod';
import { IsoSchema } from '../domain/schemas.js';
import { ReviewVerdict, Severity } from './securityReview.js';
import type { Store } from '../store/store.js';

/**
 * ONE SCOPED SECURITY REVIEW, WRITTEN DOWN BEFORE ANYTHING ELSE HAPPENS.
 *
 * SPEC: finding SSA-5, from the independent security review.
 *
 * The scoped reviewer held its findings in memory and the script exited without writing them.
 * The first real run produced a BLOCKED verdict on `Serva self-acceptance authority` — four
 * genuine defects in the acceptance machinery, one of them HIGH — and left nothing on disk.
 * Reading them back meant paying for the review a second time.
 *
 * That is exactly the wrong way round. A review that finds nothing is cheap to repeat; a
 * review that finds something is the one whose evidence must survive. **A failed or blocked
 * review must leave MORE evidence, not disappear.**
 *
 * So every attempt persists, whatever its outcome — accepted, blocked, refused, out of
 * context, or dead on a provider error after producing something useful. Each record carries
 * what a later resolver needs to aggregate it without re-running a single model call: the
 * commit and tree it judged, the run and agent that judged it, the scope it covers, the files
 * it actually read AND the files it did not, its coverage, its findings with their severities
 * and sources, its terminal outcome, and why it refused when it did.
 */

/** How much of the scope this attempt actually saw. Never rounded up. */
export const ScopeCoverage = {
  /** Every file mapped to this scope was reviewed. */
  COMPLETE: 'COMPLETE',
  /** Some files were omitted. A partial view is never coverage. */
  PARTIAL: 'PARTIAL',
  /** The reviewer never reached a judgement. */
  NOT_REVIEWED: 'NOT_REVIEWED',
} as const;
export type ScopeCoverage = (typeof ScopeCoverage)[keyof typeof ScopeCoverage];

export const ScopeFindingSchema = z
  .object({
    id: z.string().min(1),
    severity: z.enum([
      Severity.CRITICAL,
      Severity.HIGH,
      Severity.MEDIUM,
      Severity.LOW,
      Severity.INFO,
    ]),
    area: z.string().min(1),
    statement: z.string().min(1),
    evidence: z.array(z.string().min(1)).min(1),
    /**
     * Whether this finding has since been addressed.
     *
     * Recorded rather than inferred from a later clean run: a finding that stops appearing may
     * have been fixed, or may simply not have been looked for.
     */
    resolved: z.boolean().default(false),
    resolvedNote: z.string().optional(),
    /**
     * The implementation a resolution was verified at.
     *
     * SPEC: HIGH finding SERVA-SELF-ACCEPTANCE-AUTHORITY/SC-SSA-REV-001.
     *
     * `resolved: true` alone permanently suppressed a finding id at every later commit,
     * because nothing tied the claim to an implementation. A resolution is evidence about one
     * defect at one implementation state; without the state it is an assertion, and finding
     * ids are reviewer-numbered so a regression collided with the old id and stayed muted.
     *
     * Optional in the schema so records written before this parse; a resolution missing them
     * suppresses nothing, which is the honest treatment of a claim nobody can place in time.
     */
    resolvedAtCommit: z
      .string()
      .regex(/^[0-9a-f]{40}$/)
      .optional(),
    resolvedAtTree: z
      .string()
      .regex(/^[0-9a-f]{40}$/)
      .optional(),
  })
  .strict();
export type ScopeFinding = z.output<typeof ScopeFindingSchema>;

export const ScopeReviewSchema = z
  .object({
    id: z.string().min(1),
    /** Canonical, collision-resistant identity for the scope. Never a prefix of a name. */
    scopeId: z.string().min(1),
    /** The scope as REQUIRED_SCOPE names it, so a reader can find it. */
    scopeName: z.string().min(1),
    implementationCommit: z.string().regex(/^[0-9a-f]{40}$/),
    treeDigest: z.string().regex(/^[0-9a-f]{40}$/),
    reviewerRunId: z.string().min(1),
    reviewerAgentId: z.string().regex(/^SC-AGENT-\d{3}$/),
    coverage: z.enum([ScopeCoverage.COMPLETE, ScopeCoverage.PARTIAL, ScopeCoverage.NOT_REVIEWED]),
    filesReviewed: z.array(z.string().min(1)),
    /** Named, because a file nobody read must never read as covered. */
    filesOmitted: z.array(z.string().min(1)),
    findings: z.array(ScopeFindingSchema),
    verdict: z.enum([ReviewVerdict.ACCEPTED, ReviewVerdict.BLOCKED, ReviewVerdict.NOT_VERIFIED]),
    /** How the governed run ended, verbatim. `EVIDENCE_VIOLATION` is a result, not a gap. */
    terminalOutcome: z.string().min(1),
    /** Why this attempt did not produce a usable judgement, when it did not. */
    refusal: z.string().optional(),
    reviewedAt: IsoSchema,
    /** Digest of the source actually reviewed, so a later reader can detect drift. */
    sourceDigest: z.string().optional(),
  })
  .strict();
export type ScopeReview = z.output<typeof ScopeReviewSchema>;

export const SCOPE_REVIEW_CANON_TYPE = 'securityScopeReview';

/** The canonical id for a scope name. Stable, lowercase, and not a substring of anything. */
export function scopeIdOf(scopeName: string): string {
  return scopeName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export type ScopeReviewInput = Omit<ScopeReview, 'id'> & { readonly id?: string };

/**
 * Persist one attempt, and return the id it was written under.
 *
 * Every attempt gets its own record rather than replacing the previous one at the same scope: a
 * retry is new evidence about the same question, not a correction of what came before. An
 * aggregate resolver decides which attempt counts; this only refuses to forget.
 */
export function recordScopeReview(store: Store, input: ScopeReviewInput): string {
  const id =
    input.id ??
    'SC-SSR-' + scopeIdOf(input.scopeName) + '-' + input.reviewerRunId.replace(/[^A-Za-z0-9]/g, '');

  const record = ScopeReviewSchema.parse({
    ...input,
    id,
    scopeId: input.scopeId === '' ? scopeIdOf(input.scopeName) : input.scopeId,
  });

  const tx = store.begin();
  tx.putCanon(SCOPE_REVIEW_CANON_TYPE, record.id, record);
  tx.commit();
  return record.id;
}

export function readScopeReview(store: Store, id: string): ScopeReview | undefined {
  const env = store.getCanon<unknown>(SCOPE_REVIEW_CANON_TYPE, id);
  if (env === undefined) return undefined;
  const parsed = ScopeReviewSchema.safeParse(env.body);
  return parsed.success ? parsed.data : undefined;
}

export function listScopeReviews(store: Store): ScopeReview[] {
  try {
    return store
      .listCanonIds(SCOPE_REVIEW_CANON_TYPE)
      .map((id) => readScopeReview(store, id))
      .filter((r): r is ScopeReview => r !== undefined);
  } catch {
    return [];
  }
}
