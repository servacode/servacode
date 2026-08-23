import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { ServaRuntime } from '../src/app/runtime.js';
import { projectSnapshot } from '../src/app/services.js';
import { ACTIONS, invokeAction } from '../src/app/actions.js';
import {
  WEBVIEW_INVOCABLE,
  parseWebviewMessage,
  webviewMayInvoke,
} from '../src/extension/protocol.js';
import {
  Direction,
  Language,
  contentDirection,
  directionOf,
  isTechnicalContent,
  messageKeys,
  t,
} from '../src/extension/i18n.js';
import {
  contentSecurityPolicy,
  escapeHtml,
  healthLabel,
  renderControlCenter,
  statusBarText,
} from '../src/extension/render.js';
import { ARTIFACT_TYPES, repository } from '../src/intelligence/repository.js';
import { OwnerDecisionRequestSchema } from '../src/intelligence/artifacts/governance.js';
import { writeOrchestratorRecord } from '../src/intelligence/execution/orchestrator.js';
import { cleanup, tempRoot } from './helpers.js';

/**
 * THE PANEL IS A BROWSER TALKING TO A HIGH-AUTHORITY PROCESS.
 *
 * Everything in the Control Center comes out of a project directory: a requirement
 * somebody wrote, a defect title, a research finding retrieved from the internet. All of
 * it becomes HTML, and on the other side of the message channel sits a process that can
 * answer owner decisions and restore over a project.
 *
 * These tests are about that boundary. They exercise the `vscode`-free modules — the
 * protocol, the renderer, the translation table — which is deliberate: putting the logic
 * where a normal test runner can reach it is what makes it testable at all, and an
 * extension whose security lives in an untestable activation function is an extension
 * whose security is a hope.
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

const HOSTILE = '<img src=x onerror="alert(1)">';

function seedHostileDecision(rt: ServaRuntime): string {
  const at = rt.clock.now();
  const id = rt.ids.next('SC-ODR');
  const tx = rt.store.begin();
  repository(rt.store, ARTIFACT_TYPES.OWNER_DECISION_REQUEST, OwnerDecisionRequestSchema).put(tx, {
    id,
    createdAt: at,
    /* A question whose text came from somewhere else and contains markup. */
    question: 'Should we support ' + HOSTILE + ' as a payment method?',
    whyServaCannotDecide: 'commercial policy <script>alert(2)</script>',
    purpose: 'BUSINESS_RULE',
    options: [
      { option: '<b>Yes</b>', impact: 'more <i>customers</i>', disposition: 'INFORM' },
      { option: 'No', impact: 'simpler', disposition: 'INFORM' },
    ],
    recommendation: 'No',
    recommendationRationale: 'nothing suggests demand yet',
    blocksWork: true,
    blockedRefs: [],
    state: 'OPEN',
    meta: { provenance: { marking: 'SYSTEM', component: 'test' }, attribution: { at } },
  } as never);
  tx.commit();
  return id;
}

/* ==================================================================== the protocol */

