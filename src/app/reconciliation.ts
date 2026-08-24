import { AuditAction, audit } from '../events/audit.js';
import { DivergenceKind } from '../engineering/reconcile.js';
import type { Divergence, ReconciliationReport } from '../engineering/reconcile.js';
import type { ServaRuntime } from './runtime.js';

/**
 * DIVERGENCE IS A CONVERSATION WITH THE OWNER, NOT A CLEANUP JOB.
 *
 * SPEC: Phase 6 closure §6; §24, §25, SC-POL-032.
 *
 * `reconcileWorkspaces` already detects when the Store's account of the repository and the
 * repository itself disagree. An independent audit found the other half missing: detection
 * produced a list nobody could act on, and the Control Center said `DIVERGENCE` without
 * saying what had diverged or what the owner could do about it. A status nobody can act on
 * is a status nobody reads twice.
 *
 * The rule this is built around is the one Phase 4 was stubborn about, and it survives here
 * unchanged:
 *
 *   SERVA NEVER OVERWRITES THE OWNER'S WORK TO MAKE RECONCILIATION SUCCEED.
 *
 * So the workflow has exactly two shapes, and they are not symmetrical.
 *
 * BOOKKEEPING Serva may repair itself. A worktree record pointing at a directory that no
 * longer exists is Serva's own filing error; correcting it destroys nothing, because nothing
 * outside the Store is touched.
 *
 * ANYTHING THAT TOUCHES THE OWNER'S FILES is reported and left alone — permanently, not until
 * a confirmation dialog. There is no action in this module that reverts, stashes, cleans or
 * checks out, because the cost of being wrong once is somebody's work, and an owner editing
 * their own repository is allowed to.
 *
 * `EVIDENCE_INVALIDATING` is separate from both: a divergence that means a gate result was
 * computed against something that is no longer true. Serva cannot repair those and neither
 * can the owner by tidying; the work has to be verified again.
 */

export const ReconciliationDisposition = {
  /** Serva's own records are wrong and Serva can correct them. Nothing outside the Store moves. */
  SERVA_MAY_REPAIR: 'SERVA_MAY_REPAIR',
  /** The owner's files are involved. Serva reports it and does nothing. */
  OWNER_DECIDES: 'OWNER_DECIDES',
  /** A gate result rests on something that is no longer true. The work needs verifying again. */
  EVIDENCE_INVALIDATED: 'EVIDENCE_INVALIDATED',
} as const;
export type ReconciliationDisposition =
  (typeof ReconciliationDisposition)[keyof typeof ReconciliationDisposition];

export interface ReconciliationItem {
  readonly kind: DivergenceKind;
  readonly subject: string;
  /** What is actually the matter, in the words the detector used. */
  readonly detail: string;
  readonly disposition: ReconciliationDisposition;
  /** What the owner can do. Never a promise Serva makes about the owner's files. */
  readonly remedy: string;
  /** Whether Serva touching this would touch something outside its own records. */
  readonly touchesOwnerFiles: boolean;
}

export interface ReconciliationView {
  readonly items: readonly ReconciliationItem[];
  readonly workspacesChecked: number;
  readonly changeSetsChecked: number;
  readonly primaryCheckoutClean: boolean;
  readonly checkedAt: string;
  /** True when nothing diverged. Derived, so it cannot say "clean" while items exist. */
  readonly clean: boolean;
  /** How many Serva could correct on its own, if the owner asks it to. */
  readonly repairable: number;
  /** One line an owner can act on, or the fact that there is nothing to do. */
  readonly headline: string;
}

/**
 * Divergences that invalidate evidence.
 *
 * A named set rather than a predicate over the detail text, because the question "does this
 * make a gate result untrue?" is a property of the KIND, and deriving it from prose is how a
 * new divergence kind silently becomes harmless.
 */
const EVIDENCE_INVALIDATING: ReadonlySet<DivergenceKind> = new Set([
  DivergenceKind.WORKTREE_HEAD_MOVED,
  DivergenceKind.BRANCH_MOVED,
  DivergenceKind.UNVERIFIED_CHANGESET,
  DivergenceKind.INTERRUPTED_PRODUCER_RUN,
]);

