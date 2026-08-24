import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { ServaRuntime } from '../src/app/runtime.js';
import { projectSnapshot } from '../src/app/services.js';
import { invokeAction } from '../src/app/actions.js';
import { renderControlCenter } from '../src/extension/render.js';
import { Language } from '../src/extension/i18n.js';
import { ARTIFACT_TYPES, repository } from '../src/intelligence/repository.js';
import { OwnerDecisionRequestSchema } from '../src/intelligence/artifacts/governance.js';
import { cleanup, tempRoot } from './helpers.js';

/**
 * THE OWNER CAN ACTUALLY ANSWER A VALUE QUESTION.
 *
 * SPEC: Phase 6 closure §3; §12, §14.
 *
 * An independent audit found the Control Center rendering a VALUE question as a bare text
 * input with no submit control and no handler in the panel script. Only OPTION buttons ever
 * reached `owner.answer`, so the primary owner surface could not answer the primary kind of
 * blocking question. An input that goes nowhere is worse than no input, because it reads as
 * a working control and the owner waits.
 *
 * These tests walk the whole path in the modules a test runner can reach: the question is
 * rendered with somewhere to type AND something to press, the panel script sends the typed
 * value rather than a stand-in for it, the governed layer records exactly that text, and the
 * question then leaves the owner-action list so the lifecycle is resumable.
 *
 * The Extension Host half — the real webview, the real native modal, the real repaint — is
 * proved separately under `tests/vscode/`, because a renderer unit test cannot tell you that
 * a click in VS Code reaches the host.
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

/**
 * A real VALUE question: one Serva genuinely cannot answer, with no options to pick from.
 *
 * `responseMode: VALUE` with no options at all: the governed layer then refuses any attempt
 * to answer it by choosing something, which is what makes a typed answer the only answer.
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

const PANEL = readFileSync('extension/media/panel.js', 'utf8');

/* ======================================================= the question is answerable */

describe('a VALUE question renders somewhere to type and something to press', () => {
  it('has an input, a submit control and a matching label', () => {
    const rt = project();
    const id = seedValueQuestion(rt, 'What delivery radius do you commit to, in kilometres?');
    const html = renderControlCenter({
      snapshot: projectSnapshot(rt),
      language: Language.EN,
      nonce: 'n',
      cspSource: 'vscode-resource:',
      styleUri: 'style.css',
      scriptUri: 'panel.js',
    });

    expect(html).toContain('data-value-for="' + id + '"');
    /* The defect exactly: an input with no way to record it. */
    expect(html).toContain('data-value-submit="' + id + '"');
    expect(html).toContain('for="value-' + id + '"');
    expect(html).toContain('id="value-' + id + '"');
  });

  it('offers no meta-option standing in for a typed answer', () => {
    const rt = project();
    const id = seedValueQuestion(rt, 'What is your monthly budget ceiling?');
    const html = renderControlCenter({
      snapshot: projectSnapshot(rt),
      language: Language.EN,
      nonce: 'n',
      cspSource: 'vscode-resource:',
      styleUri: 'style.css',
      scriptUri: 'panel.js',
    });
    /*
     * A VALUE question with an option button would be Serva proposing an answer to a
     * question it just said it cannot answer.
     */
    expect(html).not.toContain('data-option-for="' + id + '"');
  });

  it('names the consequence before the owner commits to it', () => {
    const rt = project();
    seedValueQuestion(rt, 'What is your launch date?');
    const html = renderControlCenter({
      snapshot: projectSnapshot(rt),
      language: Language.EN,
      nonce: 'n',
      cspSource: 'vscode-resource:',
      styleUri: 'style.css',
      scriptUri: 'panel.js',
    });
    expect(html).toContain('Serva records exactly what you type');
  });
});

/* ============================================================ the panel script path */

