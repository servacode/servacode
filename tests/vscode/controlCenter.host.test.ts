import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { conversationTranscript } from '../../src/app/conversation.js';
import { ARTIFACT_TYPES, repository } from '../../src/intelligence/repository.js';
import { OwnerDecisionRequestSchema } from '../../src/intelligence/artifacts/governance.js';
import { statusBarText } from '../../src/extension/render.js';
import { activated, project, projectSnapshot, renderedInWebview, Language } from './helpers.js';

/**
 * THE CONTROL CENTER, OPENED FOR REAL.
 *
 * SPEC: Phase 6 closure §6, §8.
 *
 * The audit's complaint about the Control Center was that its information areas were not
 * usable — a header that could say DIVERGENCE with nothing behind it, sections that existed
 * as headings. So these tests are about whether the surface actually answers the questions an
 * owner opens it to ask, in a document VS Code has parsed.
 */

describe('the Control Center opens and answers something', () => {
  it('opens without a project, and says so rather than failing', async () => {
    await activated();
    /*
     * The window has no Serva project. Opening the Control Center here must not throw: an
     * ordinary folder is not an error condition, and an extension that raises one on every
     * window is an extension that gets uninstalled.
     */
    await vscode.commands.executeCommand('serva.openControlCenter');
  });

  it('every information area is present, with content rather than a heading', async () => {
    await activated();
    const rt = project();
    try {
      const html = await renderedInWebview({
        snapshot: projectSnapshot(rt),
        conversation: conversationTranscript(rt),
        language: Language.EN,
      });

      for (const section of [
        'overview-h',
        'ask-h',
        'decisions-h',
        'stages-h',
        'blockers-h',
        'stale-h',
        'release-h',
        'reconcile-h',
        'machine-h',
      ]) {
        assert.ok(html.includes('id="' + section + '"'), section + ' is missing entirely');
      }

      /*
       * And each of the interactive areas offers something to do, rather than being a
       * heading over an empty div. An owner opening this needs at least one way in.
       */
      assert.ok(html.includes('data-ask-submit'), 'no way to ask for anything');
      assert.ok(html.includes('data-reconcile-check'), 'no way to compare against the repository');
      assert.ok(html.includes('id="refresh"'), 'no way to re-read the project');
    } finally {
      rt.close();
    }
  });

  it('states machine qualification and release readiness, not only their titles', async () => {
    await activated();
    const rt = project();
    try {
      const html = await renderedInWebview({
        snapshot: projectSnapshot(rt),
        language: Language.EN,
      });
      /* A fresh project is unqualified and not releasable, and the panel says which. */
      assert.match(html, /machine machine--/);
      assert.match(html, /release release--/);
      assert.ok(html.includes('condition'), 'release readiness shows no conditions');
    } finally {
      rt.close();
    }
  });

  it('mirrors the layout for Arabic rather than only translating it', async () => {
    await activated();
    const rt = project();
    try {
      /*
       * A decision whose recommendation quotes a canonical id — the ordinary way an owner
       * meets one. A fresh project contains no technical strings at all, so without seeding
       * this the assertion below would pass or fail for reasons unrelated to direction.
       */
      const at = rt.clock.now();
      const tx = rt.store.begin();
      repository(rt.store, ARTIFACT_TYPES.OWNER_DECISION_REQUEST, OwnerDecisionRequestSchema).put(
        tx,
        {
          id: rt.ids.next('SC-ODR'),
          createdAt: at,
          question: 'أي ميزة نبدأ بها؟',
          whyServaCannotDecide: 'الأولوية التجارية قرارك أنت.',
          purpose: 'BUSINESS_RULE',
          options: [
            { option: 'SC-FEAT-000012', impact: 'تتبع الطلبات', disposition: 'INFORM' },
            { option: 'SC-FEAT-000013', impact: 'تقرير يومي', disposition: 'INFORM' },
          ],
          recommendation: 'SC-FEAT-000012',
          recommendationRationale: 'يعالج الشكوى الأكثر تكراراً.',
          blocksWork: true,
          blockedRefs: [],
          state: 'OPEN',
          meta: { provenance: { marking: 'SYSTEM', component: 'test' }, attribution: { at } },
        } as never,
      );
      tx.commit();

      const html = await renderedInWebview({
        snapshot: projectSnapshot(rt),
        language: Language.AR,
      });
      assert.match(html, /dir="rtl"/);

      /*
       * Technical content keeps its own direction INSIDE an Arabic interface. `PRF-...` is a
       * canonical identifier and matches the technical rule, so it must be LTR here while the
       * prose around it is RTL — a file path or an id is not an Arabic sentence and does not
       * become one by appearing in an Arabic interface.
       */
      assert.ok(
        html.includes('<span dir="ltr" class="technical">SC-FEAT-000012</span>'),
        'a canonical identifier was folded into the interface direction',
      );
    } finally {
      rt.close();
    }
  });

  it('the status bar reads a derived state, in a real window', async () => {
    await activated();
    const rt = project();
    try {
      const text = statusBarText(projectSnapshot(rt), Language.EN);
      assert.match(text, /Serva/);
      /* Derived from the snapshot: there is no path that sets it. */
      assert.ok(text.startsWith('$('), 'the status bar lost its state icon');
    } finally {
      rt.close();
    }
  });
});
