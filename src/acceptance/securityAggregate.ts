import { ScopeCoverage, listScopeReviews, scopeIdOf } from './scopeReview.js';
import { REQUIRED_SCOPE, ReviewVerdict, Severity } from './securityReview.js';
import { reviewUnitsFor } from './securityReviewRun.js';
import { implementationProducersFrom, reviewerAuthorityOf } from './reviewAuthority.js';
import type { ScopeFinding, ScopeReview } from './scopeReview.js';
import type { SecurityReview } from './securityReview.js';
import type { RepositoryIdentity } from './proof.js';
import type { ContractRegistry } from '../agents/registry.js';
import type { Store } from '../store/store.js';

/**
 * SEVENTEEN SCOPED REVIEWS, ADDED UP WITHOUT ROUNDING.
 *
 * SPEC: Phase 6 final acceptance sequence §7.
 *
 * The adding-up is where a security review quietly becomes prose. Sixteen clean areas and one
 * that never ran is not "mostly reviewed"; a partial view of an area is not coverage of it; and
 * a HIGH finding nobody resolved is not a footnote on an otherwise green report. Every one of
 * those reads as a pass if the aggregation is a summary rather than a resolution.
 *
 * So this resolves from the persisted scope records — the evidence SSA-5 made durable — and
 * refuses on anything short of: every required area covered, at this exact commit and tree, by
 * a reviewer the registry and the store both vouch for, with nothing CRITICAL or HIGH left
 * unresolved. It spends no model calls, because everything it needs already happened.
 */

export interface AggregateInput {
  readonly store: Store;
  readonly repository: RepositoryIdentity;
  readonly registry: ContractRegistry;
  readonly reviewedAt: string;
  /** Where the scope records live, recorded into the review for later re-resolution. */
  readonly storePath?: string;
}

export interface AggregateOutcome {
  /** Absent unless every condition held. Never a partial review wearing a verdict. */
  readonly review?: SecurityReview;
  /** Every scope record that contributed, so an auditor can re-open each one. */
  readonly scopeRunIds: readonly string[];
  readonly refusals: readonly string[];
}

/**
 * The most recent attempt at each scope, which decides COVERAGE.
 *
 * Coverage is a property of the latest look: an area reviewed completely today is covered
 * however badly an earlier attempt went. FINDINGS are not treated this way — see below.
 */
function latestByScope(reviews: readonly ScopeReview[]): Map<string, ScopeReview> {
  const latest = new Map<string, ScopeReview>();
  for (const r of reviews) {
    const seen = latest.get(r.scopeId);
    if (seen === undefined || r.reviewedAt >= seen.reviewedAt) latest.set(r.scopeId, r);
  }
  return latest;
}

/**
 * EVERY FINDING EVER RECORDED AT A SCOPE, NOT ONLY THE LATEST ATTEMPT'S.
 *
 * SPEC: HIGH finding SERVA-SELF-ACCEPTANCE-AUTHORITY/SC-SSA-F2.
 *
 * The aggregate read findings from the latest attempt alone, so a CRITICAL recorded by an
 * earlier attempt disappeared the moment a later one did not re-report it — and a later run
 * has no obligation to re-find anything. Retrying a scope until it came back quiet would have
 * un-blocked the review.
 *
 * `scopeReview.ts` rejects exactly that inference in its own docstring: "a finding that stops
 * appearing may have been fixed, or may simply not have been looked for". Resolution is a
 * RECORDED fact, so a finding stops blocking when someone marks it resolved and says why —
 * never by going unmentioned.
 *
 * Findings are keyed by id within a scope, so re-reporting the same finding does not double
 * it, and a later attempt CAN resolve one by recording it resolved.
 */
function findingsAcrossAttempts(
  reviews: readonly ScopeReview[],
  scopeId: string,
): readonly ScopeFinding[] {
  const byId = new Map<string, ScopeFinding>();
  for (const r of reviews.filter((x) => x.scopeId === scopeId)) {
    for (const f of r.findings) {
      const seen = byId.get(f.id);
      /* A later resolution wins; a later silence does not. */
      if (seen === undefined || (!seen.resolved && f.resolved)) byId.set(f.id, f);
    }
  }
  return [...byId.values()];
}

