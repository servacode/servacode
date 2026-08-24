import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { ServaRuntime } from '../src/app/runtime.js';
import { projectSnapshot } from '../src/app/services.js';
import {
  ReconciliationDisposition,
  reconciliationView,
  repairBookkeeping,
} from '../src/app/reconciliation.js';
import { DivergenceKind } from '../src/engineering/reconcile.js';
import { readAudit } from '../src/events/audit.js';
import { ACTIONS } from '../src/app/actions.js';
import { WEBVIEW_INVOCABLE } from '../src/extension/protocol.js';
import { renderControlCenter } from '../src/extension/render.js';
import { Language } from '../src/extension/i18n.js';
import { cleanup, tempRoot } from './helpers.js';
import type { Divergence, ReconciliationReport } from '../src/engineering/reconcile.js';

/**
 * DIVERGENCE IS A CONVERSATION WITH THE OWNER, NOT A CLEANUP JOB.
 *
 * SPEC: Phase 6 closure §6; §24, §25, SC-POL-032.
 *
 * Detection already existed. An independent audit found the other half missing: the Control
 * Center could say DIVERGENCE without saying what had diverged or what the owner could do,
 * which makes the state a dead end.
 *
 * The tests that matter are the ones about what Serva REFUSES to repair. It would be easy to
 * write a reconciliation feature that quietly makes everything green, and it would destroy
 * somebody's work the first time it was wrong.
 */

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) cleanup(r);
});

function project(): ServaRuntime {
  const root = tempRoot();
  roots.push(root);
  return ServaRuntime.init('RahalGo', 'Stop losing phone orders', { root });
}

function divergence(over: Partial<Divergence> & { kind: Divergence['kind'] }): Divergence {
  return {
    subject: 'subject',
    detail: 'something differs',
    selfRepairable: false,
    remedy: 'look at it',
    ...over,
  };
}

function report(divergences: readonly Divergence[]): ReconciliationReport {
  return {
    divergences,
    workspacesChecked: 3,
    changeSetsChecked: 2,
    primaryCheckoutClean: divergences.length === 0,
    reconciledAt: '2026-08-24T00:00:00.000Z',
  };
}

/* ================================================== what Serva may and may not touch */

describe('Serva repairs its own filing and nothing else', () => {
  it('a record pointing at a directory that is gone is Serva’s to correct', () => {
    const view = reconciliationView(
      report([divergence({ kind: DivergenceKind.MISSING_WORKTREE, selfRepairable: true })]),
    );
    expect(view.items[0]?.disposition).toBe(ReconciliationDisposition.SERVA_MAY_REPAIR);
    expect(view.items[0]?.touchesOwnerFiles).toBe(false);
    expect(view.repairable).toBe(1);
  });

  it('a dirty working tree belongs to the owner and is never repaired', () => {
    const view = reconciliationView(
      report([divergence({ kind: DivergenceKind.DIRTY_PRIMARY_CHECKOUT })]),
    );
    expect(view.items[0]?.disposition).toBe(ReconciliationDisposition.OWNER_DECIDES);
    expect(view.items[0]?.touchesOwnerFiles).toBe(true);
    expect(view.repairable).toBe(0);
  });

  it('a moved HEAD invalidates evidence, and tidying a record would not make it true again', () => {
    const view = reconciliationView(
      report([divergence({ kind: DivergenceKind.WORKTREE_HEAD_MOVED })]),
    );
    expect(view.items[0]?.disposition).toBe(ReconciliationDisposition.EVIDENCE_INVALIDATED);
    /*
     * Not the same question as "is it the owner's". Conflating them would offer to repair a
     * stale gate result by editing a repository.
     */
    expect(view.items[0]?.touchesOwnerFiles).toBe(false);
  });

  it('asking to repair everything refuses everything it must not touch, and says why', () => {
    const rt = project();
    const view = reconciliationView(
      report([
        divergence({ kind: DivergenceKind.MISSING_WORKTREE, selfRepairable: true }),
        divergence({ kind: DivergenceKind.DIRTY_PRIMARY_CHECKOUT }),
        divergence({ kind: DivergenceKind.UNVERIFIED_CHANGESET }),
      ]),
    );
    const result = repairBookkeeping(rt, view);

    expect(result.repaired).toHaveLength(1);
    expect(result.refused).toHaveLength(2);
    expect(result.refused.map((r) => r.because).join(' ')).toContain('does not revert, stash');
    expect(result.refused.map((r) => r.because).join(' ')).toContain('verified against what is');
  });

  it('the module contains no file operation at all', () => {
    /*
     * The strongest statement available: repairing bookkeeping means removing a Store record
     * describing something that is no longer there. If this file could not call git or touch
     * the filesystem, it cannot destroy work however wrong its classification became.
     */
    const source = readFileSync('src/app/reconciliation.ts', 'utf8');
    for (const forbidden of ['node:fs', 'node:child_process', 'execFile', 'rmSync', 'writeFile']) {
      expect(source, 'reconciliation must not be able to ' + forbidden).not.toContain(forbidden);
    }
  });

  it('records what it corrected, scoped so an audit line cannot imply more', () => {
    const rt = project();
    const view = reconciliationView(
      report([
        divergence({
          kind: DivergenceKind.MISSING_WORKTREE,
          subject: 'SC-WS-000004',
          selfRepairable: true,
        }),
        divergence({ kind: DivergenceKind.DIRTY_PRIMARY_CHECKOUT, subject: 'the repository' }),
      ]),
    );
    repairBookkeeping(rt, view);

    const entries = readAudit(rt.store).filter((e) => e.type === 'RECONCILIATION_REPAIRED');
    /* One line for the record Serva corrected. None for the working tree it left alone. */
    expect(entries).toHaveLength(1);
    const body = entries[0]?.payload as {
      subject?: string;
      detail?: { scope?: string; kind?: string };
    };
    expect(body.subject).toBe('SC-WS-000004');
    expect(body.detail?.kind).toBe(DivergenceKind.MISSING_WORKTREE);
    /*
     * The scope is on the line itself. Somebody reading this trail a year later must not be
     * able to read it as evidence that Serva changed a file.
     */
    expect(body.detail?.scope).toBe('SERVA_BOOKKEEPING_ONLY');
  });

  it('writes no audit line at all when there was nothing it could correct', () => {
    const rt = project();
    const before = readAudit(rt.store).length;
    repairBookkeeping(
      rt,
      reconciliationView(report([divergence({ kind: DivergenceKind.DIRTY_PRIMARY_CHECKOUT })])),
    );
    expect(readAudit(rt.store)).toHaveLength(before);
  });
});

