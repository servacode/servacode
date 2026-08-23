import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AcceptanceState, acceptanceStatus } from '../src/acceptance/status.js';
import { cleanup, tempRoot } from './helpers.js';

/**
 * READY FOR OWNER USE IS A CONJUNCTION, NOT A HEADLINE.
 *
 * It is the most tempting line in the product: one sentence, magnificent, and meaningless
 * — a product that declares its own readiness has declared a hope.
 *
 * These tests exist because the first version of the security check was
 * `/independent reviewer:\s*\S/i`, which matched the asterisk in
 * "**Independent reviewer:** *none recorded.*" — so a document whose own first line said it
 * was a self-review certified itself, and the status printed PASS. A control that a
 * plausible negative satisfies is not a control.
 */

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) cleanup(r);
});

/** A package directory with only the files a test puts in it. */
function pkg(files: Readonly<Record<string, string>> = {}): string {
  const root = tempRoot();
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const path = join(root, ...rel.split('/'));
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content, 'utf8');
  }
  return root;
}

function lineFor(root: string, label: string) {
  return acceptanceStatus(root).lines.find((l) => l.label === label);
}

describe('an empty package proves nothing', () => {
  it('reports NOT_VERIFIED everywhere and refuses READY', () => {
    const status = acceptanceStatus(pkg());
    expect(status.readyForOwnerUse).toBe(false);
    expect(status.rendered).not.toContain('READY FOR OWNER USE');
    expect(status.rendered).toContain('NOT READY');
    /* And every line says what it rests on, so the reader can go and look. */
    for (const line of status.lines) expect(line.source.length).toBeGreaterThan(0);
  });
});

describe('the security line cannot be satisfied by a disclaimer', () => {
  const REVIEW_HEAD = '# SECURITY REVIEW\n\n**Independent reviewer:** ';

  it('a review that records no reviewer is NOT_VERIFIED', () => {
    for (const claimed of [
      '*none recorded.*',
      'none',
      'N/A',
      'TBD',
      'pending',
      '_not recorded_',
      '',
    ]) {
      const root = pkg({ 'evidence/SECURITY_REVIEW.md': REVIEW_HEAD + claimed + '\n' });
      expect(lineFor(root, 'Security Acceptance')?.state, JSON.stringify(claimed)).toBe(
        AcceptanceState.NOT_VERIFIED,
      );
    }
  });

  it('a review that says NOT INDEPENDENTLY REVIEWED can never pass, whatever else it says', () => {
    const root = pkg({
      'evidence/SECURITY_REVIEW.md':
        REVIEW_HEAD + 'Jane Roe, external\n\nStatus: NOT INDEPENDENTLY REVIEWED\n',
    });
    expect(lineFor(root, 'Security Acceptance')?.state).toBe(AcceptanceState.NOT_VERIFIED);
  });

  it('a named reviewer passes, and the name is reported rather than assumed', () => {
    const root = pkg({
      'evidence/SECURITY_REVIEW.md': REVIEW_HEAD + 'Jane Roe, external\n\nEverything checked.\n',
    });
    const line = lineFor(root, 'Security Acceptance');
    expect(line?.state).toBe(AcceptanceState.PASS);
    expect(line?.detail).toContain('Jane Roe');
  });

  it('no review at all is NOT_VERIFIED, and says so plainly', () => {
    expect(lineFor(pkg(), 'Security Acceptance')?.detail).toContain('no security review');
  });
});

describe('the other lines are computed from files, not asserted', () => {
  it('portability needs a walkthrough that actually proves the three things', () => {
    const partial = pkg({
      'evidence/PORTABILITY_WALKTHROUGH.txt': 'every non-excluded file came back.\n',
    });
    /* One of three is not the proof: a restore that carried a qualification would say this too. */
    expect(lineFor(partial, 'Portability')?.state).toBe(AcceptanceState.NOT_VERIFIED);

    const complete = pkg({
      'evidence/PORTABILITY_WALKTHROUGH.txt': [
        'every non-excluded file came back.',
        'no machine-bound family is present.',
        'nothing in the bundle matches a credential shape.',
      ].join('\n'),
    });
    expect(lineFor(complete, 'Portability')?.state).toBe(AcceptanceState.PASS);
  });

  it('offline verification needs a captured run where every test passed', () => {
    const failing = pkg({ 'evidence/VERIFY.txt': 'Tests  1130 passed | 2 failed (1132)\n' });
    expect(lineFor(failing, 'Offline Verification')?.state).toBe(AcceptanceState.NOT_VERIFIED);

    const passing = pkg({ 'evidence/VERIFY.txt': 'Tests  1132 passed (1132)\n' });
    expect(lineFor(passing, 'Offline Verification')?.state).toBe(AcceptanceState.PASS);
  });

  it('the acceptance matrix must have every row covered', () => {
    const incomplete = pkg({
      'evidence/ACCEPTANCE_MATRIX.json': JSON.stringify({
        summary: { total: 33, covered: 32, missing: ['P6-DOCS'] },
      }),
    });
    const line = lineFor(incomplete, 'Acceptance Matrix');
    expect(line?.state).toBe(AcceptanceState.NOT_VERIFIED);
    expect(line?.detail).toContain('P6-DOCS');
  });

  it('live acceptance needs captured evidence of an accepted chain', () => {
    const claimed = pkg({ 'evidence/LIVE_SERVA_ACCEPTANCE.txt': 'it all went fine\n' });
    /* A log that does not record an acceptance is not evidence of one. */
    expect(lineFor(claimed, 'Live Acceptance')?.state).toBe(AcceptanceState.NOT_VERIFIED);
  });

  it('the HARD line describes the package, and never claims a machine is qualified', () => {
    const root = pkg({ 'src/substrate/boundary.ts': 'export const x = 1;\n' });
    const line = lineFor(root, 'Engineering HARD');
    expect(line?.state).toBe(AcceptanceState.PASS);
    /*
     * A status computed by reading a directory cannot know whether a computer earned HARD.
     * Saying so is the difference between a fact and an implication.
     */
    expect(line?.detail).toContain('machine doctor');
  });
});

describe('READY is all of it or none of it', () => {
  it('one unproven line is enough to withhold it', () => {
    const status = acceptanceStatus(pkg());
    expect(status.notProven.length).toBeGreaterThan(0);
    expect(status.readyForOwnerUse).toBe(false);
    /* No asterisk, no "READY with caveats" — the string simply is not there. */
    expect(status.rendered).not.toMatch(/READY FOR OWNER USE/);
  });

  it('every unproven line is named with its reason', () => {
    const status = acceptanceStatus(pkg());
    for (const entry of status.notProven) {
      expect(entry).toMatch(/\((NOT_VERIFIED|FAIL):/);
    }
  });
});