describe('the webview protocol grants nothing on its own', () => {
  it('accepts the three message shapes and nothing else', () => {
    expect(parseWebviewMessage({ kind: 'READY' }).ok).toBe(true);
    expect(parseWebviewMessage({ kind: 'REFRESH' }).ok).toBe(true);
    expect(
      parseWebviewMessage({ kind: 'INVOKE', requestId: 'r1', actionId: 'project.snapshot' }).ok,
    ).toBe(true);

    for (const hostile of [
      { kind: 'EVAL', code: 'process.exit()' },
      { kind: 'INVOKE' },
      'REFRESH',
      null,
      42,
      { kind: 'INVOKE', requestId: 'r1', actionId: 'project.snapshot', extra: true },
    ]) {
      expect(parseWebviewMessage(hostile).ok, JSON.stringify(hostile)).toBe(false);
    }
  });

  it('a forged action id is refused at the boundary, before it reaches a log line', () => {
    const parsed = parseWebviewMessage({
      kind: 'INVOKE',
      requestId: 'r1',
      actionId: 'project.deleteEverything',
    });
    expect(parsed.ok).toBe(false);
    expect(parsed.refusal).toContain('not a Serva action');
  });

  it('there is no message that names a function, a path or a script', () => {
    /*
     * The absence is the property. A protocol with a `method` or `path` field is one
     * refactor away from being a remote procedure call into the extension host.
     */
    const parsed = parseWebviewMessage({
      kind: 'INVOKE',
      requestId: 'r1',
      actionId: 'project.snapshot',
      method: 'rm -rf',
    });
    expect(parsed.ok).toBe(false);
  });

  it('destructive actions are not reachable from the panel at all', () => {
    /* A page should never be the thing that chose a filesystem destination. */
    expect(webviewMayInvoke('restore.perform')).toBe(false);
    expect(webviewMayInvoke('backup.create')).toBe(false);
    expect(webviewMayInvoke('owner.answer')).toBe(true);

    for (const id of WEBVIEW_INVOCABLE) {
      expect(ACTIONS.has(id), id + ' is invocable and does not exist').toBe(true);
    }
  });

  it('even an allowed action still goes through validation and confirmation', async () => {
    const rt = project();
    const decisionId = seedHostileDecision(rt);
    expect(webviewMayInvoke('owner.answer')).toBe(true);

    /* Reaching the action layer is not the same as being permitted by it. */
    const unconfirmed = await invokeAction(
      { rt },
      { id: 'owner.answer', input: { decisionId, chosenOption: 'No', answeredBy: 'owner' } },
    );
    expect(unconfirmed.ok).toBe(false);
    expect(unconfirmed.refusal).toContain('project truth');
  });
});

/* ================================================================ untrusted content */

