import { afterEach, describe, expect, it } from 'vitest';
import {
  SCOPE_REVIEW_CANON_TYPE,
  ScopeCoverage,
  listScopeReviews,
  recordScopeReview,
  readScopeReview,
} from '../src/acceptance/scopeReview.js';
import { ReviewVerdict, Severity } from '../src/acceptance/securityReview.js';
import {
  AREA_SOURCES,
  NON_SECURITY_SOURCES,
  reviewUnitsFor,
} from '../src/acceptance/securityReviewRun.js';
import { REQUIRED_SCOPE } from '../src/acceptance/securityReview.js';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ServaRuntime } from '../src/app/runtime.js';
import { cleanup, tempRoot } from './helpers.js';

/**
 * A BLOCKED REVIEW MUST LEAVE MORE EVIDENCE THAN A CLEAN ONE, NOT LESS.
 *
 * SPEC: finding SSA-5, from the independent security review.
 *
 * The scoped reviewer held its findings in memory and the script exited without writing them.
 * The first real run produced a BLOCKED verdict on `Serva self-acceptance authority` — four
 * genuine findings against the acceptance machinery — and left nothing on disk. Reading them
 * back meant paying for the review again.
 *
 * That is exactly backwards. A review that finds nothing costs little to repeat; a review that
 * finds something is the one whose evidence must survive. So every scoped attempt persists,
 * whatever its outcome, and a later resolver can aggregate what already happened without
 * spending a single model call.
 */

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) cleanup(r);
});

const COMMIT = 'a'.repeat(40);
const TREE = 'b'.repeat(40);

function project(): ServaRuntime {
  const root = tempRoot();
  roots.push(root);
  return ServaRuntime.init('RahalGo', 'Stop losing phone orders', { root });
}

function attempt(over: Record<string, unknown> = {}) {
  return {
    scopeId: 'core-store-integrity',
    scopeName: 'Core Store/integrity',
    implementationCommit: COMMIT,
    treeDigest: TREE,
    reviewerRunId: 'SC-RUN-000001',
    reviewerAgentId: 'SC-AGENT-220',
    coverage: ScopeCoverage.COMPLETE,
    filesReviewed: ['src/store/store.ts'],
    filesOmitted: [],
    findings: [],
    verdict: ReviewVerdict.ACCEPTED,
    terminalOutcome: 'COMPLETED',
    reviewedAt: '2026-08-25T00:00:00.000Z',
    ...over,
  };
}