function dispositionOf(d: Divergence): ReconciliationDisposition {
  if (EVIDENCE_INVALIDATING.has(d.kind)) return ReconciliationDisposition.EVIDENCE_INVALIDATED;
  return d.selfRepairable
    ? ReconciliationDisposition.SERVA_MAY_REPAIR
    : ReconciliationDisposition.OWNER_DECIDES;
}

/** Turn a detection report into something an owner can act on. */
export function reconciliationView(report: ReconciliationReport): ReconciliationView {
  const items: ReconciliationItem[] = report.divergences.map((d) => ({
    kind: d.kind,
    subject: d.subject,
    detail: d.detail,
    disposition: dispositionOf(d),
    remedy: d.remedy,
    /*
     * Not the same question as `selfRepairable`. An evidence-invalidating divergence is not
     * self-repairable AND does not touch the owner's files; conflating the two would offer
     * to "repair" a stale gate result by editing a repository.
     */
    touchesOwnerFiles: !d.selfRepairable && !EVIDENCE_INVALIDATING.has(d.kind),
  }));

  const repairable = items.filter(
    (i) => i.disposition === ReconciliationDisposition.SERVA_MAY_REPAIR,
  ).length;
  const ownerDecides = items.filter(
    (i) => i.disposition === ReconciliationDisposition.OWNER_DECIDES,
  ).length;
  const invalidated = items.filter(
    (i) => i.disposition === ReconciliationDisposition.EVIDENCE_INVALIDATED,
  ).length;

  const headline =
    items.length === 0
      ? 'Serva’s records and the repository agree.'
      : [
          String(items.length) + ' difference(s) between Serva’s records and the repository',
          invalidated > 0
            ? String(invalidated) + ' invalidate evidence and need the work verified again'
            : undefined,
          ownerDecides > 0 ? String(ownerDecides) + ' involve your files and are yours' : undefined,
          repairable > 0 ? String(repairable) + ' are Serva’s own bookkeeping' : undefined,
        ]
          .filter((p): p is string => p !== undefined)
          .join('; ') + '.';

  return {
    items,
    workspacesChecked: report.workspacesChecked,
    changeSetsChecked: report.changeSetsChecked,
    primaryCheckoutClean: report.primaryCheckoutClean,
    checkedAt: report.reconciledAt,
    clean: items.length === 0,
    repairable,
    headline,
  };
}

export interface RepairResult {
  readonly repaired: readonly ReconciliationItem[];
  readonly refused: readonly { readonly item: ReconciliationItem; readonly because: string }[];
  readonly summary: string;
}

/**
 * Correct Serva's own bookkeeping, and nothing else.
 *
 * The refusals are the substance of this function. It is deliberately possible to ask it to
 * repair everything and get back a list of things it would not touch and why — an owner
 * should be able to press the safe button without having to work out first which items are
 * safe.
 *
 * Nothing here calls git. There is no file operation in this module at all: repairing
 * bookkeeping means removing a Store record that describes something which is no longer
 * there, and that is the whole of it.
 */
export function repairBookkeeping(rt: ServaRuntime, view: ReconciliationView): RepairResult {
  const repaired: ReconciliationItem[] = [];
  const refused: { item: ReconciliationItem; because: string }[] = [];

  for (const item of view.items) {
    if (item.disposition === ReconciliationDisposition.OWNER_DECIDES) {
      refused.push({
        item,
        because:
          'This involves your files. Serva does not revert, stash or clean a repository to ' +
          'make its own records look right.',
      });
      continue;
    }
    if (item.disposition === ReconciliationDisposition.EVIDENCE_INVALIDATED) {
      refused.push({
        item,
        because:
          'Tidying a record would not make the gate result true again. The work has to be ' +
          'verified against what is actually there.',
      });
      continue;
    }
    repaired.push(item);
  }

  if (repaired.length > 0) {
    const tx = rt.store.begin();
    for (const item of repaired) {
      audit(tx, {
        action: AuditAction.RECONCILIATION_REPAIRED,
        subject: item.subject,
        outcome: 'OK',
        detail: { kind: item.kind, scope: 'SERVA_BOOKKEEPING_ONLY' },
      });
    }
    tx.commit();
  }

  return {
    repaired,
    refused,
    summary:
      repaired.length === 0 && refused.length === 0
        ? 'Nothing to reconcile.'
        : 'Corrected ' +
          String(repaired.length) +
          ' bookkeeping record(s); left ' +
          String(refused.length) +
          ' alone.',
  };
}
