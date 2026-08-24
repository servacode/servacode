import * as assert from 'node:assert/strict';
import { ARTIFACT_TYPES, repository } from '../../src/intelligence/repository.js';
import { OwnerDecisionRequestSchema } from '../../src/intelligence/artifacts/governance.js';
import { invokeAction } from '../../src/app/actions.js';
import { activated, project, projectSnapshot, renderedInWebview, Language } from './helpers.js';
import type { ServaRuntime } from '../../src/app/runtime.js';

/**
 * ANSWERING A VALUE DECISION, IN A REAL VS CODE.
 *
 * SPEC: Phase 6 closure §3, §8.
 *
 * The audit asked for this specifically: *Add Extension Host test, not only renderer unit
 * test.* The renderer suite proves the markup contains an input and a submit control. What it
 * cannot prove is that the document survives a real webview — that the Content Security
 * Policy VS Code actually enforces admits the script, that the controls are in the document
 * the browser receives, and that the governed answer path reaches the Store from inside the
 * extension host process.
 */

function seedValueQuestion(rt: ServaRuntime, question: string): string {
  const at = rt.clock.now();
  const id = rt.ids.next('SC-ODR');
  const tx = rt.store.begin();
  repository(rt.store, ARTIFACT_TYPES.OWNER_DECISION_REQUEST, OwnerDecisionRequestSchema).put(tx, {
    id,
    createdAt: at,
    question,
    whyServaCannotDecide: 'It is a commercial commitment, not a technical fact.',
    purpose: 'BUSINESS_RULE',
    responseMode: 'VALUE',
    valueKind: 'TEXT',
    options: [],
    recommendation: 'State the figure you are willing to commit to.',
    recommendationRationale: 'Nothing in the project implies it.',
    blocksWork: true,
    blockedRefs: [],
    state: 'OPEN',
    meta: { provenance: { marking: 'SYSTEM', component: 'test' }, attribution: { at } },
  } as never);
  tx.commit();
  return id;
}

describe('a VALUE decision is answerable through a real webview', () => {
  it('the document a live webview receives carries the input and the submit control', async () => {
    await activated();
    const rt = project();
    try {
      const id = seedValueQuestion(rt, 'What delivery radius do you commit to, in kilometres?');
      const html = await renderedInWebview({
        snapshot: projectSnapshot(rt),
        language: Language.EN,
      });

      assert.ok(html.includes('data-value-for="' + id + '"'), 'no input for the decision');
      assert.ok(html.includes('data-value-submit="' + id + '"'), 'no way to record the answer');
      /* And no button standing in for a typed value. */
      assert.ok(!html.includes('data-option-for="' + id + '"'));
    } finally {
      rt.close();
    }
  });

  it('the policy a real webview enforces still admits Serva’s own script', async () => {
    await activated();
    const rt = project();
    try {
      seedValueQuestion(rt, 'What is your monthly budget ceiling?');
      const html = await renderedInWebview({
        snapshot: projectSnapshot(rt),
        language: Language.EN,
      });
      /*
       * `cspSource` here came from a live webview, not from a string a unit test invented. A
       * policy that VS Code would reject, or one that accidentally blocked the panel's own
       * script, fails at this line and nowhere else.
       */
      /*
       * The quotes are HTML-escaped, because the policy lives in a `content` attribute. The
       * escaped form is what a webview actually receives, so it is what is asserted — a test
       * matching the unescaped string would pass on a document no browser ever sees.
       */
      assert.match(html, /script-src &#39;nonce-test-nonce&#39;/);
      assert.match(html, /default-src &#39;none&#39;/);
      assert.ok(html.includes('vscode-'), 'the policy does not name the real webview origin');
    } finally {
      rt.close();
    }
  });

  it('answering through the governed layer records the value and clears the question', async () => {
    await activated();
    const rt = project();
    try {
      const id = seedValueQuestion(rt, 'What delivery radius do you commit to?');
      const typed = '12 km inside the ring road, 8 km outside';

      const result = await invokeAction(
        { rt },
        {
          id: 'owner.answer',
          input: { decisionId: id, value: typed, answeredBy: 'owner' },
          confirmed: true,
        },
      );
      assert.equal(result.ok, true, String(result.refusal));

      const answered = repository(
        rt.store,
        ARTIFACT_TYPES.OWNER_DECISION_REQUEST,
        OwnerDecisionRequestSchema,
      ).get(id);
      assert.equal((answered as unknown as { answerValue?: string }).answerValue, typed);

      /* And the Control Center no longer shows it, so the lifecycle reads as resumable. */
      const html = await renderedInWebview({
        snapshot: projectSnapshot(rt),
        language: Language.EN,
      });
      assert.ok(!html.includes('data-value-submit="' + id + '"'));
    } finally {
      rt.close();
    }
  });

  it('an agent cannot answer it from inside the extension host either', async () => {
    await activated();
    const rt = project();
    try {
      const id = seedValueQuestion(rt, 'What is your launch date?');
      const result = await invokeAction(
        { rt },
        {
          id: 'owner.answer',
          input: { decisionId: id, value: '2026-10-01', answeredBy: 'SC-AGENT-150' },
          confirmed: true,
        },
      );
      assert.equal(result.ok, false);
      assert.ok(projectSnapshot(rt).ownerActions.some((a) => a.id === id));
    } finally {
      rt.close();
    }
  });
});