describe('project content becomes text on the page, never markup', () => {
  it('escapes every character that could close a tag or an attribute', () => {
    expect(escapeHtml(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;');
  });

  it('a hostile requirement or decision cannot inject script into the panel', () => {
    const rt = project();
    seedHostileDecision(rt);
    const html = renderControlCenter({
      snapshot: projectSnapshot(rt),
      language: Language.EN,
      nonce: 'NONCE123',
      cspSource: 'vscode-resource:',
      styleUri: 'vscode-resource:/style.css',
      scriptUri: 'vscode-resource:/panel.js',
    });

    /* The text is present, and only as text. */
    expect(html).toContain('&lt;img src=x onerror=');
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<script>alert(2)</script>');
    expect(html).not.toContain('onerror="alert(1)"');
    /* The one script in the document is the one Serva put there, with the nonce. */
    const scripts = html.match(/<script/g) ?? [];
    expect(scripts).toHaveLength(1);
    expect(html).toContain('<script nonce="NONCE123"');
  });

  it('the CSP denies everything and then permits one nonce', () => {
    const csp = contentSecurityPolicy('N1', 'vscode-resource:');
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'nonce-N1'");
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("frame-src 'none'");
  });

  it('the rendered document carries the CSP as a meta tag', () => {
    const html = renderControlCenter({
      snapshot: projectSnapshot(project()),
      language: Language.EN,
      nonce: 'N1',
      cspSource: 'vscode-resource:',
      styleUri: 's.css',
      scriptUri: 'p.js',
    });
    expect(html).toContain('http-equiv="Content-Security-Policy"');
    expect(html).toContain('default-src &#39;none&#39;');
  });
});

/* ======================================================================== RTL / LTR */

describe('Arabic mirrors the layout, and technical content keeps its direction', () => {
  it('both languages define exactly the same keys', () => {
    /* A key present in one language only is the string that never gets translated. */
    expect(messageKeys(Language.AR)).toEqual(messageKeys(Language.EN));
  });

  it('every key resolves to something in both languages', () => {
    for (const key of messageKeys(Language.EN)) {
      for (const language of [Language.EN, Language.AR]) {
        const value = t(language, key as never);
        expect(value.length, language + '/' + key).toBeGreaterThan(0);
        /* A key rendered as its own name is a missing translation, visibly. */
        expect(value, language + '/' + key).not.toBe(key);
      }
    }
  });

  it('Arabic is RTL and the document says so', () => {
    expect(directionOf(Language.AR)).toBe(Direction.RTL);
    const html = renderControlCenter({
      snapshot: projectSnapshot(project()),
      language: Language.AR,
      nonce: 'N1',
      cspSource: 'vscode-resource:',
      styleUri: 's.css',
      scriptUri: 'p.js',
    });
    expect(html).toContain('dir="rtl"');
    expect(html).toContain('lang="ar"');
    /* And the owner-facing chrome is actually in Arabic, not English in an RTL box. */
    expect(html).toContain('نظرة عامة');
  });

  it('paths, hashes and ids stay LTR inside an RTL interface', () => {
    for (const technical of [
      'SC-AGENT-020',
      'd:/SEVACODE/src/index.ts',
      '0a8c70a2141cdf4ba1d19b7662575e9da95e4d7e',
      'package.json',
    ]) {
      expect(isTechnicalContent(technical), technical).toBe(true);
      expect(contentDirection(technical, Language.AR)).toBe(Direction.LTR);
    }
  });

  it('ordinary prose follows the interface direction', () => {
    const prose = 'Stop losing phone orders during the morning rush';
    expect(isTechnicalContent(prose)).toBe(false);
    expect(contentDirection(prose, Language.AR)).toBe(Direction.RTL);
    expect(contentDirection(prose, Language.EN)).toBe(Direction.LTR);
  });

  it('a technical span inside an RTL page is marked so the stylesheet can isolate it', () => {
    const rt = project();
    /* The profile id is a real technical field the panel renders. */
    const tx = rt.store.begin();
    writeOrchestratorRecord(tx, {
      workItemId: 'SC-WI-000001',
      profileId: 'PRF-NEW-PRODUCT',
      state: 'RUNNING',
      completedStages: [],
      ranStages: [],
      completedDepartments: [],
      pendingOwnerDecisions: [],
      gateResults: [],
      updatedAt: rt.clock.now(),
    });
    tx.commit();

    const html = renderControlCenter({
      snapshot: projectSnapshot(rt, { workItemId: 'SC-WI-000001' }),
      language: Language.AR,
      nonce: 'N1',
      cspSource: 'vscode-resource:',
      styleUri: 's.css',
      scriptUri: 'p.js',
    });
    expect(html).toContain('PRF-NEW-PRODUCT');
    expect(html).toContain('class="technical"');
    /* And the same span in an English page needs no isolation. */
    const ltr = renderControlCenter({
      snapshot: projectSnapshot(rt, { workItemId: 'SC-WI-000001' }),
      language: Language.EN,
      nonce: 'N1',
      cspSource: 'vscode-resource:',
      styleUri: 's.css',
      scriptUri: 'p.js',
    });
    expect(ltr).not.toContain('class="technical"');
  });
});

/* ===================================================================== the status bar */

describe('the status bar reports runtime truth, never that the extension loaded', () => {
  it('a fresh project does not show a tick', () => {
    const snapshot = projectSnapshot(project());
    const bar = statusBarText(snapshot, Language.EN);
    expect(bar).not.toContain('$(check)');
    expect(bar).toContain('Serva');
  });

  it('a blocking decision shows the owner state in both languages', () => {
    const rt = project();
    seedHostileDecision(rt);
    const snapshot = projectSnapshot(rt);
    expect(statusBarText(snapshot, Language.EN)).toContain('$(person)');
    expect(healthLabel(snapshot.health, Language.EN)).toBe('Your decision needed');
    expect(healthLabel(snapshot.health, Language.AR)).toBe('بانتظار قرارك');
  });

  it('there is no way to render a status that the snapshot did not produce', () => {
    /*
     * `statusBarText` takes a snapshot and nothing else — no flag, no override, no
     * "assume healthy". A status bar that could be set would be set on activation.
     */
    expect(statusBarText.length).toBe(2);
  });
});

/* ====================================================================== accessibility */

describe('the panel is navigable and announces itself', () => {
  it('sections are labelled and the status is a live region', () => {
    const html = renderControlCenter({
      snapshot: projectSnapshot(project()),
      language: Language.EN,
      nonce: 'N1',
      cspSource: 'vscode-resource:',
      styleUri: 's.css',
      scriptUri: 'p.js',
    });
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    /* Every section names its own heading rather than relying on visual grouping. */
    const sections = html.match(/aria-labelledby="/g) ?? [];
    expect(sections.length).toBeGreaterThanOrEqual(6);
    for (const id of ['overview-h', 'decisions-h', 'release-h', 'machine-h']) {
      expect(html).toContain('id="' + id + '"');
    }
  });

  it('options are buttons rather than clickable divs', () => {
    const rt = project();
    seedHostileDecision(rt);
    const html = renderControlCenter({
      snapshot: projectSnapshot(rt),
      language: Language.EN,
      nonce: 'N1',
      cspSource: 'vscode-resource:',
      styleUri: 's.css',
      scriptUri: 'p.js',
    });
    /* A div with a click handler is invisible to a keyboard and to a screen reader. */
    expect(html).toContain('<button type="button" data-option-for=');
    expect(html).not.toMatch(/<div[^>]*onclick/);
  });
});

/* ================================================================= the manifest */

describe('the extension manifest is deliberate about authority', () => {
  const manifest = JSON.parse(readFileSync('extension/package.json', 'utf8')) as Record<
    string,
    unknown
  >;

  it('activates on a Serva project rather than on everything', () => {
    /*
     * `*` activation would open the Store in every window the owner has. Serva activates
     * when a folder actually contains a store marker, and does nothing otherwise.
     */
    expect(manifest['activationEvents']).toEqual(['workspaceContains:.serva/SCHEMA_VERSION']);
  });

  it('refuses to run in an untrusted workspace, with the reason', () => {
    const capabilities = manifest['capabilities'] as {
      untrustedWorkspaces?: { supported?: boolean; description?: string };
    };
    expect(capabilities.untrustedWorkspaces?.supported).toBe(false);
    expect(String(capabilities.untrustedWorkspaces?.description).length).toBeGreaterThan(40);
  });

  it('every contributed command exists in the extension source', () => {
    const source = readFileSync('extension/src/extension.ts', 'utf8');
    const contributed = (
      (manifest['contributes'] as { commands?: { command: string }[] }).commands ?? []
    ).map((c) => c.command);
    expect(contributed.length).toBeGreaterThan(4);
    for (const command of contributed) {
      /* A command in the manifest with no handler is a menu entry that does nothing. */
      expect(source, command + ' is contributed and not registered').toContain("'" + command + "'");
    }
  });

  it('the panel script never builds HTML from project content', () => {
    /* Comments stripped: the rule is about what the script DOES, not what it explains. */
    const script = readFileSync('extension/media/panel.js', 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    /*
     * The host builds the document, escaped. A panel script that concatenated project text
     * into innerHTML would be the one place the escaping did not apply.
     */
    expect(script).not.toContain('innerHTML');
    expect(script).not.toContain('eval(');
    expect(script).not.toContain('document.write');
  });

  it('the stylesheet mirrors with logical properties rather than physical ones', () => {
    const css = readFileSync('extension/media/style.css', 'utf8');
    expect(css).toContain('margin-inline');
    expect(css).toContain('padding-inline-start');
    /* And isolates technical spans so an RTL context cannot reorder a path. */
    expect(css).toContain('unicode-bidi: isolate');
    /* Physical directional margins are what leave the furniture behind when mirroring. */
    expect(css).not.toMatch(/margin-left\s*:/);
    expect(css).not.toMatch(/padding-left\s*:/);
  });

  it('focus is visible and targets are large enough to hit', () => {
    const css = readFileSync('extension/media/style.css', 'utf8');
    expect(css).toContain('focus-visible');
    expect(css).toContain('min-height: 32px');
    expect(css).toContain('prefers-reduced-motion');
  });
});
