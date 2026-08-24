import * as assert from 'node:assert/strict';
import { ACTIONS } from '../../src/app/actions.js';
import { WEBVIEW_INVOCABLE } from '../../src/extension/protocol.js';
import {
  ReconciliationDisposition,
  reconciliationView,
  repairBookkeeping,
} from '../../src/app/reconciliation.js';
import { DivergenceKind } from '../../src/engineering/reconcile.js';
import { readAudit } from '../../src/events/audit.js';
import { activated, project, projectSnapshot, renderedInWebview, Language } from './helpers.js';
import type { Divergence, ReconciliationReport } from '../../src/engineering/reconcile.js';

/**
 * DIVERGENCE, AS AN OWNER SEES IT IN A REAL EDITOR.
 *
 * SPEC: Phase 6 closure §6, §8.
 *
 * The property worth proving in a live webview is a NEGATIVE one: that the repair control is
 * absent — not disabled, not hidden behind a confirmation — for anything touching the owner's
 * files. Absence is exactly the kind of assertion that can pass in a string test and fail in
 * a real document, because a template that emits the button under a CSS class nobody styled
 * would look identical to one that emits nothing.
 */

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
    workspacesChecked: 1,
    changeSetsChecked: 1,
    primaryCheckoutClean: divergences.length === 0,
    reconciledAt: '2026-08-24T00:00:00.000Z',
  };
}

describe('reconciliation in a real editor', () => {
  it('offers no repair control for anything belonging to the owner', async () => {
    await activated();
    const rt = project();
    try {
      const html = await renderedInWebview({
        snapshot: projectSnapshot(rt),
        reconciliation: reconciliationView(
          report([divergence({ kind: DivergenceKind.DIRTY_PRIMARY_CHECKOUT })]),
        ),
        language: Language.EN,
      });
      assert.ok(
        !html.includes('data-reconcile-repair'),
        'a repair control reached a real webview for a divergence in the owner’s files',
      );
      assert.ok(html.includes('Yours to decide'));
      assert.ok(html.includes('never reverts, stashes or cleans'));
    } finally {
      rt.close();
    }
  });

  it('offers it for Serva’s own bookkeeping, and only then', async () => {
    await activated();
    const rt = project();
    try {
      const html = await renderedInWebview({
        snapshot: projectSnapshot(rt),
        reconciliation: reconciliationView(
          report([divergence({ kind: DivergenceKind.MISSING_WORKTREE, selfRepairable: true })]),
        ),
        language: Language.EN,
      });
      assert.ok(html.includes('data-reconcile-repair'));
    } finally {
      rt.close();
    }
  });

  it('distinguishes “not compared” from “nothing wrong” in the document', async () => {
    await activated();
    const rt = project();
    try {
      const html = await renderedInWebview({
        snapshot: projectSnapshot(rt),
        language: Language.EN,
      });
      assert.ok(html.includes('Not compared yet.'));
      assert.ok(!html.includes('records and the repository agree'));
      assert.ok(html.includes('data-reconcile-check'));
    } finally {
      rt.close();
    }
  });

  it('repairing inside the host touches bookkeeping and refuses the rest', async () => {
    await activated();
    const rt = project();
    try {
      const view = reconciliationView(
        report([
          divergence({
            kind: DivergenceKind.MISSING_WORKTREE,
            subject: 'SC-WS-000004',
            selfRepairable: true,
          }),
          divergence({ kind: DivergenceKind.DIRTY_PRIMARY_CHECKOUT }),
        ]),
      );
      const result = repairBookkeeping(rt, view);
      assert.equal(result.repaired.length, 1);
      assert.equal(result.refused.length, 1);
      assert.equal(result.refused[0]?.item.disposition, ReconciliationDisposition.OWNER_DECIDES);

      const lines = readAudit(rt.store).filter((e) => e.type === 'RECONCILIATION_REPAIRED');
      assert.equal(lines.length, 1);
      assert.equal(
        (lines[0]?.payload as { detail?: { scope?: string } }).detail?.scope,
        'SERVA_BOOKKEEPING_ONLY',
      );
    } finally {
      rt.close();
    }
  });

  it('both reconciliation actions exist and are reachable from the panel', async () => {
    await activated();
    assert.equal(ACTIONS.get('reconcile.inspect')?.consequence, 'READ');
    assert.equal(ACTIONS.get('reconcile.repair')?.consequence, 'CONSEQUENTIAL');
    assert.ok(WEBVIEW_INVOCABLE.has('reconcile.inspect'));
    assert.ok(WEBVIEW_INVOCABLE.has('reconcile.repair'));
  });
});
