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
 * ONE PLACE THAT DECIDES WHETHER A REVIEW ATTEMPT MEANS ANYTHING.
 *
 * SPEC: HIGH findings SC-SSA-F1, SC-SSA-REV-001, SC-SSA-F2.
 *
 * Three defects, one cause: raw stored records were consumed in one place while canonical run
 * resolution happened in another. The aggregate resolved the reviewer run of the LATEST record
 * per scope and then read findings — and their `resolved` flags — from EVERY record. So a
 * record whose run nobody resolved could still clear a blocker, as long as it named the right
 * commit and tree. Commit and tree are public, so that was authority on a boolean plus two
 * derivable values.
 *
 * A stored record is a claim. This is the only function that turns one into evidence, and
 * nothing downstream may read a raw record again: findings, resolutions, coverage, terminal
 * outcome and verdict all arrive through here or not at all.
 */
export interface ResolvedAttempt {
  readonly record: ScopeReview;
  /** Why this attempt carries no authority. Empty means it does. */
  readonly refusals: readonly string[];
}

export function resolveSecurityReviewAttempt(
  store: Store,
  record: ScopeReview,
  repository: RepositoryIdentity,
  registry: ContractRegistry,
): ResolvedAttempt {
  const refusals: string[] = [];
  const where = '"' + record.scopeName + '"';

  /* The implementation it judged, re-derived rather than read. */
  if (record.implementationCommit !== repository.commit) {
    refusals.push(
      where +
        ' was reviewed at commit ' +
        record.implementationCommit.slice(0, 12) +
        ' and this package is ' +
        repository.commit.slice(0, 12),
    );
  }
  if (record.treeDigest !== repository.tree) {
    refusals.push(where + ' was reviewed against a different tree than this package is');
  }

  /*
   * The run, resolved for EVERY attempt rather than only the latest. This is SC-SSA-F1: the
   * per-unit loop checked one record and `currentFindings` read them all.
   */
  const run = readRun(store, record.reviewerRunId);
  if (run === undefined) {
    refusals.push(
      where + ' cites reviewer run ' + record.reviewerRunId + ', which does not resolve',
    );
  } else {
    if (run.outcome !== 'COMPLETED') {
      refusals.push(
        'reviewer run ' +
          record.reviewerRunId +
          ' for ' +
          where +
          ' ended ' +
          String(run.outcome) +
          ', so it reviewed nothing',
      );
    }
    if (run.agentId !== record.reviewerAgentId) {
      refusals.push(
        'reviewer run ' +
          record.reviewerRunId +
          ' was made by ' +
          String(run.agentId) +
          ', not the ' +
          record.reviewerAgentId +
          ' the record names',
      );
    }
  }

  /* The authority, from the contract that binds the reviewer. */
  const authority = reviewerAuthorityOf(record.reviewerAgentId, registry);
  if (authority === undefined) {
    refusals.push(
      record.reviewerAgentId + ' holds no contract, so it holds no authority to certify',
    );
  } else if (!VERIFIER_AUTHORITIES.includes(authority.toUpperCase())) {
    refusals.push(
      record.reviewerAgentId +
        ' holds ' +
        authority +
        ', which is not a verifier authority; an agent that can produce cannot certify',
    );
  }
  if (implementationProducersFrom(store).has(record.reviewerAgentId)) {
    refusals.push(record.reviewerAgentId + ' produced implementation in this store');
  }

  return { record, refusals };
}

const VERIFIER_AUTHORITIES: readonly string[] = ['VERIFY', 'REVIEW', 'ASSESS'];

function readRun(
  store: Store,
  runId: string,
): { readonly agentId?: string; readonly outcome?: string } | undefined {
  try {
    return store.getCanon<{ agentId?: string; outcome?: string }>('agentRunRecord', runId)?.body;
  } catch {
    return undefined;
  }
}

/**
 * WHAT IS UNRESOLVED AT THIS IMPLEMENTATION, FROM CANONICALLY RESOLVED ATTEMPTS ONLY.
 *
 * Two shapes were wrong before, in opposite directions. Reading only the LATEST attempt let a
 * retry mute a finding by not re-reporting it; reading EVERY attempt let history — and
 * unresolved attempts — mute the present.
 *
 * So: every attempt bound to this implementation AND canonically resolved contributes, and
 * nothing else is consulted. A `{resolved: true}` inside an attempt that does not resolve has
 * no authority at all, which is what SC-SSA-F1 was about.
 */
function currentFindings(
  attempts: readonly ResolvedAttempt[],
  scopeId: string,
  repository: RepositoryIdentity,
): readonly ScopeFinding[] {
  const usable = attempts.filter((a) => a.refusals.length === 0 && a.record.scopeId === scopeId);

  const byId = new Map<string, ScopeFinding>();
  for (const a of usable) {
    for (const f of a.record.findings) {
      const seen = byId.get(f.id);
      /* Within one implementation a later resolution wins; a later silence still does not. */
      if (
        seen === undefined ||
        (!isResolvedHere(seen, repository) && isResolvedHere(f, repository))
      ) {
        byId.set(f.id, f);
      }
    }
  }
  return [...byId.values()];
}