/* ============================================================= the owner-facing view */

describe('the view says something an owner can act on', () => {
  it('says the records agree when they do, and nothing else', () => {
    const view = reconciliationView(report([]));
    expect(view.clean).toBe(true);
    expect(view.headline).toContain('agree');
    expect(view.items).toHaveLength(0);
  });

  it('counts each kind separately, so one loud item does not hide the others', () => {
    const view = reconciliationView(
      report([
        divergence({ kind: DivergenceKind.MISSING_WORKTREE, selfRepairable: true }),
        divergence({ kind: DivergenceKind.DIRTY_PRIMARY_CHECKOUT }),
        divergence({ kind: DivergenceKind.BRANCH_MOVED }),
      ]),
    );
    expect(view.clean).toBe(false);
    expect(view.headline).toContain('invalidate evidence');
    expect(view.headline).toContain('involve your files');
    expect(view.headline).toContain('bookkeeping');
  });

  it('cannot report clean while items exist, because clean is derived', () => {
    const view = reconciliationView(report([divergence({ kind: DivergenceKind.BRANCH_MOVED })]));
    expect(view.clean).toBe(view.items.length === 0);
  });
});

/* ================================================================== the Control Center */

describe('the Control Center shows divergence as something to do', () => {
  function html(rt: ServaRuntime, reconciliation?: ReturnType<typeof reconciliationView>): string {
    return renderControlCenter({
      snapshot: projectSnapshot(rt),
      ...(reconciliation === undefined ? {} : { reconciliation }),
      language: Language.EN,
      nonce: 'n',
      cspSource: 'vscode-resource:',
      styleUri: 'style.css',
      scriptUri: 'panel.js',
    });
  }

  it('distinguishes “not compared” from “nothing wrong”', () => {
    const rendered = html(project());
    expect(rendered).toContain('Not compared yet.');
    expect(rendered).not.toContain('records and the repository agree');
    expect(rendered).toContain('data-reconcile-check');
  });

  it('offers no repair button when there is nothing Serva may repair', () => {
    const rendered = html(
      project(),
      reconciliationView(report([divergence({ kind: DivergenceKind.DIRTY_PRIMARY_CHECKOUT })])),
    );
    /* Not disabled, not behind a confirmation. Absent. */
    expect(rendered).not.toContain('data-reconcile-repair');
    expect(rendered).toContain('Yours to decide');
  });

  it('offers the repair button only for Serva’s own bookkeeping', () => {
    const rendered = html(
      project(),
      reconciliationView(
        report([divergence({ kind: DivergenceKind.MISSING_WORKTREE, selfRepairable: true })]),
      ),
    );
    expect(rendered).toContain('data-reconcile-repair');
  });

  it('states the promise on the surface, where the owner is deciding', () => {
    expect(html(project())).toContain('never reverts, stashes or cleans');
  });

  it('escapes a divergence subject that arrived from a repository', () => {
    const rendered = html(
      project(),
      reconciliationView(
        report([
          divergence({
            kind: DivergenceKind.UNTRACKED_WORKTREE,
            subject: '<img src=x onerror="alert(1)">',
          }),
        ]),
      ),
    );
    expect(rendered).not.toContain('<img src=x');
    expect(rendered).toContain('&lt;img src=x');
  });
});

/* ========================================================================= the actions */

describe('the reconciliation actions are shaped like what they do', () => {
  it('inspect reads and repair is consequential', () => {
    expect(ACTIONS.get('reconcile.inspect')?.consequence).toBe('READ');
    expect(ACTIONS.get('reconcile.repair')?.consequence).toBe('CONSEQUENTIAL');
  });

  it('the repair confirmation promises what the code enforces', () => {
    const prompt = String(ACTIONS.get('reconcile.repair')?.confirmPrompt);
    expect(prompt).toContain('does not revert, stash or clean');
  });

  it('both are reachable from the panel', () => {
    expect(WEBVIEW_INVOCABLE.has('reconcile.inspect')).toBe(true);
    expect(WEBVIEW_INVOCABLE.has('reconcile.repair')).toBe(true);
  });

  it('the panel sends repair unconfirmed, so the host asks natively', () => {
    const panel = readFileSync('extension/media/panel.js', 'utf8');
    expect(panel).toMatch(/invoke\('reconcile\.repair',\s*\{\},\s*false\)/);
  });
});
