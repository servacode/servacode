import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { IsoSchema } from '../domain/schemas.js';
import type { RepositoryIdentity } from './proof.js';
import type { Store } from '../store/store.js';

/**
 * THE INDEPENDENT SECURITY REVIEW, AS TYPED EVIDENCE.
 *
 * SPEC: Phase 6 final acceptance sequence §7.
 *
 * This is the requirement that took the whole acceptance model apart once already: a markdown
 * line reading `Independent reviewer: Jane Roe` produced a green Security Acceptance, and my
 * own test suite proved the synthetic file passed.
 *
 * So a security review is a record with a run behind it. `resolveSecurityReview` re-checks
 * every part against the world:
 *
 *   the EXACT implementation commit, re-derived from the repository rather than read here;
 *   a reviewer AgentRun that resolves in a real store and COMPLETED;
 *   an authority that is actually a verifier — a Producer cannot review;
 *   independence from every actor that produced the reviewed work;
 *   a scope that covers what was asked for, so a review of one file is not a review;
 *   findings with severities, and a verdict that AGREES with them.
 *
 * That last one matters more than it sounds. A review naming a CRITICAL finding and declaring
 * itself ACCEPTED is not a review with a bug in it — it is the exact failure this whole
 * product exists to refuse, and it is checked rather than trusted.
 */

export const Severity = {
  CRITICAL: 'CRITICAL',
  HIGH: 'HIGH',
  MEDIUM: 'MEDIUM',
  LOW: 'LOW',
  INFO: 'INFO',
} as const;
export type Severity = (typeof Severity)[keyof typeof Severity];

export const ReviewVerdict = {
  /** No CRITICAL or HIGH finding. The commit may proceed. */
  ACCEPTED: 'ACCEPTED',
  /** At least one CRITICAL or HIGH finding. */
  BLOCKED: 'BLOCKED',
  /** The review could not be completed. Never a pass. */
  NOT_VERIFIED: 'NOT_VERIFIED',
} as const;
export type ReviewVerdict = (typeof ReviewVerdict)[keyof typeof ReviewVerdict];

/** Everything §7 requires the review to have looked at. */
export const REQUIRED_SCOPE: readonly string[] = Object.freeze([
  'Core Store/integrity',
  'Owner authority',
  'AI Runtime',
  'Engineering HARD boundary',
  'qualification transport semantics',
  'Research trust',
  'VS Code/webview authority',
  'New Project flow',
  'Conversation governance',
  'Reconciliation',
  'backup/restore',
  'migration',
  'bootstrap',
  'install/update/rollback',
  'organizational learning',
  'release/handover',
  'Serva self-acceptance authority',
]);

export const SecurityFindingSchema = z
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
    /** Where the reviewer looked. A finding with nothing behind it cannot be acted on. */
    evidence: z.array(z.string().min(1)).min(1),
  })
  .strict();
export type SecurityFinding = z.output<typeof SecurityFindingSchema>;

export const SecurityReviewSchema = z
  .object({
    implementationCommit: z.string().regex(/^[0-9a-f]{40}$/),
    treeDigest: z.string().regex(/^[0-9a-f]{40}$/),
    reviewerRunId: z.string().min(1),
    reviewerAgentId: z.string().regex(/^SC-AGENT-\d{3}$/),
    /** The canonical authority the contract grants this agent. Must be a verifier's. */
    reviewerAuthority: z.string().min(1),
    /**
     * Why this reviewer is independent of what it reviewed.
     *
     * Recorded rather than assumed, because the one thing an independence claim must not be
     * is implicit — and named so a reader can check it against the run.
     */
    independence: z
      .object({
        implementationProducers: z.array(z.string().min(1)),
        statement: z.string().min(1),
      })
      .strict(),
    scope: z.array(z.string().min(1)).min(1),
    findings: z.array(SecurityFindingSchema),
    verdict: z.enum([ReviewVerdict.ACCEPTED, ReviewVerdict.BLOCKED, ReviewVerdict.NOT_VERIFIED]),
    reviewedAt: IsoSchema,
    storePath: z.string().min(1),
  })
  .strict();
export type SecurityReview = z.output<typeof SecurityReviewSchema>;

export const REVIEW_PATH = 'evidence/acceptance-run/security-review.json';

export interface SecurityResolution {
  readonly resolved: boolean;
  readonly review?: SecurityReview;
  readonly blocking: readonly SecurityFinding[];
  readonly refusals: readonly string[];
}

export interface ResolveSecurityInput {
  readonly root: string;
  readonly repository?: RepositoryIdentity;
  /** Opens the store the reviewer run lives in. Injected so tests need no filesystem. */
  readonly openStore?: (storePath: string) => Store | undefined;
  /** Authorities that count as a verifier's rather than a producer's. */
  readonly verifierAuthorities?: ReadonlySet<string>;
}