export function aggregateSecurityReview(input: AggregateInput): AggregateOutcome {
  const store = input.store;
  const refusals: string[] = [];
  const all = listScopeReviews(input.store);
  const latest = latestByScope(all);

  const contributing: ScopeReview[] = [];
  const findings: ScopeFinding[] = [];
  const reviewers = new Set<string>();

  /*
   * COVERAGE IS DECIDED PER UNIT AND REPORTED PER AREA.
   *
   * An area split into sub-scopes is covered only when every one of its units is. Splitting a
   * thing you cannot finish does not finish it — it only makes the gap easier to see, which is
   * the whole point of splitting it.
   */
  for (const area of REQUIRED_SCOPE) {
    for (const { unit } of reviewUnitsFor(area)) {
      const record = latest.get(scopeIdOf(unit));

      if (record === undefined) {
        refusals.push('no security review is recorded for "' + unit + '" (' + area + ')');
        continue;
      }

      contributing.push(record);
      reviewers.add(record.reviewerAgentId);

      if (record.implementationCommit !== input.repository.commit) {
        refusals.push(
          '"' +
            unit +
            '" was reviewed at commit ' +
            record.implementationCommit.slice(0, 12) +
            ' and this package is ' +
            input.repository.commit.slice(0, 12),
        );
      }
      if (record.treeDigest !== input.repository.tree) {
        refusals.push('"' + unit + '" was reviewed against a different tree than this package is');
      }

      if (record.coverage !== ScopeCoverage.COMPLETE) {
        refusals.push(
          '"' +
            unit +
            '" has coverage ' +
            record.coverage +
            (record.filesOmitted.length === 0
              ? ''
              : ' (' + String(record.filesOmitted.length) + ' file(s) not reviewed)') +
            ', and a partial view of an area is not coverage of it',
        );
      }

      if (record.terminalOutcome !== 'COMPLETED') {
        refusals.push(
          '"' +
            unit +
            '" ended ' +
            record.terminalOutcome +
            (record.refusal === undefined ? '' : ': ' + record.refusal),
        );
      }

      /*
       * THE RUN IS RESOLVED, NOT READ OFF THE RECORD.
       *
       * SPEC: HIGH finding SERVA-SELF-ACCEPTANCE-AUTHORITY/SC-SSA-F1.
       *
       * This module derived authority and independence canonically and then believed each
       * record's own `terminalOutcome` about whether its run happened at all.
       * `resolveSecurityReview` performs exactly this check a few files away, with a comment
       * saying why — so the fix was in view and simply not applied here. Downstream,
       * `resolveProof` re-verifies only the ONE run the aggregate names, which left the other
       * twenty-one confirmed by nobody.
       */
      const run = store.getCanon<{ agentId?: string; outcome?: string }>(
        'agentRunRecord',
        record.reviewerRunId,
      )?.body;

      if (run === undefined) {
        refusals.push(
          '"' + unit + '" cites reviewer run ' + record.reviewerRunId + ', which does not resolve',
        );
      } else {
        if (run.outcome !== 'COMPLETED') {
          refusals.push(
            'reviewer run ' +
              record.reviewerRunId +
              ' for "' +
              unit +
              '" ended ' +
              String(run.outcome) +
              ', so it reviewed nothing',
          );
        }
        if (run.agentId !== record.reviewerAgentId) {
          refusals.push(
            'reviewer run ' +
              record.reviewerRunId +
              ' for "' +
              unit +
              '" was made by ' +
              String(run.agentId) +
              ', not the ' +
              record.reviewerAgentId +
              ' the record names',
          );
        }
      }

      if (record.verdict === ReviewVerdict.NOT_VERIFIED) {
        refusals.push('"' + unit + '" returned NOT_VERIFIED, so it decided nothing');
      }

      findings.push(...findingsAcrossAttempts(all, record.scopeId));
    }
  }

  /* ------------------------------------------------- who did the reviewing, canonically */

  const producers = implementationProducersFrom(input.store);
  for (const agentId of reviewers) {
    const authority = reviewerAuthorityOf(agentId, input.registry);
    if (authority === undefined) {
      refusals.push(agentId + ' holds no contract, so it holds no authority to certify');
    } else if (!['VERIFY', 'REVIEW', 'ASSESS'].includes(authority.toUpperCase())) {
      refusals.push(
        agentId +
          ' holds ' +
          authority +
          ', which is not a verifier authority; an agent that can produce cannot certify',
      );
    }
    if (producers.has(agentId)) {
      refusals.push(
        agentId + ' produced implementation in this store, so it reviewed its own work',
      );
    }
  }

  /* --------------------------------------------------------------- what it all found */

  /*
   * Resolution is a RECORDED fact rather than an absence. A finding that stops appearing may
   * have been fixed, or may simply not have been looked for this time — so a fixed finding
   * stays in the evidence with `resolved: true` and the reason it was closed.
   */
  const blocking = findings.filter(
    (f) => !f.resolved && (f.severity === Severity.CRITICAL || f.severity === Severity.HIGH),
  );
  for (const f of blocking) {
    refusals.push(
      'unresolved ' + f.severity + ' finding ' + f.id + ' in "' + f.area + '": ' + f.statement,
    );
  }

  if (refusals.length > 0) {
    return { scopeRunIds: contributing.map((r) => r.reviewerRunId), refusals };
  }

  const review: SecurityReview = {
    implementationCommit: input.repository.commit,
    treeDigest: input.repository.tree,
    /* The aggregate names the last contributing run; every one is listed in scopeRunIds. */
    reviewerRunId: contributing[contributing.length - 1]?.reviewerRunId ?? '',
    reviewerAgentId: contributing[contributing.length - 1]?.reviewerAgentId ?? '',
    reviewerAuthority: 'VERIFY',
    independence: {
      implementationProducers: [...producers].sort(),
      statement:
        'Every scoped review ran as a governed VERIFIER with write = NONE and network = NONE, ' +
        'dispatched separately from the agents that produced the reviewed work. Independence ' +
        'and authority were derived from the contract registry and this store, not from any ' +
        'review document.',
    },
    scope: [...REQUIRED_SCOPE],
    findings: findings.map((f) => ({
      id: f.id,
      severity: f.severity,
      area: f.area,
      statement: f.statement,
      evidence: [...f.evidence],
    })),
    verdict: ReviewVerdict.ACCEPTED,
    reviewedAt: input.reviewedAt,
    storePath: input.storePath ?? input.store.paths.root,
  };

  return { review, scopeRunIds: contributing.map((r) => r.reviewerRunId), refusals: [] };
}
