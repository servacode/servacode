import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { ServaRuntime } from '../src/app/runtime.js';
import { projectSnapshot } from '../src/app/services.js';
import { TurnOutcome, conversationTranscript, sendOwnerRequest } from '../src/app/conversation.js';
import { ACTIONS, invokeAction } from '../src/app/actions.js';
import { WEBVIEW_INVOCABLE } from '../src/extension/protocol.js';
import { renderControlCenter } from '../src/extension/render.js';
import { Language } from '../src/extension/i18n.js';
import { cleanup, tempRoot } from './helpers.js';
import type { RoutingResult } from '../src/orchestration/orchestrator.js';

/**
 * THE OWNER TALKS TO A COMPANY, NOT TO A MODEL.
 *
 * SPEC: Phase 6 closure §5; §9, §10, 04 §2.
 *
 * An independent audit found no conversation surface at all — the only way to ask Serva for
 * anything was a terminal command. The obvious fix is also the wrong one: a chat box wired to
 * the engine. It would be fluent, it would be ungoverned, and from the outside an owner has
 * no way to tell those apart.
 *
 * So the tests that matter here are less about the box and more about where the text goes.
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

const ASKED = 'أضف تتبعاً للطلبات — add order tracking so a customer can see where their food is';

/** An orchestrator stand-in. The governed one needs a live engine; its CONTRACT does not. */
function orchestratorThat(result: Partial<RoutingResult> | Error) {
  return {
    route: async (text: string, workItemId: string): Promise<RoutingResult> => {
      if (result instanceof Error) throw result;
      return {
        request: {
          id: 'SC-REQST-000001',
          text,
          receivedAt: '2026-08-24T00:00:00.000Z',
          source: 'OWNER_UI',
          workItemId,
        },
        stage: 'QUEUED',
        queue: [],
        ...result,
      } as RoutingResult;
    },
  };
}

/* ============================================================ where the text actually goes */

describe('nothing hands the owner’s words to an unrestricted session', () => {
  it('the panel can reach conversation.send and nothing that invokes the engine directly', () => {
    /*
     * The allow-list is the boundary. If a future action called `chat.ask` or `engine.invoke`
     * ever appeared here, this is where it would be caught — the point of an allow-list is
     * that adding to it is a deliberate act somebody has to justify.
     */
    for (const id of WEBVIEW_INVOCABLE) {
      expect(ACTIONS.has(id), id + ' is allow-listed but does not exist').toBe(true);
      expect(id, 'the panel must not reach a raw engine action').not.toMatch(
        /engine|invoke|prompt|chat|complete/i,
      );
    }
    expect(WEBVIEW_INVOCABLE.has('conversation.send')).toBe(true);
  });

  it('conversation.send is consequential and says what it will do', () => {
    const definition = ACTIONS.get('conversation.send');
    expect(definition?.consequence).toBe('CONSEQUENTIAL');
    expect(definition?.confirmPrompt).toBeDefined();
    expect(String(definition?.confirmPrompt)).toContain('verbatim');
  });

  it('the conversation module routes and does not call an adapter', () => {
    const source = readFileSync('src/app/conversation.ts', 'utf8');
    expect(source).toContain('orchestrator.route');
    /* No adapter, no prompt assembly, no completion call anywhere in this file. */
    expect(source).not.toMatch(/engine\.(invoke|complete|stream)/);
    expect(source).not.toMatch(/systemPrompt|buildStandardBundle/);
  });

  it('the panel script sends what was typed to conversation.send, unconfirmed', () => {
    const panel = readFileSync('extension/media/panel.js', 'utf8');
    expect(panel).toMatch(/invoke\('conversation\.send',\s*\{\s*text:\s*asked\s*\},\s*false\)/);
  });
});

/* ======================================================================== a turn is a turn */