const DEFAULT_VERIFIER_AUTHORITIES: ReadonlySet<string> = new Set(['VERIFY', 'REVIEW', 'ASSESS']);

/**
 * Resolve a security review against the repository, the store and its own findings.
 *
 * Returns every refusal. A review that fails three ways is a different situation from one that
 * fails once, and an author needs to see which they have.
 */
export function resolveSecurityReview(input: ResolveSecurityInput): SecurityResolution {
  const refusals: string[] = [];
  const path = join(input.root, ...REVIEW_PATH.split('/'));

  if (!existsSync(path)) {
    return {
      resolved: false,
      blocking: [],
      refusals: ['no security review at ' + REVIEW_PATH],
    };
  }

  const parsed = SecurityReviewSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
  if (!parsed.success) {
    return {
      resolved: false,
      blocking: [],
      refusals: [
        'the security review is malformed: ' +
          parsed.error.issues
            .slice(0, 3)
            .map((i) => i.path.join('.') + ' ' + i.message)
            .join('; '),
      ],
    };
  }
  const review = parsed.data;

  /* ------------------------------------------------------------------ the commit */

  if (input.repository === undefined) {
    refusals.push('repository identity could not be read, so this review binds to nothing');
  } else {
    if (review.implementationCommit !== input.repository.commit) {
      refusals.push(
        'the review describes commit ' +
          review.implementationCommit.slice(0, 12) +
          ' and this package is ' +
          input.repository.commit.slice(0, 12) +
          '; a review of an earlier commit is stale by construction',
      );
    }
    if (review.treeDigest !== input.repository.tree) {
      refusals.push(
        'the review describes tree ' +
          review.treeDigest.slice(0, 12) +
          ' and this package is ' +
          input.repository.tree.slice(0, 12) +
          '; the implementation changed after it was reviewed',
      );
    }
  }

  /* ------------------------------------------------------------------- the run */

  const store = input.openStore?.(review.storePath);
  if (store === undefined) {
    refusals.push('the store at ' + review.storePath + ' could not be opened to resolve the run');
  } else {
    const record = store.getCanon<{ agentId?: string; outcome?: string }>(
      'agentRunRecord',
      review.reviewerRunId,
    )?.body;
    if (record === undefined) {
      refusals.push(review.reviewerRunId + ' does not resolve to a run in that store');
    } else {
      if (record.outcome !== 'COMPLETED') {
        refusals.push(
          review.reviewerRunId + ' ended ' + String(record.outcome) + ', so it reviewed nothing',
        );
      }
      if (record.agentId !== review.reviewerAgentId) {
        refusals.push(
          'the run was made by ' +
            String(record.agentId) +
            ' and the review names ' +
            review.reviewerAgentId,
        );
      }
    }
  }

  /* ------------------------------------------------------------- the authority */

  const verifiers = input.verifierAuthorities ?? DEFAULT_VERIFIER_AUTHORITIES;
  if (!verifiers.has(review.reviewerAuthority.toUpperCase())) {
    refusals.push(
      'the reviewer holds ' +
        review.reviewerAuthority +
        ', which is not a verifier authority; an agent that can produce cannot certify',
    );
  }

  if (review.independence.implementationProducers.includes(review.reviewerAgentId)) {
    refusals.push(
      review.reviewerAgentId +
        ' produced the work it reviewed, so this is not an independent review',
    );
  }

  /* ---------------------------------------------------------------- the scope */

  const missing = REQUIRED_SCOPE.filter(
    (area) => !review.scope.some((s) => s.toLowerCase().includes(area.toLowerCase().slice(0, 8))),
  );
  if (missing.length > 0) {
    refusals.push('the review did not cover: ' + missing.join(', '));
  }

  /* ------------------------------------------------- the verdict and the findings */

  const blocking = review.findings.filter(
    (f) => f.severity === Severity.CRITICAL || f.severity === Severity.HIGH,
  );

  /*
   * THE VERDICT MUST AGREE WITH THE FINDINGS.
   *
   * A review naming a CRITICAL finding and declaring itself ACCEPTED is not a review with a
   * bug in it. It is the failure this product exists to refuse, arriving in the one document
   * that is supposed to catch such things.
   */
  if (blocking.length > 0 && review.verdict === ReviewVerdict.ACCEPTED) {
    refusals.push(
      'the review declares ACCEPTED while naming ' +
        String(blocking.length) +
        ' CRITICAL/HIGH finding(s): ' +
        blocking.map((f) => f.id).join(', '),
    );
  }
  if (blocking.length === 0 && review.verdict === ReviewVerdict.BLOCKED) {
    refusals.push('the review declares BLOCKED while naming no CRITICAL or HIGH finding');
  }
  if (review.verdict !== ReviewVerdict.ACCEPTED) {
    refusals.push('the verdict is ' + review.verdict);
  }

  return {
    resolved: refusals.length === 0,
    review,
    blocking,
    refusals,
  };
}