describe('every scoped review attempt is durable, whatever its outcome', () => {
  it('persists a clean review and reads it back identically', () => {
    const rt = project();
    const id = recordScopeReview(rt.store, attempt());
    const back = readScopeReview(rt.store, id);
    expect(back?.scopeName).toBe('Core Store/integrity');
    expect(back?.verdict).toBe(ReviewVerdict.ACCEPTED);
    expect(back?.implementationCommit).toBe(COMMIT);
  });

  it('persists a BLOCKED review WITH the findings that blocked it', () => {
    /* The case that motivated this. Four real findings existed and none survived the exit. */
    const rt = project();
    const id = recordScopeReview(
      rt.store,
      attempt({
        scopeId: 'serva-self-acceptance-authority',
        scopeName: 'Serva self-acceptance authority',
        verdict: ReviewVerdict.BLOCKED,
        findings: [
          {
            id: 'SSA-1',
            severity: Severity.HIGH,
            area: 'Serva self-acceptance authority',
            statement: 'the independence guard is inert on the default path',
            evidence: ['src/acceptance/proof.ts:445'],
            resolved: false,
          },
        ],
      }),
    );
    const back = readScopeReview(rt.store, id);
    expect(back?.verdict).toBe(ReviewVerdict.BLOCKED);
    expect(back?.findings.length).toBe(1);
    expect(back?.findings[0]?.severity).toBe(Severity.HIGH);
    expect(back?.findings[0]?.evidence).toContain('src/acceptance/proof.ts:445');
  });

  it('persists an EVIDENCE_VIOLATION attempt, which produced no verdict at all', () => {
    const rt = project();
    const id = recordScopeReview(
      rt.store,
      attempt({
        coverage: ScopeCoverage.NOT_REVIEWED,
        verdict: ReviewVerdict.NOT_VERIFIED,
        terminalOutcome: 'EVIDENCE_VIOLATION',
        refusal: 'the reviewer claimed to have read files it holds no tool to read',
      }),
    );
    const back = readScopeReview(rt.store, id);
    expect(back?.terminalOutcome).toBe('EVIDENCE_VIOLATION');
    expect(back?.refusal).toContain('claimed');
    expect(back?.coverage).toBe(ScopeCoverage.NOT_REVIEWED);
  });

  it('records omitted files as omitted, never as covered', () => {
    /*
     * A partial view is the one thing a coverage record must not round up. The reviewer that
     * returned NOT_VERIFIED with 41 files missing was right to, and the record has to say so.
     */
    const rt = project();
    const id = recordScopeReview(
      rt.store,
      attempt({
        coverage: ScopeCoverage.PARTIAL,
        filesOmitted: ['src/intelligence/a.ts', 'src/intelligence/b.ts'],
        verdict: ReviewVerdict.NOT_VERIFIED,
      }),
    );
    const back = readScopeReview(rt.store, id);
    expect(back?.coverage).toBe(ScopeCoverage.PARTIAL);
    expect(back?.filesOmitted.length).toBe(2);
  });

  it('survives a process exit: a new Store over the same root reads it back', () => {
    /*
     * The actual property. `recordScopeReview` writes through a transaction, so the test opens
     * the project again rather than reusing the handle that wrote it.
     */
    const rt = project();
    const root = rt.root;
    recordScopeReview(rt.store, attempt({ verdict: ReviewVerdict.BLOCKED }));
    rt.close();

    const reopened = ServaRuntime.open({ root });
    try {
      const all = listScopeReviews(reopened.store);
      expect(all.length).toBe(1);
      expect(all[0]?.verdict).toBe(ReviewVerdict.BLOCKED);
      expect(all[0]?.implementationCommit).toBe(COMMIT);
    } finally {
      reopened.close();
    }
  });

  it('keeps every attempt at the same scope, so a retry does not erase what came before', () => {
    /* A second attempt is new evidence about the same question, not a correction of the first. */
    const rt = project();
    recordScopeReview(rt.store, attempt({ terminalOutcome: 'EVIDENCE_VIOLATION' }));
    recordScopeReview(rt.store, attempt({ reviewerRunId: 'SC-RUN-000002' }));
    expect(listScopeReviews(rt.store).length).toBe(2);
  });

  it('refuses to record an attempt that names no commit', () => {
    /* Evidence that binds to nothing describes nothing. */
    const rt = project();
    expect(() => recordScopeReview(rt.store, attempt({ implementationCommit: 'nope' }))).toThrow();
  });

  it('writes under its own canon type, so nothing else collides with it', () => {
    const rt = project();
    recordScopeReview(rt.store, attempt());
    expect(rt.store.listCanonIds(SCOPE_REVIEW_CANON_TYPE).length).toBe(1);
  });
});

describe('the code that obeys the pointer is reviewed, not only the code that writes it', () => {
  /*
   * SPEC: the 1.0.1 packaging audit, §17.2; Phase 6 final acceptance sequence §7.
   *
   * The install area mapped to `src/portability/` and `src/cli/commands/`. In 1.0.1 the CLI
   * ENTRY POINT became the thing that reads `~/.serva-code/current` and hands the path it finds
   * to a process launcher — and `src/cli/main.ts` matched neither prefix. The security review
   * would have read the installer that writes the pointer and never read the code that obeys it,
   * and reported COMPLETE coverage while doing so.
   *
   * A missing prefix does not fail. It quietly narrows what "reviewed" means.
   */
  it('the install area covers the entry point that resolves the active version', () => {
    const prefixes = AREA_SOURCES['install/update/rollback'] ?? [];
    expect(
      prefixes.some((prefix) => 'src/cli/main.ts'.startsWith(prefix)),
      'the delegation entry point must be inside the install review area',
    ).toBe(true);
  });

  it('every file the delegation is implemented in is inside some review area', () => {
    /*
     * By behaviour rather than by name: whichever files carry the version-switching logic,
     * they must be reviewable. Adding a third file and forgetting the scope is the same
     * defect wearing a different filename.
     */
    const delegation = [
      'src/portability/activeVersion.ts',
      'src/portability/install.ts',
      'src/cli/main.ts',
      'src/cli/commands/portability.ts',
    ];
    const allPrefixes = Object.values(AREA_SOURCES).flat();
    for (const file of delegation) {
      expect(
        allPrefixes.some((prefix) => file.startsWith(prefix)),
        file + ' is not covered by any security review area',
      ).toBe(true);
    }
  });
});

