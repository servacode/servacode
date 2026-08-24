import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ServaRuntime } from '../src/app/runtime.js';
import { createProject } from '../src/app/create.js';
import { walkPortability, renderPortabilityWalk } from '../src/acceptance/portabilityProof.js';
import { ARTIFACT_TYPES, repository } from '../src/intelligence/repository.js';
import { OwnerDecisionRequestSchema } from '../src/intelligence/artifacts/governance.js';
import { cleanup, tempRoot } from './helpers.js';

/**
 * THE PORTABILITY WALK, PERFORMED ON REAL FILES.
 *
 * SPEC: Phase 6 final acceptance sequence §3.
 *
 * PORTABILITY-FINAL is the requirement most easily faked. An earlier iteration of this product
 * passed it because a status reader matched three phrases in a markdown file — which is why
 * the walk is performed here rather than described anywhere.
 *
 * The two properties that matter more than "it came back" are that nothing SECRET travels and
 * no AUTHORITY travels, and both have their own step.
 */

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) cleanup(r);
});

const IDEA = 'أريد نظاماً يوقف ضياع طلبات الهاتف — stop the phone orders getting lost';

/**
 * A disposable project with truth worth moving: an Idea, an owner decision, git history and a
 * file the owner would recognise.
 */
function seedProject(root: string): { decisionId: string; commit: string } {
  mkdirSync(root, { recursive: true });
  createProject({ root, name: 'RahalGo', idea: IDEA });

  const rt = ServaRuntime.open({ root });
  let decisionId: string;
  try {
    const at = rt.clock.now();
    decisionId = rt.ids.next('SC-ODR');
    const tx = rt.store.begin();
    repository(rt.store, ARTIFACT_TYPES.OWNER_DECISION_REQUEST, OwnerDecisionRequestSchema).put(
      tx,
      {
        id: decisionId,
        createdAt: at,
        question: 'What delivery radius do you commit to?',
        whyServaCannotDecide: 'It is a commercial commitment.',
        purpose: 'BUSINESS_RULE',
        responseMode: 'VALUE',
        valueKind: 'TEXT',
        options: [],
        recommendation: 'State the figure.',
        recommendationRationale: 'Nothing implies it.',
        blocksWork: true,
        blockedRefs: [],
        state: 'ANSWERED',
        answerValue: '12 km inside the ring road',
        answeredBy: 'owner',
        answeredAt: at,
        meta: { provenance: { marking: 'SYSTEM', component: 'test' }, attribution: { at } },
      } as never,
    );
    tx.commit();
  } finally {
    rt.close();
  }

  /* Real git history, because a restore that lost it would have lost the work itself. */
  const g = (args: string[]): void => {
    execFileSync('git', args, { cwd: root, stdio: ['ignore', 'ignore', 'ignore'] });
  };
  writeFileSync(join(root, 'README.md'), '# RahalGo\n\nPhone orders.\n', 'utf8');
  g(['init', '-q']);
  g(['config', 'user.email', 'owner@example.invalid']);
  g(['config', 'user.name', 'Owner']);
  g(['add', '-A']);
  g(['commit', '-q', '-m', 'the work that must survive a move']);
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();

  return { decisionId, commit };
}

function workspace(): string {
  const root = tempRoot();
  roots.push(root);
  return root;
}

describe('a project moves to another machine, and its authority does not', () => {
  const result = walkPortability({ workspace: workspace(), seed: seedProject });

  it('completed every step of the walk', () => {
    expect(result.passed, renderPortabilityWalk(result)).toBe(true);
  });

  it('wrote and verified a real backup', () => {
    expect(result.steps.find((s) => s.id === 'BACKUP')?.passed).toBe(true);
    expect(result.steps.find((s) => s.id === 'VERIFY')?.passed).toBe(true);
    expect(result.manifest?.projects[0]?.name).toBe('RahalGo');
  });

  it('carried nothing that matches a credential shape', () => {
    const step = result.steps.find((s) => s.id === 'NO_CREDENTIALS');
    expect(step?.passed, step?.detail).toBe(true);
  });

  it('carried no machine-bound family', () => {
    const step = result.steps.find((s) => s.id === 'NO_MACHINE_BOUND');
    expect(step?.passed, step?.detail).toBe(true);
  });

  it('restored into a fresh path after the original was taken away', () => {
    expect(result.steps.find((s) => s.id === 'ORIGINAL_REMOVED')?.passed).toBe(true);
    expect(result.steps.find((s) => s.id === 'RESTORED')?.passed).toBe(true);
    expect(result.restoredRoot).toBeDefined();
  });

  it('brought back every file, with git identity and history intact', () => {
    const inventory = result.steps.find((s) => s.id === 'INVENTORY');
    const git = result.steps.find((s) => s.id === 'GIT_IDENTITY');
    expect(inventory?.passed, inventory?.detail).toBe(true);
    expect(git?.passed, git?.detail).toBe(true);
  });

  it('brought back the canonical Store and the owner’s answered decision', () => {
    expect(result.steps.find((s) => s.id === 'CANONICAL_STORE')?.passed).toBe(true);
    const decisions = result.steps.find((s) => s.id === 'OWNER_DECISIONS');
    expect(decisions?.passed, decisions?.detail).toBe(true);
  });

  it('did NOT bring the previous machine’s qualification with it', () => {
    /*
     * The point of the whole exercise. HARD describes a computer; a restore lands on a
     * different one. A product that carried authority across would have moved the one thing
     * it must never move.
     */
    const step = result.steps.find((s) => s.id === 'NO_AUTHORITY_TRANSFERRED');
    expect(step?.passed, step?.detail).toBe(true);
    expect(step?.detail).toContain('must measure itself');
  });

  it('renders a result an owner can read, and says what it proves', () => {
    const rendered = renderPortabilityWalk(result);
    expect(rendered).toContain('PORTABILITY ACCEPTANCE');
    expect(rendered).toContain('the machine authority did not');
  });
});
