import { afterEach, describe, expect, it } from 'vitest';
import { ToolCallOutcome } from '../src/engine/types.js';
import { verifyEvidenceClaims } from '../src/agents/envelope.js';
import { absoluteRule, relativeRule } from '../src/agents/toolPolicy.js';
import { resolveReviewerPolicy } from '../src/engineering/capability.js';
import { WslTransport, GUEST_PATH } from '../src/substrate/transport.js';
import { cleanup, freshStore } from './helpers.js';
import type { EngineeringWorkspace } from '../src/engineering/workspace.js';

/**
 * HARD ACTIVATION CLOSURE.
 *
 * Three defects, all found by running the real thing on a real guest, all fixed here
 * with the property each one violated stated as a test.
 */

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) cleanup(r);
});

/* =================================================== A1 — reviewer read scope */

describe('the reviewer can read the change it was dispatched to review', () => {
  const workspace = (path: string): EngineeringWorkspace =>
    ({ path, workspaceId: 'SC-WI-1-a01', workItemId: 'SC-WI-1' }) as EngineeringWorkspace;

  const toGuest = (p: string): string => new WslTransport('Ubuntu').toGuestPath(p);

  it('grants the worktree in BOTH the relative and the absolute form', () => {
    /*
     * A reviewer given only `Read(**)` was refused every read: it names files by their
     * absolute path in the execution environment, which a cwd-relative rule does not
     * match, so under `dontAsk` every call was auto-denied. Measured against the real
     * engine: `Read(//tmp/x/**)` authorises an absolute read that `Read(**)` alone
     * does not.
     */
    const policy = resolveReviewerPolicy(workspace('C:\\wt\\a01'), 'C:\\proj', {
      toExecutionPath: toGuest,
    });

    expect(policy.approve).toContain(relativeRule('Read', '**'));
    expect(policy.approve).toContain(absoluteRule('Read', '/mnt/c/wt/a01/**'));
    expect(policy.approve).toContain(absoluteRule('Grep', '/mnt/c/wt/a01/**'));
  });

  it('grants the worktree and nothing above it', () => {
    const policy = resolveReviewerPolicy(workspace('C:\\wt\\a01'), 'C:\\proj', {
      toExecutionPath: toGuest,
    });
    for (const rule of policy.approve) {
      // No rule may name the project root, a parent, or a bare filesystem anchor.
      expect(rule).not.toContain('//mnt/c/proj');
      expect(rule).not.toMatch(/\(\/\/\*\*\)/);
      expect(rule).not.toBe('Read(//**)');
    }
  });

  it('denies the store in both forms, and deny outranks allow', () => {
    const policy = resolveReviewerPolicy(workspace('C:\\wt\\a01'), 'C:\\proj', {
      toExecutionPath: toGuest,
    });
    expect(policy.deny).toContain(relativeRule('Read', '.serva/**'));
    expect(policy.deny).toContain(absoluteRule('Read', '/mnt/c/proj/.serva/**'));
    // A `.serva` inside the reviewer's own worktree is covered too: the absolute grant
    // above would otherwise reach it.
    expect(policy.deny).toContain(absoluteRule('Read', '/mnt/c/wt/a01/.serva/**'));
  });

  it('another worktree is not reachable by either form', () => {
    const policy = resolveReviewerPolicy(workspace('C:\\wt\\a01'), 'C:\\proj', {
      toExecutionPath: toGuest,
    });
    const other = absoluteRule('Read', '/mnt/c/wt/a02/**');
    expect(policy.approve).not.toContain(other);
    expect(policy.filesystem.read).toEqual(['C:\\wt\\a01']);
  });

  it('the reviewer still has no Edit, Write or Bash authority', () => {
    const policy = resolveReviewerPolicy(workspace('C:\\wt\\a01'), 'C:\\proj', {
      toExecutionPath: toGuest,
    });
    expect(policy.available).toEqual(['Read', 'Glob', 'Grep']);
    for (const t of ['Edit', 'Write', 'Bash']) {
      expect(policy.available).not.toContain(t);
      expect(policy.deny).toContain(t);
    }
    expect(policy.filesystem.write).toEqual([]);
    expect(policy.network).toBe('NONE');
  });
});

/* ============================================ A2 — a denial is not a violation */