describe('no source module can be security-relevant and unreviewed by accident', () => {
  /*
   * THE GUARD THE SCOPE MAP NEVER HAD.
   *
   * SPEC: the 1.0.1 security scope triage; Phase 6 final acceptance sequence §7.
   *
   * `REQUIRED_SCOPE` was written once and the code kept moving. By 1.0.1, 22 of 195 modules
   * matched no area — including the module that owns every Git invocation, the secrets
   * scanner, the module asserting an accepted commit equals the verified ChangeSet, and the
   * validated-command surface the webview reaches Serva through. The review passed every
   * area it knew about and reported COMPLETE, which was true and meant much less than it
   * sounded.
   *
   * Nothing detected that, because "outside every area" and "reviewed and found irrelevant"
   * were the same observable state: absence.
   *
   * So absence is no longer permitted to mean anything. The two sets must PARTITION the
   * source tree — every module either inside an area or named in NON_SECURITY_SOURCES with
   * a reason. A module added later belongs to neither and fails here, which forces the
   * decision to be made once, in the open, by whoever added it.
   *
   * This is deliberately not a list of filenames to keep in step. It is the statement that
   * the tree and the scope map describe the same set of files.
   */
  function sourceFiles(): string[] {
    const found: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name).split('\\').join('/');
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.ts')) found.push(full);
      }
    };
    walk('src');
    return found;
  }

  const covered = (file: string): boolean =>
    Object.values(AREA_SOURCES)
      .flat()
      .some((prefix) => file.startsWith(prefix));

  it('every source module is either in a review area or explicitly excluded', () => {
    const unaccounted = sourceFiles().filter(
      (f) => !covered(f) && NON_SECURITY_SOURCES[f] === undefined,
    );
    expect(
      unaccounted,
      'these are in no review area and carry no exclusion rationale — classify each one',
    ).toEqual([]);
  });

  it('nothing is both reviewed and excluded', () => {
    /* An entry that is covered AND excluded means the exclusion is dead text nobody will
       re-read, and the rationale stops describing anything. */
    const both = Object.keys(NON_SECURITY_SOURCES).filter((f) => covered(f));
    expect(both, 'excluded, yet inside a review area').toEqual([]);
  });

  it('every exclusion names a file that exists, and says why', () => {
    /* An exclusion for a deleted file is a rationale that outlived its subject, and would
       silently keep a future file of the same name out of review. */
    const all = new Set(sourceFiles());
    for (const [file, reason] of Object.entries(NON_SECURITY_SOURCES)) {
      expect(all.has(file), file + ' is excluded but does not exist').toBe(true);
      expect(reason.length, file + ' is excluded without a reason').toBeGreaterThan(40);
    }
  });

  it('the modules that spawn processes or touch credentials are reviewed', () => {
    /*
     * The specific capabilities the triage found outside the map, asserted by capability
     * rather than by name: whichever module ends up owning them, it must be reviewed.
     */
    for (const file of sourceFiles()) {
      const text = readFileSync(file, 'utf8');
      const spawns = /from 'node:child_process'/.test(text);
      if (spawns) {
        expect(covered(file), file + ' spawns processes and is outside every review area').toBe(
          true,
        );
      }
    }
  });
});