describe('the panel script sends the typed value, unconfirmed', () => {
  it('handles the submit control and reads the input bound to that decision', () => {
    expect(PANEL).toContain('data-value-submit');
    expect(PANEL).toContain('data-value-for');
  });

  it('sends the value the owner typed under the `value` field', () => {
    /* `chosenOption` would be an OPTION answer, which the governed layer refuses for VALUE. */
    expect(PANEL).toMatch(/invoke\(\s*'owner\.answer',\s*\{\s*decisionId:[^}]*value:\s*typed/);
  });

  it('never claims the owner confirmed; the host asks natively', () => {
    /*
     * `confirmed: true` from a page is a boolean in a forgeable message. Every `invoke` in
     * this file passes false, and the host shows a modal a page cannot fabricate.
     */
    expect(PANEL).not.toMatch(/invoke\([^)]*,\s*true\s*\)/);
  });

  it('refuses an empty box in the panel rather than sending an empty answer', () => {
    expect(PANEL).toContain("if (typed === '')");
  });
});

/* ========================================================= the governed answer path */

describe('answering records the owner’s text and clears the question', () => {
  it('records exactly what was typed, and the question leaves the owner-action list', async () => {
    const rt = project();
    const id = seedValueQuestion(rt, 'What delivery radius do you commit to, in kilometres?');

    const before = projectSnapshot(rt);
    const action = before.ownerActions.find((a) => a.id === id);
    expect(action?.responseMode).toBe('VALUE');

    const typed = '12 km inside the ring road, 8 km outside';
    const result = await invokeAction(
      { rt },
      {
        id: 'owner.answer',
        input: { decisionId: id, value: typed, answeredBy: 'owner' },
        confirmed: true,
      },
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);

    /*
     * The Store holds the owner's words, not a normalisation of them. The answer lands on
     * the request itself, which is what makes "who answered, with what, when" one record
     * rather than a join somebody could get wrong.
     */
    const answered = repository(
      rt.store,
      ARTIFACT_TYPES.OWNER_DECISION_REQUEST,
      OwnerDecisionRequestSchema,
    ).get(id);
    expect(answered?.state).toBe('ANSWERED');
    expect((answered as unknown as { answerValue?: string }).answerValue).toBe(typed);
    expect((answered as unknown as { answeredBy?: string }).answeredBy).toBe('owner');

    const after = projectSnapshot(rt);
    expect(after.ownerActions.find((a) => a.id === id)).toBeUndefined();
  });

  it('an unconfirmed consequential answer is refused, and nothing is recorded', async () => {
    const rt = project();
    const id = seedValueQuestion(rt, 'What is your monthly budget ceiling?');
    const result = await invokeAction(
      { rt },
      {
        id: 'owner.answer',
        input: { decisionId: id, value: 'SAR 40,000', answeredBy: 'owner' },
        confirmed: false,
      },
    );
    expect(result.ok).toBe(false);
    expect(projectSnapshot(rt).ownerActions.some((a) => a.id === id)).toBe(true);
  });

  it('an agent cannot answer it, however well-formed the message is', async () => {
    const rt = project();
    const id = seedValueQuestion(rt, 'What is your launch date?');
    const result = await invokeAction(
      { rt },
      {
        id: 'owner.answer',
        input: { decisionId: id, value: '2026-10-01', answeredBy: 'SC-AGENT-150' },
        confirmed: true,
      },
    );
    expect(result.ok).toBe(false);
    expect(projectSnapshot(rt).ownerActions.some((a) => a.id === id)).toBe(true);
  });

  it('a meta-option answer to a VALUE question is refused', async () => {
    const rt = project();
    const id = seedValueQuestion(rt, 'What delivery radius do you commit to?');
    const result = await invokeAction(
      { rt },
      {
        id: 'owner.answer',
        input: { decisionId: id, chosenOption: 'I will decide later', answeredBy: 'owner' },
        confirmed: true,
      },
    );
    expect(result.ok).toBe(false);
  });
});