/**
 * Is this finding's resolution bound to the implementation being judged?
 *
 * A resolution is evidence about one defect at one implementation state. Without the state it
 * is an assertion, and finding ids are reviewer-numbered, so a regression collided with an old
 * id and stayed muted.
 */
function isResolvedHere(f: ScopeFinding, repository: RepositoryIdentity): boolean {
  return (
    f.resolved === true &&
    f.resolvedAtCommit === repository.commit &&
    f.resolvedAtTree === repository.tree
  );
}

/**
 * A RESOLUTION HAS TO BE BACKED BY A RE-REVIEW THAT DID NOT FIND IT.
 *
 * SPEC: finding SERVA-SELF-ACCEPTANCE-AUTHORITY/SC-SSA-RESOLVE-1 (MEDIUM), 1.0.1 review.
 *
 * `isResolvedHere` reads three fields that all sit inside the record making the claim. The
 * record's provenance is checked — its commit, its tree, that its `reviewerRunId` resolves to
 * a COMPLETED verifier run with authority — but the run's OUTPUT is never compared against what
 * the record says. Nothing stops one legitimate run being cited by a record it did not produce,
 * declaring any finding id closed.
 *
 * And the mechanism has no legitimate writer at all: `persist()` in securityReviewRun.ts writes
 * `resolved: false` for every finding of every reviewer run, and nothing anywhere in the product
 * writes `true`. So every resolution that has ever existed was authored outside the review path,
 * and honouring one on its own word can only ever admit something hand-written into canon.
 *
 * Corroboration closes it without discarding the design. The header's argument for recording
 * resolutions is right — absence is ambiguous, since a finding may stop appearing because it was
 * fixed OR because nobody looked. But the CLAIM disambiguates the absence, and the absence
 * evidences the claim: a governed re-review of the same scope, at this commit and tree, that
 * examined the area and did not report the finding.
 *
 * Neither half is forgeable alone. The claim cannot conjure a run's silence, and silence with no
 * claim still means only that nobody looked.
 */
function resolutionIsCorroborated(f: ScopeFinding, attempts: readonly ResolvedAttempt[]): boolean {
  const reReviews = attempts.filter(
    (a) =>
      a.refusals.length === 0 && (a.record.scopeName === f.area || a.record.scopeId === f.area),
  );
  return reReviews.some((a) => !a.record.findings.some((g) => g.id === f.id));
}

export function aggregateSecurityReview(input: AggregateInput): AggregateOutcome {
  const refusals: string[] = [];

  /*
   * EVERY attempt is resolved, once, here. Nothing below reads a raw stored record: an
   * attempt that does not resolve contributes no findings, no resolutions, no coverage and no
   * verdict — which is what SC-SSA-F1 was about.
   */
  const attempts = listScopeReviews(input.store).map((record) =>
    resolveSecurityReviewAttempt(input.store, record, input.repository, input.registry),
  );
  const usable = attempts.filter((a) => a.refusals.length === 0);

  const contributing: ScopeReview[] = [];
  const findings: ScopeFinding[] = [];
  const reviewers = new Set<string>();

  /*
   * COVERAGE IS DECIDED PER UNIT AND REPORTED PER AREA.
   *
   * An area split into sub-scopes is covered only when every one of its units is. Splitting a
   * thing you cannot finish does not finish it — it only makes the gap easier to see.
   */
  for (const area of REQUIRED_SCOPE) {
    for (const { unit } of reviewUnitsFor(area)) {
      const scopeId = scopeIdOf(unit);

      /* The latest attempt that ACTUALLY RESOLVES decides coverage for this unit. */
      const forUnit = usable
        .filter((a) => a.record.scopeId === scopeId)
        .sort((a, b) => (a.record.reviewedAt < b.record.reviewedAt ? 1 : -1));
      const resolved = forUnit[0];

      if (resolved === undefined) {
        /* Say WHY when an attempt exists but carries no authority; silence would mislead. */
        const rejected = attempts.filter((a) => a.record.scopeId === scopeId);
        refusals.push(
          rejected.length === 0
            ? 'no security review is recorded for "' + unit + '" (' + area + ')'
            : 'no security review for "' +
                unit +
                '" carries authority: ' +
                rejected.flatMap((a) => a.refusals).join('; '),
        );
        continue;
      }

      const record = resolved.record;
      contributing.push(record);
      reviewers.add(record.reviewerAgentId);

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

      if (record.verdict === ReviewVerdict.NOT_VERIFIED) {
        refusals.push('"' + unit + '" returned NOT_VERIFIED, so it decided nothing');
      }

      findings.push(...currentFindings(usable, scopeId, input.repository));
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
    (f) =>
      !(isResolvedHere(f, input.repository) && resolutionIsCorroborated(f, attempts)) &&
      (f.severity === Severity.CRITICAL || f.severity === Severity.HIGH),
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