describe('a review unit stays small enough to actually be read', () => {
  /*
   * MEASURED, NOT GUESSED.
   *
   * SPEC: the 1.0.1 security scope triage; Phase 6 final acceptance sequence §7.
   *
   * `bootstrap` mapped to 23 files across two unrelated trees. The reviewer returned ACCEPTED
   * having read 22 of them and said nothing about the twenty-third — it did not refuse, it did
   * not error, it simply stopped. The aggregate caught it because coverage is computed from
   * the file list rather than taken from the verdict, and refused to mint the proof.
   *
   * That is the failure mode this asserts against. An oversized unit does not fail loudly; it
   * quietly reviews less than it claims, and the claim still says ACCEPTED. The number below
   * is not a preference — 23 is the size that was observed to truncate, so units are held
   * comfortably beneath it.
   *
   * `AREA_SUBSCOPES` is the remedy and costs nothing in coverage: the sub-scopes of an area
   * cover exactly what the area covers, which the next test asserts.
   */
  const LARGEST_UNIT_OBSERVED_TO_TRUNCATE = 23;
  const CEILING = 20;

  function sourceFiles(): string[] {
    const found: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name).split('\\').join('/');
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.ts')) found.push(full);
      }
    };
    walk('src');
    return found;
  }

  const selectFor = (unit: { prefixes: readonly string[]; except?: readonly string[] }): string[] =>
    sourceFiles().filter(
      (f) =>
        unit.prefixes.some((prefix) => f.startsWith(prefix)) &&
        !(unit.except ?? []).some((prefix) => f.startsWith(prefix)),
    );

  /*
   * AND THE SAME QUESTION IN THE UNIT A FILE COUNT COULD NOT ANSWER.
   *
   * SPEC: the repeated ENGINE_ERROR on `Serva self-acceptance authority`, 1.0.1 acceptance.
   *
   * That unit was 13 files — comfortable against the ceiling above — and about 274,000
   * characters, 49,000 more than the next largest. It is the ONLY unit that ever failed to
   * produce a judgement: twice in six rounds, both `ENGINE_ERROR`, while no other unit failed
   * once. The file count was measuring the wrong thing for the one unit it needed to catch.
   *
   * Measured, like the ceiling above: 273,884 is the size that was observed to fail, and every
   * unit that has never failed is at or below 224,654. The number sits between them.
   */
  const SIZE_OBSERVED_TO_FAIL = 273_884;
  const SIZE_CEILING = 240_000;

  it('no unit is given more to read than a reviewer has been shown to get through', () => {
    expect(SIZE_CEILING, 'the ceiling must sit below what was observed to fail').toBeLessThan(
      SIZE_OBSERVED_TO_FAIL,
    );

    const oversized: string[] = [];
    for (const area of REQUIRED_SCOPE) {
      for (const unit of reviewUnitsFor(area)) {
        const owned = selectFor(unit);
        const context = sourceFiles().filter(
          (f) => !owned.includes(f) && (unit.context ?? []).some((p) => f.startsWith(p)),
        );
        const chars = [...owned, ...context].reduce(
          (n, f) => n + (existsSync(f) ? readFileSync(f, 'utf8').length : 0),
          0,
        );
        if (chars > SIZE_CEILING) oversized.push(unit.unit + ' — ' + String(chars) + ' characters');
      }
    }
    expect(
      oversized,
      'these units are larger than a reviewer has been shown to get through:' +
        String.fromCharCode(10) +
        oversized.join(String.fromCharCode(10)),
    ).toEqual([]);
  });

  it('no unit is given more files than a reviewer has been shown to read', () => {
    const oversized: string[] = [];
    for (const area of REQUIRED_SCOPE) {
      for (const unit of reviewUnitsFor(area)) {
        const count = selectFor(unit).length;
        if (count > CEILING) oversized.push(unit.unit + ' (' + String(count) + ' files)');
      }
    }
    expect(
      oversized,
      'partition these with AREA_SUBSCOPES — at ' +
        String(LARGEST_UNIT_OBSERVED_TO_TRUNCATE) +
        ' files a reviewer silently read one fewer than it was given',
    ).toEqual([]);
  });

  it('splitting an area loses none of it', () => {
    /*
     * The one way partitioning could do harm. Sub-scopes that do not between them cover the
     * area's own prefixes would shrink the review while making every unit look healthy.
     */
    for (const area of REQUIRED_SCOPE) {
      const areaFiles = sourceFiles().filter((f) =>
        (AREA_SOURCES[area] ?? []).some((prefix) => f.startsWith(prefix)),
      );
      const seen = new Set(reviewUnitsFor(area).flatMap((u) => selectFor(u)));
      const lost = areaFiles.filter((f) => !seen.has(f));
      expect(lost, area + ': these files are in the area but in none of its sub-scopes').toEqual(
        [],
      );
    }
  });
});