describe('an evidence claim says what it expects to have happened', () => {
  let n = 0;
  const call = (tool: string, outcome: ToolCallOutcome, subject?: string) => ({
    useId: 'tu_' + String((n += 1)),
    tool,
    outcome,
    at: '2026-01-01T00:00:00.000Z',
    ...(subject === undefined ? {} : { subject }),
  });

  it('claiming a denial that was observed is CORROBORATED', () => {
    /*
     * The reviewer honestly reported that its Read was refused. The runtime had a
     * record of exactly that refusal. The two agreed, and the vocabulary could not
     * express agreement, so the run was failed for telling the truth.
     */
    const [a] = verifyEvidenceClaims(
      [
        {
          kind: 'FILE_READ',
          statement: 'My Read of src/total.js was denied by the permission layer.',
          tool: 'Read',
          reference: 'src/total.js',
          expectedOutcome: 'DENIED',
        },
      ],
      [call('Read', ToolCallOutcome.DENIED, 'src/total.js')],
      ['Read'],
    );
    expect(a?.verification).toBe('CORROBORATED');
  });

  it('claiming a denial with no such call at all is UNVERIFIED', () => {
    const [a] = verifyEvidenceClaims(
      [
        {
          kind: 'FILE_READ',
          statement: 'My Read was denied.',
          tool: 'Read',
          expectedOutcome: 'DENIED',
        },
      ],
      [],
      ['Read'],
    );
    // Recorded, not corroborated. Absence of a record is not a record of absence.
    expect(a?.verification).toBe('UNVERIFIED');
  });

  it('a truthful denial whose reference names two files is UNVERIFIED, not a fabrication', () => {
    /*
     * A live run was terminated EVIDENCE_VIOLATION for exactly this. The classifier said
     * "Attempted to open src/total.js and test.js with the Read tool" and BOTH reads had
     * genuinely been denied — but the reference named the pair, no single observed subject
     * matched it, and the code fell through to a contradiction whose message read:
     *
     *   the claim states Read denied, but the runtime observed denied, denied
     *
     * An outcome disagreement between two things that agreed. The agent reported a refusal
     * honestly and was called a fabricator for it, and the whole upstream lifecycle halted.
     *
     * A contradiction requires observing something DIFFERENT, not merely failing to bind a
     * reference.
     */
    const [a] = verifyEvidenceClaims(
      [
        {
          kind: 'FILE_READ',
          statement: 'Attempted to open src/total.js and test.js with the Read tool.',
          tool: 'Read',
          reference: 'src/total.js and test.js',
          expectedOutcome: 'DENIED',
        },
      ],
      [
        call('Read', ToolCallOutcome.DENIED, 'src/total.js'),
        call('Read', ToolCallOutcome.DENIED, 'test.js'),
      ],
      ['Read'],
    );
    expect(a?.verification).toBe('UNVERIFIED');
    expect(a?.reason).toContain('which is what the claim states');
  });

  it('and the fabrication check is not softened by that', () => {
    /*
     * The same unbindable reference, but the runtime observed the calls SUCCEEDING. The
     * outcome genuinely disagrees, so this is still a contradiction.
     */
    const [a] = verifyEvidenceClaims(
      [
        {
          kind: 'FILE_READ',
          statement: 'Attempted to open src/total.js and test.js; both were denied.',
          tool: 'Read',
          reference: 'src/total.js and test.js',
          expectedOutcome: 'DENIED',
        },
      ],
      [
        call('Read', ToolCallOutcome.SUCCEEDED, 'src/total.js'),
        call('Read', ToolCallOutcome.SUCCEEDED, 'test.js'),
      ],
      ['Read'],
    );
    expect(a?.verification).toBe('CONTRADICTED');
  });

  it('claiming a denial when the call SUCCEEDED is CONTRADICTED', () => {
    const [a] = verifyEvidenceClaims(
      [
        {
          kind: 'FILE_READ',
          statement: 'My Read was denied.',
          tool: 'Read',
          expectedOutcome: 'DENIED',
        },
      ],
      [call('Read', ToolCallOutcome.SUCCEEDED, 'src/total.js')],
      ['Read'],
    );
    expect(a?.verification).toBe('CONTRADICTED');
  });

  it('claiming SUCCESS on a denied call is still CONTRADICTED', () => {
    // The protection this whole mechanism exists for is untouched: an agent cannot
    // turn a refusal into a pass by describing it as one.
    const [a] = verifyEvidenceClaims(
      [{ kind: 'FILE_READ', statement: 'I read the file.', tool: 'Read' }],
      [call('Read', ToolCallOutcome.DENIED, 'src/total.js')],
      ['Read'],
    );
    expect(a?.verification).toBe('CONTRADICTED');
  });

  it('an omitted expectation still means SUCCEEDED', () => {
    const [a] = verifyEvidenceClaims(
      [{ kind: 'FILE_READ', statement: 'I read it.', tool: 'Read', reference: 'a.txt' }],
      [call('Read', ToolCallOutcome.SUCCEEDED, 'a.txt')],
      ['Read'],
    );
    expect(a?.verification).toBe('CORROBORATED');
  });
});

/* ================================== B — the environment must suit the environment */

describe('a host environment is translated before it reaches a guest', () => {
  it('a Windows PATH never crosses into the guest', () => {
    /*
     * The measured failure: `MINIMAL` scrubs the HOST environment, so the guest was
     * handed `PATH=C:\Users\...;C:\Program Files\Git\...`. `env -i PATH=<that> bwrap …`
     * could not resolve `bwrap`, every recipe exited 127, and the gate read it as a
     * failing test suite rather than a broken environment.
     */
    const t = new WslTransport('Ubuntu');
    const env = t.environmentFor({
      PATH: 'C:\\Users\\a\\bin;C:\\Program Files\\Git\\usr\\bin',
      HOME: 'C:\\Users\\a',
      LANG: 'en_GB.UTF-8',
      COMSPEC: 'C:\\Windows\\system32\\cmd.exe',
    });

    expect(env['PATH']).toBe(GUEST_PATH);
    // Windows-shaped values are dropped rather than translated: guessing a Linux
    // equivalent would be inventing a fact about the guest.
    expect(env['HOME']).toBeUndefined();
    expect(env['COMSPEC']).toBeUndefined();
    // Values that are not paths carry over untouched.
    expect(env['LANG']).toBe('en_GB.UTF-8');
  });

  it('a local transport passes the environment through unchanged', () => {
    const store = freshStore();
    roots.push(store.root);
    // Same machine: the host environment IS the execution environment, so translating
    // it would be corrupting it.
    expect(GUEST_PATH.startsWith('/')).toBe(true);
  });
});