describe('every turn is recorded, including the ones that went nowhere', () => {
  it('a queued request records the class, the departments and the runs', async () => {
    const rt = project();
    const turn = await sendOwnerRequest(rt, ASKED, {
      orchestrator: orchestratorThat({
        stage: 'QUEUED',
        classification: { requestClass: 'FEATURE', multiIntent: false } as never,
        queue: [{ departmentId: 'DEPT-PRODUCT' }, { departmentId: 'DEPT-ENGINEERING' }] as never,
        classificationRun: { runId: 'SC-RUN-000001' } as never,
      }),
    });

    expect(turn.outcome).toBe(TurnOutcome.QUEUED);
    expect(turn.text).toBe(ASKED);
    expect(turn.classification).toBe('FEATURE');
    expect(turn.queued).toEqual(['DEPT-PRODUCT', 'DEPT-ENGINEERING']);
    expect(turn.runIds).toEqual(['SC-RUN-000001']);
  });

  it('a halted request is a turn with the stage it stopped at and why', async () => {
    const rt = project();
    const turn = await sendOwnerRequest(rt, ASKED, {
      orchestrator: orchestratorThat({
        stage: 'CLASSIFIED',
        haltReason: 'The proposed plan named a department that does not exist.',
        queue: [],
      }),
    });
    expect(turn.outcome).toBe(TurnOutcome.HALTED);
    expect(turn.stage).toBe('CLASSIFIED');
    expect(turn.haltReason).toContain('does not exist');
  });

  it('an engine that is not there is a turn too, not a hole in the transcript', async () => {
    const rt = project();
    const turn = await sendOwnerRequest(rt, ASKED, {
      orchestrator: orchestratorThat(new Error('The AI engine is UNAUTHENTICATED.')),
    });
    /*
     * A surface that only gets a result on success has to invent its own words for failure,
     * and the words it invents will not match what the Store recorded.
     */
    expect(turn.outcome).toBe(TurnOutcome.REFUSED);
    expect(turn.haltReason).toContain('UNAUTHENTICATED');
    expect(conversationTranscript(rt)).toHaveLength(1);
  });

  it('an empty request is refused before anything is recorded', async () => {
    const rt = project();
    await expect(
      sendOwnerRequest(rt, '   \n  ', { orchestrator: orchestratorThat({}) }),
    ).rejects.toThrow();
    expect(conversationTranscript(rt)).toHaveLength(0);
  });

  it('keeps the owner’s words verbatim, including Arabic and the em dash', async () => {
    const rt = project();
    await sendOwnerRequest(rt, '  ' + ASKED + '  ', { orchestrator: orchestratorThat({}) });
    expect(conversationTranscript(rt)[0]?.text).toBe(ASKED);
  });
});

/* ================================================================== it survives a restart */

describe('the transcript is on disk, not in a window', () => {
  it('a second runtime over the same project reads the same conversation', async () => {
    const rt = project();
    const root = rt.root;
    await sendOwnerRequest(rt, ASKED, { orchestrator: orchestratorThat({}) });
    await sendOwnerRequest(rt, 'and print a daily summary', {
      orchestrator: orchestratorThat({}),
    });
    rt.close();

    const reopened = ServaRuntime.open({ root });
    try {
      const turns = conversationTranscript(reopened);
      expect(turns).toHaveLength(2);
      expect(turns[0]?.text).toBe(ASKED);
      expect(turns[1]?.text).toBe('and print a daily summary');
    } finally {
      reopened.close();
    }
  });

  it('is ordered oldest first, so the surface never has to guess', async () => {
    const rt = project();
    for (const text of ['first', 'second', 'third']) {
      await sendOwnerRequest(rt, text, { orchestrator: orchestratorThat({}) });
    }
    expect(conversationTranscript(rt).map((t) => t.text)).toEqual(['first', 'second', 'third']);
  });
});

/* ============================================================================ the surface */

describe('the Control Center shows the conversation and somewhere to ask', () => {
  function html(rt: ServaRuntime): string {
    return renderControlCenter({
      snapshot: projectSnapshot(rt),
      conversation: conversationTranscript(rt),
      language: Language.EN,
      nonce: 'n',
      cspSource: 'vscode-resource:',
      styleUri: 'style.css',
      scriptUri: 'panel.js',
    });
  }

  it('offers a place to ask even when nothing has been asked', () => {
    const rendered = html(project());
    expect(rendered).toContain('data-ask');
    expect(rendered).toContain('data-ask-submit');
    expect(rendered).toContain('Nothing has been asked yet.');
  });

  it('says plainly that this is not a model conversation', () => {
    expect(html(project())).toContain('You are not talking to a model');
  });

  it('escapes owner text that arrived carrying markup', async () => {
    const rt = project();
    await sendOwnerRequest(rt, '<img src=x onerror="alert(1)">', {
      orchestrator: orchestratorThat({}),
    });
    const rendered = html(rt);
    expect(rendered).not.toContain('<img src=x');
    expect(rendered).toContain('&lt;img src=x');
  });

  it('shows what the company did, not a sentence somebody wrote for the owner', async () => {
    const rt = project();
    await sendOwnerRequest(rt, ASKED, {
      orchestrator: orchestratorThat({
        stage: 'QUEUED',
        classification: { requestClass: 'FEATURE', multiIntent: false } as never,
        queue: [{ departmentId: 'DEPT-PRODUCT' }] as never,
      }),
    });
    const rendered = html(rt);
    expect(rendered).toContain('Queued');
    expect(rendered).toContain('DEPT-PRODUCT');
  });
});

/* ============================================================ the action, end to end */

describe('conversation.read is a read and returns what is stored', () => {
  it('returns the transcript through the action registry', async () => {
    const rt = project();
    await sendOwnerRequest(rt, ASKED, { orchestrator: orchestratorThat({}) });
    const result = await invokeAction({ rt }, { id: 'conversation.read', input: {} });
    expect(result.ok).toBe(true);
    expect((result.data as { text: string }[])[0]?.text).toBe(ASKED);
  });

  it('conversation.send refuses without confirmation', async () => {
    const rt = project();
    const result = await invokeAction(
      { rt },
      { id: 'conversation.send', input: { text: ASKED }, confirmed: false },
    );
    expect(result.ok).toBe(false);
    expect(conversationTranscript(rt)).toHaveLength(0);
  });
});