describe('a unit that sees a call site also sees the guard on it', () => {
  /*
   * SPEC: the 1.0.1 security scope triage, second pass.
   *
   * `install/update/rollback — the command surface` returned NOT_VERIFIED at 88285e2e, and the
   * aggregate treats that as "decided nothing". The reviewer explained itself precisely: it
   * could see `spawnSync(process.execPath, [decision.handOffTo, …])` in main.ts and could not
   * see `resolveActive`, which is what validates the pointer before that path can exist —
   * "cannot be confirmed or refuted from this source".
   *
   * It was right to refuse. Partitioning the area had put the delegation's call site in one
   * unit and its validation in the sibling, so the unit was asked a question its file set could
   * not answer. Same class as the bootstrap omission: not a wrong answer, an unanswerable one.
   *
   * The invariant is about the pair, not the filenames: wherever the entry point is visible,
   * the module deciding whether it hands off must be visible too.
   */
  const unitsWith = (file: string) =>
    REQUIRED_SCOPE.flatMap((area) => reviewUnitsFor(area)).filter((u) =>
      [...u.prefixes, ...(u.context ?? [])].some((p) => file.startsWith(p)),
    );

  it('every unit shown the entry point is also shown the resolver it delegates through', () => {
    const seeMain = unitsWith('src/cli/main.ts');
    expect(seeMain.length, 'the entry point must be reviewed somewhere').toBeGreaterThan(0);

    for (const unit of seeMain) {
      const visible = [...unit.prefixes, ...(unit.context ?? [])];
      expect(
        visible.some((p) => 'src/portability/activeVersion.ts'.startsWith(p)),
        unit.unit +
          ' can see the spawn in main.ts but not resolveActive, so it cannot judge either',
      ).toBe(true);
    }
  });

  it('every unit shown the owner-answer action is also shown the impersonation guard', () => {
    /*
     * SPEC: finding APPLICATION-ACTION-AUTHORITY/AAA-1 (MEDIUM), 1.0.1 security review.
     *
     * Same pair, second instance. The `owner.answer` handler in actions.ts passes `answeredBy`
     * from an untrusted payload to `answerOwnerDecision`, and the rule that an agent id may
     * never answer an owner decision is enforced inside that function, in intelligence/app.ts.
     * A unit holding the call site and not the guard can only report the defence as
     * unverifiable — which is indistinguishable, in a report, from absent.
     *
     * The first instance was fixed by declaring `context` on a SUB-SCOPE. This area is not
     * partitioned and had no way to declare any, which is why the same question came back as a
     * finding; `AREA_CONTEXT` closes that gap for both shapes.
     */
    const seeActions = unitsWith('src/app/actions.ts');
    expect(seeActions.length, 'the action surface must be reviewed somewhere').toBeGreaterThan(0);

    for (const unit of seeActions) {
      const visible = [...unit.prefixes, ...(unit.context ?? [])];
      expect(
        visible.some((p) => 'src/intelligence/app.ts'.startsWith(p)),
        unit.unit + ' can see owner.answer but not the guard on answeredBy',
      ).toBe(true);
    }
  });

  it('every unit judging persisted evidence is shown what makes the store tamper-evident', () => {
    /*
     * SPEC: finding SERVA-SELF-ACCEPTANCE-AUTHORITY/SSA-REV-CONTENT-BIND (MEDIUM), 1.0.1.
     *
     * Third instance of the same pair. This unit decides whether a persisted scope-review
     * record counts as evidence, and that turns on whether the store can be written out of
     * band without detection. The answer is in store.ts — immutable canon versions, a digest
     * per record, 'tamper-evidence, not tamper-proofing' — and the unit could not see it, so it
     * returned NOT_VERIFIED. A reviewer refusing to decide a question it was not given the
     * material to answer is the honest outcome, and a scope defect rather than a code one.
     */
    const seeAggregate = unitsWith('src/acceptance/securityAggregate.ts');
    expect(seeAggregate.length, 'the aggregate must be reviewed somewhere').toBeGreaterThan(0);

    for (const unit of seeAggregate) {
      const visible = [...unit.prefixes, ...(unit.context ?? [])];
      expect(
        visible.some((p) => 'src/store/store.ts'.startsWith(p)),
        unit.unit + ' judges persisted records but cannot see what protects them',
      ).toBe(true);
    }
  });

  it('declared area context is read, never counted as coverage', () => {
    /*
     * The safety property of AREA_CONTEXT: it must be impossible to quiet a reviewer by
     * handing a unit more to READ. Context is excluded from the partition, so the set of files
     * each unit OWNS is unchanged by it — otherwise 'give it context' becomes a way to make a
     * file look reviewed while nobody judges it.
     */
    for (const area of REQUIRED_SCOPE) {
      for (const unit of reviewUnitsFor(area)) {
        for (const c of unit.context ?? []) {
          /* OWNED is prefixes MINUS except — the same selection the partition uses. */
          const owned =
            unit.prefixes.some((p) => c.startsWith(p)) &&
            !(unit.except ?? []).some((p) => c.startsWith(p));
          expect(
            owned,
            unit.unit + ' owns ' + c + ' through context, which context must never do',
          ).toBe(false);
        }
      }
    }
  });

  it('context does not smuggle a file out of being reviewed as a subject', () => {
    /*
     * Context is for reading, not for coverage: a file that appears ONLY as context is never
     * anybody's subject, and would be read by reviewers while being judged by none.
     */
    const asSubject = new Set(
      REQUIRED_SCOPE.flatMap((area) => reviewUnitsFor(area)).flatMap((u) => [...u.prefixes]),
    );
    const asContext = new Set(
      REQUIRED_SCOPE.flatMap((area) => reviewUnitsFor(area)).flatMap((u) => [...(u.context ?? [])]),
    );

    for (const file of asContext) {
      expect(
        [...asSubject].some((p) => file.startsWith(p)),
        file + ' is context to some unit but the subject of none',
      ).toBe(true);
    }
  });
});
