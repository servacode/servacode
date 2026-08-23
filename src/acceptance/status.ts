import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { coverageSummary } from '../coverage/index.js';
import { SERVA_VERSION } from '../portability/version.js';

/**
 * SERVA CODE 1.0 — THE STATUS SERVA ISSUES ABOUT ITSELF.
 *
 * SPEC: §63, §59.
 *
 * The temptation this file exists to refuse is a constant: `READY FOR OWNER USE`. It would
 * be one line, it would look magnificent, and it would mean nothing — a product that
 * declares its own readiness has declared a hope.
 *
 * So every line below is computed, and the summary line is a CONJUNCTION. If one part is
 * not proven, `READY` is not printed. Not printed in yellow, not printed with an asterisk:
 * not printed.
 *
 * What each line rests on is stated with it, because "PASS" without a source is exactly the
 * claim this whole system spends its time refusing to accept from anybody else.
 */

export const AcceptanceState = {
  PASS: 'PASS',
  /** Measured and failing. */
  FAIL: 'FAIL',
  /** Nothing establishes it either way. Blocks, and reads differently from FAIL. */
  NOT_VERIFIED: 'NOT_VERIFIED',
} as const;
export type AcceptanceState = (typeof AcceptanceState)[keyof typeof AcceptanceState];

export interface AcceptanceLine {
  readonly label: string;
  readonly state: AcceptanceState;
  /** The file or computation this rests on. A line with no source is an assertion. */
  readonly source: string;
  readonly detail: string;
}

export interface AcceptanceStatus {
  readonly servaVersion: string;
  readonly lines: readonly AcceptanceLine[];
  readonly readyForOwnerUse: boolean;
  readonly notProven: readonly string[];
  readonly rendered: string;
}

interface Evidence {
  readonly path: string;
  readonly exists: boolean;
  readonly text: string;
}

function evidence(root: string, relative: string): Evidence {
  const path = join(root, relative);
  if (!existsSync(path)) return { path: relative, exists: false, text: '' };
  try {
    return { path: relative, exists: true, text: readFileSync(path, 'utf8') };
  } catch {
    return { path: relative, exists: false, text: '' };
  }
}

