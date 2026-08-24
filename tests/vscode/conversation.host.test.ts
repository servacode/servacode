import * as assert from 'node:assert/strict';
import { conversationTranscript, sendOwnerRequest } from '../../src/app/conversation.js';
import { ACTIONS, invokeAction } from '../../src/app/actions.js';
import { WEBVIEW_INVOCABLE } from '../../src/extension/protocol.js';
import { activated, project, projectSnapshot, renderedInWebview, Language } from './helpers.js';
import type { RoutingResult } from '../../src/orchestration/orchestrator.js';

/**
 * THE CONVERSATION SURFACE, IN A REAL WEBVIEW.
 *
 * SPEC: Phase 6 closure §5, §8.
 *
 * The offline suite proves the routing contract and the markup. What it cannot prove is that
 * an owner's words — Arabic, markup, whatever they typed — survive the trip into a document a
 * real webview parses, and come back out escaped rather than executed.
 *
 * Sending for real is deliberately not attempted. `conversation.send` calls the orchestrator,
 * which calls the engine, and a test that reached a live model would stop being a test and
 * start being a purchase. The routing itself is proved offline against the same contract.
 */

const ASKED = 'أضف تتبعاً للطلبات — add order tracking so a customer can see where their food is';

function orchestratorThat(over: Partial<RoutingResult>) {
  return {
    route: async (text: string, workItemId: string): Promise<RoutingResult> =>
      ({
        request: {
          id: 'SC-REQST-000001',
          text,
          receivedAt: '2026-08-24T00:00:00.000Z',
          source: 'OWNER_UI',
          workItemId,
        },
        stage: 'QUEUED',
        queue: [],
        ...over,
      }) as RoutingResult,
  };
}

describe('the conversation surface inside a real editor', () => {
  it('shows somewhere to ask, and says it is not a model conversation', async () => {
    await activated();
    const rt = project();
    try {
      const html = await renderedInWebview({
        snapshot: projectSnapshot(rt),
        conversation: conversationTranscript(rt),
        language: Language.EN,
      });
      assert.ok(html.includes('data-ask-submit'), 'nowhere to send a request from');
      assert.ok(html.includes('You are not talking to a model'));
    } finally {
      rt.close();
    }
  });

  it('a turn reaches a live webview with the owner’s own words intact', async () => {
    await activated();
    const rt = project();
    try {
      await sendOwnerRequest(rt, ASKED, {
        orchestrator: orchestratorThat({
          stage: 'QUEUED',
          classification: { requestClass: 'FEATURE', multiIntent: false } as never,
          queue: [{ departmentId: 'DEPT-PRODUCT' }] as never,
        }),
      });

      const html = await renderedInWebview({
        snapshot: projectSnapshot(rt),
        conversation: conversationTranscript(rt),
        language: Language.EN,
      });
      assert.ok(html.includes('add order tracking'), 'the request is not in the document');
      assert.ok(html.includes('DEPT-PRODUCT'), 'the owner cannot see what the company did');
      /*
       * The Arabic survives byte for byte. It is NOT re-directed here: owner prose follows the
       * interface, which is English in this test, and the isolation that stops a mixed-script
       * request reordering what follows it is done in CSS rather than by guessing a direction
       * per turn.
       */
      assert.ok(html.includes('أضف تتبعاً للطلبات'), 'the Arabic did not survive the render');
      assert.ok(html.includes('class="turn__asked"'), 'the request lost its isolated container');
    } finally {
      rt.close();
    }
  });

  it('markup in a request is escaped in the document a webview actually parses', async () => {
    await activated();
    const rt = project();
    try {
      await sendOwnerRequest(rt, '<img src=x onerror="alert(1)">', {
        orchestrator: orchestratorThat({}),
      });
      const html = await renderedInWebview({
        snapshot: projectSnapshot(rt),
        conversation: conversationTranscript(rt),
        language: Language.EN,
      });
      assert.ok(!html.includes('<img src=x'), 'owner text became markup');
      assert.ok(html.includes('&lt;img src=x'));
    } finally {
      rt.close();
    }
  });

  it('the panel can reach the governed send and nothing that talks to an engine', async () => {
    await activated();
    for (const id of WEBVIEW_INVOCABLE) {
      assert.ok(ACTIONS.has(id), id + ' is allow-listed but does not exist');
      assert.doesNotMatch(id, /engine|invoke|prompt|chat|complete/i);
    }
    assert.ok(WEBVIEW_INVOCABLE.has('conversation.send'));
  });

  it('sending refuses without confirmation, inside the host as anywhere else', async () => {
    await activated();
    const rt = project();
    try {
      const result = await invokeAction(
        { rt },
        { id: 'conversation.send', input: { text: ASKED }, confirmed: false },
      );
      assert.equal(result.ok, false);
      /* Nothing was recorded, and in particular nothing was sent. */
      assert.equal(conversationTranscript(rt).length, 0);
    } finally {
      rt.close();
    }
  });
});
