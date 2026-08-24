import { execFileSync } from 'node:child_process';
import { EnforcementClass } from '../vocab/index.js';
import { QualificationAttempt } from '../substrate/types.js';

import { listChangeSets, readChangeSet } from '../engineering/changeset.js';
import { listReviews } from '../engineering/review.js';
import { listEvidence } from '../engineering/execution.js';
import type { Store } from '../store/store.js';
import type { SubstrateQualification } from '../substrate/types.js';

/**
 * LIVE EVIDENCE, RESOLVED FROM WHAT ACTUALLY HAPPENED.
 *
 * SPEC: Phase 6 final acceptance sequence §2.
 *
 * The live suites now reach real governed execution: a Producer run, a ChangeSet, deterministic
 * checks, an independent Reviewer, an Engineering Gate and an accepted commit. That is exactly
 * the moment the temptation appears — write down the ids, mint a PASS, move on.
 *
 * A caller must not be able to produce
 *
 *   LIVE PASS + an invented run id + an invented fingerprint
 *
 * so nothing here trusts an id. **Caller-provided ids are lookup hints, not authority.** Every
 * one is resolved against the Store, the trace, Git and this machine, and then checked to
 * belong to the SAME execution as all the others — because six real ids from six different runs
 * would otherwise assemble into a chain that never existed.
 *
 * The checks are ordered cheapest-first only where that does not change the answer. Each one
 * exists because skipping it admits a specific lie, and the comment on each says which.
 */

/**
 * Read a run's TERMINAL record, without projecting its event log.
 *
 * `projectAgentRun` rebuilds a run from its stream and throws when there is no stream, which
 * is the wrong shape for an acceptance check twice over: an absent run is a REFUSAL rather
 * than an exception, and the durable artifact — the one that survives a restart and the one
 * `serva acceptance` already resolves — is the terminal record itself.
 */
function terminalRun(
  store: Store,
  runId: string,
): { readonly agentId?: string; readonly outcome?: string } | undefined {
  try {
    const body = store.getCanon<{ agentId?: string; outcome?: string }>(
      'agentRunRecord',
      runId,
    )?.body;
    return body ?? undefined;
  } catch {
    return undefined;
  }
}

export interface LiveRefusal {
  readonly check: string;
  readonly detail: string;
}

export interface LiveEngineeringChain {
  readonly workItemId: string;
  readonly producerRunId: string;
  readonly producerAgentId: string;
  readonly reviewerRunId: string;
  readonly reviewerAgentId: string;
  readonly changeSetId: string;
  readonly acceptedCommit: string;
  readonly checkIds: readonly string[];
  readonly machineFingerprint: string;
}

export interface LiveResolution<T> {
  readonly resolved: boolean;
  readonly chain?: T;
  readonly refusals: readonly LiveRefusal[];
}

export interface LiveEngineeringInput {
  /** The store the live run actually wrote to. */
  readonly store: Store;
  /** The git repository the accepted commit should exist in. */
  readonly repoRoot: string;
  /** This machine, measured now. */
  readonly machineFingerprint: string;
  /** The qualification in force for the run. */
  readonly qualification: SubstrateQualification;
  /** The fingerprint recorded when the run happened. */
  readonly recordedFingerprint: string;
  /** Lookup hints. Never authority. */
  readonly hints?: {
    readonly producerRunId?: string;
    readonly reviewerRunId?: string;
    readonly changeSetId?: string;
    readonly acceptedCommit?: string;
  };
  /** Overridden in tests; asks git whether a commit exists. */
  readonly commitExists?: (repoRoot: string, commit: string) => boolean;
}

