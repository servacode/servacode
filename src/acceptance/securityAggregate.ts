import { ScopeCoverage, findingIdPrefix, listScopeReviews, scopeIdOf } from './scopeReview.js';
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

  /*
   * DID THE UNIT ACTUALLY GET WHAT IT NEEDED TO DECIDE?
   *
   * SPEC: the omission at 7595c20a, and the acceptance bar set after it.
   *
   * Whether a unit REQUIRES context is derived here from the scope declaration in code — not
   * read off the record, which is the thing being checked. A record for a unit that declares
   * context, and that shows none of it arriving, is not a weaker judgement: it is a judgement
   * of a question the reviewer was not equipped to answer, and it carries no authority
   * whatever verdict it states.
   *
   * Enforced at the consumer as well as at the writer, because a record is evidence only when
   * something that did not write it agrees. Subject coverage is checked elsewhere and stays
   * separate: PARTIAL means a subject went unreviewed, and this means a guard never arrived.
   */
  const required = requiredContextFor(record.scopeName);
  if (required.length > 0) {
    const read = record.contextRead ?? [];
    const missing = required.filter((prefix) => !read.some((f) => f.startsWith(prefix)));
    if (missing.length > 0) {
      refusals.push(
        where +
          ' requires context it was not given (' +
          missing.join(', ') +
          '), so it judged its files without what decides them',
      );
    }
  }
  if ((record.contextOmitted ?? []).length > 0) {
    refusals.push(
      where +
        ' was reviewed without declared context (' +
        (record.contextOmitted ?? []).join(', ') +
        '), which does not make its verdict weaker — it makes it unfounded',
    );
  }

  return { record, refusals };
}

/** What this UNIT is declared to need, derived from the scope map rather than from a record. */
function requiredContextFor(scopeName: string): readonly string[] {
  for (const area of REQUIRED_SCOPE) {
    for (const unit of reviewUnitsFor(area)) {
      if (unit.unit === scopeName) return unit.context;
    }
  }
  return [];
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
/**
 * Which review UNIT raised this finding?
 *
 * A finding records the AREA it belongs to, and an area may be partitioned into several units
 * that each look at a different slice of the source. Silence from a unit that never saw the
 * file proves nothing, so corroboration must be matched to the originating unit and not to its
 * area. The unit is recoverable because the reviewer namespaced the finding's id with it —
 * rebuilt here by the one shared rule, `findingIdPrefix`.
 *
 * Returns undefined when no unit of the area claims the id, and the caller then treats the
 * finding as uncorroborated. Failing to identify the reviewer is not evidence of agreement.
 */
function unitThatRaised(f: ScopeFinding): string | undefined {
  for (const { unit } of reviewUnitsFor(f.area)) {
    if (f.id.startsWith(findingIdPrefix(unit) + '/')) return unit;
  }
  return undefined;
}

function resolutionIsCorroborated(f: ScopeFinding, attempts: readonly ResolvedAttempt[]): boolean {
  /*
   * When the unit is recoverable, ONLY that unit corroborates. When it is not — an id written
   * by something other than the review runner — this falls back to the older area match, which
   * is exact for an unpartitioned area (its single unit IS the area) and matches nothing for a
   * partitioned one. So the fallback is never wider than the rule above it: it restores the
   * previous behaviour where that behaviour was sound, and stays fail-safe where it was not.
   */
  const unit = unitThatRaised(f);
  const identifies =
    unit === undefined
      ? (a: ResolvedAttempt): boolean =>
          a.record.scopeName === f.area || a.record.scopeId === f.area
      : (a: ResolvedAttempt): boolean => a.record.scopeId === scopeIdOf(unit);

  const reReviews = attempts.filter((a) => a.refusals.length === 0 && identifies(a));
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

      /*
       * A UNIT THAT DID NOT ACCEPT DOES NOT CONTRIBUTE AN ACCEPTANCE.
       *
       * SPEC: finding SSA-RLC-AGG-1 (MEDIUM), 1.0.1 security review.
       *
       * This refused NOT_VERIFIED and said nothing about BLOCKED. Earlier rounds did refuse
       * blocked units — but on their unresolved CRITICAL/HIGH findings, caught further down,
       * never on the verdict itself. So a reviewer that read its area and said "I am blocking
       * this" while raising nothing above MEDIUM was overruled by silence, and the proof was
       * minted over its objection. A judgement produced and not read, again.
       *
       * Written as "anything that is not ACCEPTED" rather than as a list of the two verdicts
       * that exist today: a third verdict added later refuses here on the day it is added,
       * which a list would not do.
       */
      if (record.verdict !== ReviewVerdict.ACCEPTED) {
        refusals.push(
          '"' +
            unit +
            '" returned ' +
            record.verdict +
            ', so it did not accept what it reviewed' +
            (record.verdict === ReviewVerdict.NOT_VERIFIED ? ' — it decided nothing' : ''),
        );
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