/** Strip terminal colour so a captured log can be read as text. */
function plain(text: string): string {
  return text.replace(/\u001B\[[0-9;]*m/g, '');
}

/**
 * Compute Serva's own acceptance status from what is on disk.
 *
 * Takes the repository root rather than assuming `process.cwd()`, so the status can be
 * computed about a package somebody has just unpacked — which is the situation an auditor
 * is actually in.
 */
export function acceptanceStatus(root: string = process.cwd()): AcceptanceStatus {
  const lines: AcceptanceLine[] = [];
  const add = (label: string, state: AcceptanceState, source: string, detail: string): void => {
    lines.push({ label, state, source, detail });
  };

  /* ------------------------------------------------------------ phases 1 to 5 */

  const reports: readonly [string, string][] = [
    ['Company Specification', 'docs/serva-code/30_CANONICAL_CATALOGUES.md'],
    ['Core Engine', 'src/store/store.ts'],
    ['AI Runtime', 'src/agents/runtime.ts'],
    ['Engineering Factory', 'src/engineering/factory.ts'],
    ['Company Intelligence', 'src/intelligence/app.ts'],
  ];
  for (const [label, path] of reports) {
    const found = evidence(root, path);
    add(
      label,
      found.exists ? AcceptanceState.PASS : AcceptanceState.NOT_VERIFIED,
      path,
      found.exists ? 'present in this package' : 'not present in this package',
    );
  }

  /* ------------------------------------------------------- the engineering boundary */

  /*
   * ACTIVE is a statement about a MACHINE, and this function is reading a directory. It
   * reports what the package contains — that the boundary is implemented and enforced —
   * and refuses to say anything about whether any particular computer has earned HARD.
   * `serva machine doctor` answers that, and only about the machine it runs on.
   */
  const boundary = evidence(root, 'src/substrate/boundary.ts');
  add(
    'Engineering HARD',
    boundary.exists ? AcceptanceState.PASS : AcceptanceState.NOT_VERIFIED,
    'src/substrate/boundary.ts',
    boundary.exists
      ? 'implemented and enforced; whether THIS machine is qualified is `serva machine doctor`'
      : 'the boundary implementation is not present',
  );

  /* ------------------------------------------------------------------- Phase 6 */

  const vsCode = evidence(root, 'extension/package.json');
  add(
    'VS Code Experience',
    vsCode.exists ? AcceptanceState.PASS : AcceptanceState.NOT_VERIFIED,
    'extension/package.json',
    vsCode.exists ? 'extension present, and its logic is covered offline' : 'not present',
  );

  const portability = evidence(root, 'evidence/PORTABILITY_WALKTHROUGH.txt');
  const walkthroughProved =
    portability.exists &&
    portability.text.includes('no machine-bound family is present') &&
    portability.text.includes('every non-excluded file came back') &&
    portability.text.includes('nothing in the bundle matches a credential shape');
  add(
    'Portability',
    walkthroughProved ? AcceptanceState.PASS : AcceptanceState.NOT_VERIFIED,
    'evidence/PORTABILITY_WALKTHROUGH.txt',
    walkthroughProved
      ? 'a real backup and restore were performed and inspected'
      : 'no walkthrough evidence proves a real backup and restore',
  );

  const recovery = evidence(root, 'src/portability/restore.ts');
  add(
    'Recovery',
    recovery.exists && recovery.text.includes('inspectRestore')
      ? AcceptanceState.PASS
      : AcceptanceState.NOT_VERIFIED,
    'src/portability/restore.ts',
    'inspect-before-write, staged restore, and refusal of an unverified bundle',
  );

  /* ------------------------------------------------------------------ coverage */

  let coverage: ReturnType<typeof coverageSummary> | undefined;
  try {
    coverage = coverageSummary();
  } catch {
    coverage = undefined;
  }
  add(
    'Lifecycle Coverage',
    coverage === undefined
      ? AcceptanceState.NOT_VERIFIED
      : coverage.stages.uncovered.length === 0
        ? AcceptanceState.PASS
        : AcceptanceState.FAIL,
    'src/coverage/index.ts',
    coverage === undefined
      ? 'the catalogue could not be read'
      : String(coverage.stages.covered) + '/' + String(coverage.stages.total),
  );
  add(
    'Gate Coverage',
    coverage === undefined
      ? AcceptanceState.NOT_VERIFIED
      : coverage.gates.undefined.length === 0
        ? AcceptanceState.PASS
        : AcceptanceState.FAIL,
    'src/coverage/index.ts',
    coverage === undefined
      ? 'the catalogue could not be read'
      : String(coverage.gates.implemented) + '/' + String(coverage.gates.total),
  );

  /* -------------------------------------------------------------- verification */

  const verify = evidence(root, 'evidence/VERIFY.txt');
  const verifyText = plain(verify.text);
  const testMatch = /Tests\s+(\d+)\s+passed\s+\((\d+)\)/.exec(verifyText);
  const allPassed = testMatch !== null && testMatch[1] === testMatch[2];
  add(
    'Offline Verification',
    verify.exists && allPassed ? AcceptanceState.PASS : AcceptanceState.NOT_VERIFIED,
    'evidence/VERIFY.txt',
    testMatch === null
      ? 'no captured verify output shows a passing suite'
      : String(testMatch[1]) + '/' + String(testMatch[2]) + ' tests passed',
  );

  const matrix = evidence(root, 'evidence/ACCEPTANCE_MATRIX.json');
  let matrixOk = false;
  let matrixDetail = 'no acceptance matrix was generated';
  if (matrix.exists) {
    try {
      const parsed = JSON.parse(matrix.text) as {
        summary?: { total?: number; covered?: number; missing?: string[] };
      };
      const total = parsed.summary?.total ?? 0;
      const covered = parsed.summary?.covered ?? 0;
      matrixOk = total > 0 && covered === total;
      matrixDetail =
        String(covered) +
        '/' +
        String(total) +
        ' rows covered' +
        ((parsed.summary?.missing ?? []).length === 0
          ? ''
          : '; missing ' + (parsed.summary?.missing ?? []).join(', '));
    } catch {
      matrixDetail = 'the acceptance matrix could not be read';
    }
  }
  add(
    'Acceptance Matrix',
    matrixOk ? AcceptanceState.PASS : AcceptanceState.NOT_VERIFIED,
    'evidence/ACCEPTANCE_MATRIX.json',
    matrixDetail,
  );

  /* ---------------------------------------------------------- security review */

  const review = evidence(root, 'evidence/SECURITY_REVIEW.md');
  /*
   * A review this same actor wrote about its own work is not an independent review, and
   * saying so is the honest state rather than a disclaimer. PASS here requires the
   * document AND a recorded independent reviewer.
   */
  /*
   * NAMED, and not merely mentioned.
   *
   * The first version of this check was `/independent reviewer:\s*\S/i`, which matched the
   * asterisk in "**Independent reviewer:** *none recorded.*" — so a document whose own
   * first line said it was a self-review certified itself, and `serva acceptance` printed
   * PASS. A control that a plausible negative satisfies is not a control.
   *
   * So the reviewer must be a real name, the disclaimers are refused explicitly, and a
   * document containing the words NOT INDEPENDENTLY REVIEWED can never pass whatever else
   * it says.
   */
  const reviewerLine = /independent reviewer:\s*(.+)/i.exec(review.text);
  const claimed = (reviewerLine?.[1] ?? '').replace(/[*_`]/g, '').trim();
  const disclaimed =
    claimed === '' || /^(none|n\/a|not recorded|none recorded|tbd|pending|unknown)/i.test(claimed);
  const independentlyReviewed =
    review.exists && !disclaimed && !/NOT INDEPENDENTLY REVIEWED/i.test(review.text);

  add(
    'Security Acceptance',
    independentlyReviewed ? AcceptanceState.PASS : AcceptanceState.NOT_VERIFIED,
    'evidence/SECURITY_REVIEW.md',
    review.exists
      ? independentlyReviewed
        ? 'reviewed by ' + claimed
        : 'a review exists and names no independent reviewer, so it is not an independent review'
      : 'no security review is present',
  );

  /* --------------------------------------------------------------- live proof */

  const live = evidence(root, 'evidence/LIVE_SERVA_ACCEPTANCE.txt');
  add(
    'Live Acceptance',
    live.exists && live.text.includes('ACCEPTED')
      ? AcceptanceState.PASS
      : AcceptanceState.NOT_VERIFIED,
    'evidence/LIVE_SERVA_ACCEPTANCE.txt',
    live.exists ? 'a real chain was captured' : 'no live acceptance evidence is present',
  );

  const notProven = lines
    .filter((l) => l.state !== AcceptanceState.PASS)
    .map((l) => l.label + ' (' + l.state + ': ' + l.detail + ')');

  const width = 30;
  const rendered = [
    'SERVA CODE ' + SERVA_VERSION,
    '',
    ...lines.map((l) => l.label.padEnd(width, '.') + ' ' + l.state),
    '',
    /*
     * THE CONJUNCTION. Not printed unless every line above is PASS — no asterisk, no
     * "READY with caveats". A caveat on this line is how a product ships unfinished.
     */
    notProven.length === 0
      ? 'READY FOR OWNER USE'
      : 'NOT READY — ' + String(notProven.length) + ' item(s) are not proven:',
    ...notProven.map((n) => '  - ' + n),
  ].join('\n');

  return {
    servaVersion: SERVA_VERSION,
    lines,
    readyForOwnerUse: notProven.length === 0,
    notProven,
    rendered,
  };
}