/** Does this commit exist in this repository? Asked of git, never of a record. */
export function gitCommitExists(repoRoot: string, commit: string): boolean {
  try {
    execFileSync('git', ['cat-file', '-e', commit + '^{commit}'], {
      cwd: repoRoot,
      stdio: ['ignore', 'ignore', 'ignore'],
      timeout: 15_000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the engineering half of the live chain.
 *
 * Returns refusals rather than throwing, and returns ALL of them rather than the first: an
 * owner or an auditor looking at a failed live acceptance needs to see everything that did not
 * line up, not the earliest thing to trip.
 */
export function resolveLiveEngineering(
  input: LiveEngineeringInput,
): LiveResolution<LiveEngineeringChain> {
  const refusals: LiveRefusal[] = [];
  const refuse = (check: string, detail: string): void => {
    refusals.push({ check, detail });
  };
  const commitExists = input.commitExists ?? gitCommitExists;

  /* ------------------------------------------------------------------ the machine */

  /*
   * A live result that happened somewhere else is not evidence about here. Checked first
   * because it is the one claim an author could otherwise make about any machine at all.
   */
  if (input.recordedFingerprint !== input.machineFingerprint) {
    refuse(
      'MACHINE',
      'the run records fingerprint ' +
        input.recordedFingerprint.slice(0, 12) +
        ' and this machine is ' +
        input.machineFingerprint.slice(0, 12),
    );
  }

  /*
   * HARD, and MEASURED. A SOFT boundary does not authorise a Producer, and an attempt that
   * never reached the guest measured nothing at all — the transport invariant reaching the
   * acceptance layer, where it matters most.
   */
  if (input.qualification.attempt !== QualificationAttempt.MEASURED) {
    refuse(
      'QUALIFICATION',
      'the qualification attempt was ' + input.qualification.attempt + ', so nothing was measured',
    );
  } else if (input.qualification.enforcementClass !== EnforcementClass.HARD) {
    refuse(
      'QUALIFICATION',
      'the boundary measured ' +
        input.qualification.enforcementClass +
        ', and a Producer requires HARD',
    );
  }

  /* -------------------------------------------------------------- the change set */

  const changeSets = listChangeSets(input.store);
  const changeSet =
    input.hints?.changeSetId !== undefined
      ? readChangeSet(input.store, input.hints.changeSetId)
      : changeSets[changeSets.length - 1];

  if (changeSet === undefined) {
    refuse('CHANGESET', 'no ChangeSet resolves in this store');
    return { resolved: false, refusals };
  }

  /* ------------------------------------------------------------- the producer run */

  const producerRunId = changeSet.producerRunId ?? input.hints?.producerRunId;
  if (producerRunId === undefined) {
    refuse('PRODUCER_RUN', 'the ChangeSet names no Producer run, so nothing produced it');
  }

  let producerAgentId = changeSet.producerAgentId;
  if (producerRunId !== undefined) {
    const run = terminalRun(input.store, producerRunId);
    if (run === undefined || run.outcome === undefined) {
      refuse('PRODUCER_RUN', producerRunId + ' does not resolve to a run in this store');
    } else if (run.outcome !== 'COMPLETED') {
      refuse('PRODUCER_RUN', producerRunId + ' ended ' + run.outcome + ', so it produced nothing');
    }
    /*
     * The run's OWN actor, not the one the ChangeSet claims. A ChangeSet is written by Serva
     * from what it observed, but binding the two here is what stops a real run being pasted
     * beside a change it did not make.
     */
    if (run?.agentId !== undefined && run.agentId !== changeSet.producerAgentId) {
      refuse(
        'PRODUCER_RUN',
        'run ' +
          producerRunId +
          ' was made by ' +
          run.agentId +
          ' and the ChangeSet names ' +
          changeSet.producerAgentId,
      );
    }
    if (run?.agentId !== undefined) producerAgentId = run.agentId;
  }

  /* ------------------------------------------------------- deterministic evidence */

  const evidence = listEvidence(input.store).filter((e) => e.changeSetId === changeSet.changeSetId);
  if (evidence.length === 0) {
    refuse(
      'CHECKS',
      'no deterministic check evidence is bound to ChangeSet ' + changeSet.changeSetId,
    );
  }

  /* ---------------------------------------------------------------- the reviewer */

  const reviews = listReviews(input.store).filter((r) => r.changeSetId === changeSet.changeSetId);
  const review =
    input.hints?.reviewerRunId !== undefined
      ? reviews.find((r) => r.runRef === input.hints?.reviewerRunId)
      : reviews[0];

  if (review === undefined) {
    refuse(
      'REVIEW',
      'no persisted review is bound to ChangeSet ' +
        changeSet.changeSetId +
        (reviews.length === 0 ? '' : ', and the named reviewer run is not among the ones that are'),
    );
  } else {
    const reviewerRun = terminalRun(input.store, review.runRef);
    if (reviewerRun === undefined || reviewerRun.outcome === undefined) {
      refuse('REVIEW', review.runRef + ' does not resolve to a run in this store');
    } else if (reviewerRun.outcome !== 'COMPLETED') {
      refuse('REVIEW', review.runRef + ' ended ' + reviewerRun.outcome + ', so it judged nothing');
    }
    /*
     * Independence, from the runs rather than from the record. A reviewer that is the
     * Producer is the system asking itself for permission, and the whole engineering gate
     * rests on this one comparison.
     */
    if (review.reviewerAgentId === producerAgentId) {
      refuse(
        'INDEPENDENCE',
        'the reviewer and the producer are both ' + producerAgentId + ', so nothing was reviewed',
      );
    }
    if (review.outcome !== 'PASS') {
      refuse('REVIEW', 'the review outcome is ' + review.outcome);
    }
    /* Same work item, or these are two unrelated executions standing next to each other. */
    if (review.workItemId !== changeSet.workItemId) {
      refuse(
        'SAME_EXECUTION',
        'the review belongs to work item ' +
          review.workItemId +
          ' and the ChangeSet to ' +
          changeSet.workItemId,
      );
    }
  }

  /* ------------------------------------------------------------ the accepted commit */

  const acceptedCommit = input.hints?.acceptedCommit ?? changeSet.headCommit;
  if (acceptedCommit !== changeSet.headCommit) {
    /*
     * A commit somebody typed in. The ChangeSet records what the Producer actually produced,
     * so a different commit here is a hand-written claim about work that was never done.
     */
    refuse(
      'ACCEPTED_COMMIT',
      'the named commit ' +
        acceptedCommit.slice(0, 12) +
        ' is not the ChangeSet head ' +
        changeSet.headCommit.slice(0, 12),
    );
  }
  if (acceptedCommit === '' || !commitExists(input.repoRoot, acceptedCommit)) {
    refuse('ACCEPTED_COMMIT', acceptedCommit.slice(0, 12) + ' is not a commit in this repository');
  }

  if (refusals.length > 0) return { resolved: false, refusals };

  return {
    resolved: true,
    chain: {
      workItemId: changeSet.workItemId,
      producerRunId: String(producerRunId),
      producerAgentId,
      reviewerRunId: String(review?.runRef),
      reviewerAgentId: String(review?.reviewerAgentId),
      changeSetId: changeSet.changeSetId,
      acceptedCommit,
      checkIds: evidence.map((e) => e.id),
      machineFingerprint: input.machineFingerprint,
    },
    refusals: [],
  };
}

export interface LiveServaChain extends LiveEngineeringChain {
  readonly requestId: string;
  readonly turnId: string;
  readonly classification?: string;
  readonly queuedDepartments: readonly string[];
}

export interface LiveServaInput extends LiveEngineeringInput {
  /** Where the owner's request and the governed intelligence live. */
  readonly companyStore: Store;
  readonly hints2?: { readonly turnId?: string };
}

/**
 * Resolve the whole-product chain: an owner asked, and governed work followed.
 *
 * SPEC: §2.
 *
 * The engineering half is resolved by the function above and reused rather than re-checked,
 * so there is one definition of what a real Producer chain is. What this adds is the front of
 * it — the owner's request, recorded verbatim, and the governed runs it caused.
 */
export function resolveLiveServa(input: LiveServaInput): LiveResolution<LiveServaChain> {
  const engineering = resolveLiveEngineering(input);
  const refusals: LiveRefusal[] = [...engineering.refusals];

  const turns = input.companyStore
    .listWorkingIds('conversationTurn')
    .map((id) => input.companyStore.getWorking<Record<string, unknown>>('conversationTurn', id))
    .filter((e): e is NonNullable<typeof e> => e !== undefined)
    .map((e) => e.body);

  const turn =
    input.hints2?.turnId !== undefined
      ? turns.find((t) => t['id'] === input.hints2?.turnId)
      : turns[turns.length - 1];

  if (turn === undefined) {
    refusals.push({ check: 'OWNER_REQUEST', detail: 'no owner request is recorded in this store' });
    return { resolved: false, refusals };
  }

  const runIds = Array.isArray(turn['runIds']) ? (turn['runIds'] as string[]) : [];
  if (runIds.length === 0) {
    refusals.push({
      check: 'GOVERNED_INTELLIGENCE',
      detail: 'the request caused no governed run, so nothing reasoned about it',
    });
  }

  /*
   * Each run the request claims to have caused, resolved. A turn is written by Serva, but a
   * turn naming runs that do not exist would let a transcript stand in for execution.
   */
  for (const runId of runIds) {
    const run = terminalRun(input.companyStore, runId);
    if (run === undefined) {
      refusals.push({
        check: 'GOVERNED_INTELLIGENCE',
        detail: runId + ' is named by the request and does not resolve',
      });
    } else if (run.outcome !== 'COMPLETED') {
      refusals.push({
        check: 'GOVERNED_INTELLIGENCE',
        detail: runId + ' ended ' + String(run.outcome),
      });
    }
  }

  if (String(turn['outcome']) === 'REFUSED') {
    refusals.push({
      check: 'OWNER_REQUEST',
      detail: 'the request was refused, so no work followed it',
    });
  }

  if (refusals.length > 0 || engineering.chain === undefined) {
    return { resolved: false, refusals };
  }

  return {
    resolved: true,
    chain: {
      ...engineering.chain,
      requestId: String(turn['requestId'] ?? ''),
      turnId: String(turn['id']),
      ...(turn['classification'] === undefined
        ? {}
        : { classification: String(turn['classification']) }),
      queuedDepartments: Array.isArray(turn['queued']) ? (turn['queued'] as string[]) : [],
    },
    refusals: [],
  };
}
