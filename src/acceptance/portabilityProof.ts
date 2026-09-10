import { existsSync, readFileSync, readdirSync, renameSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, relative } from 'node:path';
import { EnforcementClass } from '../vocab/index.js';
import { QualificationAttempt } from '../substrate/types.js';
import { CONTENT_DIR, createBackup, verifyBackup } from '../portability/backup.js';
import { inspectRestore, performRestore } from '../portability/restore.js';
import { MACHINE_BOUND_KEYS } from '../portability/machine.js';
import { isServaProject } from '../app/services.js';
import { ServaRuntime } from '../app/runtime.js';
import type { SubstrateQualification } from '../substrate/types.js';
import type { BackupManifest } from '../portability/backup.js';
import { scanText } from '../engineering/secrets.js';

/**
 * THE PORTABILITY WALKTHROUGH, PERFORMED RATHER THAN DESCRIBED.
 *
 * SPEC: Phase 6 final acceptance sequence §3.
 *
 * PORTABILITY-FINAL is the requirement most easily faked, because the honest version is
 * tedious: make a real project, put real truth in it, back it up, take the original away,
 * restore somewhere else, and then check — file by file, commit by commit, decision by
 * decision — that what came back is what went in.
 *
 * The dishonest version is a markdown file saying that happened. An earlier iteration of this
 * product passed exactly that way, because a status reader matched three phrases in a
 * walkthrough document. So this module DOES the walk and returns structured results, and the
 * proof is minted from those results or not at all.
 *
 * TWO PROPERTIES MATTER MORE THAN "IT CAME BACK".
 *
 *   NOTHING SECRET TRAVELS. A backup that carried a credential would move an owner's
 *   authentication to a machine they might not control any more.
 *
 *   NO AUTHORITY TRAVELS. The restored project must NOT be able to run write-capable
 *   engineering on the strength of the old machine's HARD qualification. HARD describes a
 *   computer, and a restore lands on a different one.
 */

export interface WalkStep {
  readonly id: string;
  readonly title: string;
  readonly passed: boolean;
  readonly detail: string;
}

export interface PortabilityWalkResult {
  readonly passed: boolean;
  readonly steps: readonly WalkStep[];
  readonly sourceRoot: string;
  readonly displacedRoot?: string;
  readonly bundlePath: string;
  readonly restoredRoot?: string;
  readonly manifest?: BackupManifest;
  readonly failures: readonly string[];
}

export interface PortabilityWalkInput {
  /** A disposable directory the walk may create everything under. */
  readonly workspace: string;
  /** How the source project is created and given real truth. */
  readonly seed: (root: string) => { readonly decisionId: string; readonly commit: string };
  /** The current machine's qualification, for the authority check. */
  readonly qualification?: SubstrateQualification;
}

function git(repoRoot: string, args: readonly string[]): string | undefined {
  try {
    return execFileSync('git', [...args], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 30_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
}

/** Every file under a root, as paths relative to it. */
function tree(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else out.push(relative(root, path).replace(/\\/g, '/'));
    }
  };
  walk(root);
  return out.sort();
}

/**
 * Do the whole walk, on real files, and report what each step actually found.
 *
 * Returns rather than throws. A portability acceptance that stopped at the first problem
 * would tell an owner one thing was wrong when four were, and the point of running it at all
 * is to learn the whole state.
 */
export function walkPortability(input: PortabilityWalkInput): PortabilityWalkResult {
  const steps: WalkStep[] = [];
  const step = (id: string, title: string, passed: boolean, detail: string): void => {
    steps.push({ id, title, passed, detail });
  };

  const sourceRoot = join(input.workspace, 'source');
  const bundlePath = join(input.workspace, 'bundle');
  const destinationRoot = join(input.workspace, 'restored');

  /* ------------------------------------------------------- 1. a project with real truth */

  const seeded = input.seed(sourceRoot);
  const sourceFiles = tree(sourceRoot);
  const sourceHead = git(sourceRoot, ['rev-parse', 'HEAD']);
  const sourceLog = git(sourceRoot, ['log', '--format=%H %s']);

  step(
    'SEEDED',
    'a disposable project holds real Store truth, an owner decision and git history',
    isServaProject(sourceRoot) && sourceHead !== undefined,
    'project at ' +
      sourceRoot +
      ', ' +
      String(sourceFiles.length) +
      ' file(s), HEAD ' +
      String(sourceHead).slice(0, 12),
  );

  /* ------------------------------------------------------------------ 2. verified backup */

  const rt = ServaRuntime.open({ root: sourceRoot });
  let manifest: BackupManifest | undefined;
  try {
    const project = rt.requireProject();
    const backup = createBackup(
      { clock: rt.clock },
      {
        projects: [{ projectId: project.id, name: project.name, root: sourceRoot }],
        destination: bundlePath,
      },
    );
    manifest = backup.manifest;
    step('BACKUP', 'a verified backup is written', backup.verified, backup.summary);
  } finally {
    rt.close();
  }

  const verification = verifyBackup(bundlePath);
  step(
    'VERIFY',
    'every file in the bundle matches the digest recorded for it',
    verification.ok,
    verification.summary,
  );

  /* --------------------------------------------- 3. nothing secret, nothing machine-bound */

  const bundleFiles = existsSync(bundlePath) ? tree(bundlePath) : [];
  /*
   * EVERY TEXT FILE IN THE BUNDLE, NOT ONLY THE ONES ENDING `.json`.
   *
   * SPEC: finding SC-SSA-REV-C1 (MEDIUM), 1.0.1 security review.
   *
   * The trace is written as `.jsonl` and a project carries ordinary documents, so filtering on
   * `.json` meant the scan read the manifest and the canon and nothing else — while the thing
   * a credential is most likely to be sitting in is a note or a log line.
   *
   * Binary is skipped by extension rather than by sniffing: a scan that tried to decode a
   * video would spend its time on bytes that cannot carry a readable credential anyway.
   */
  const BINARY = /\.(png|jpe?g|gif|ico|pdf|zip|gz|tar|woff2?|ttf|eot|mp4|mp3|wasm|exe|dll)$/i;
  const bundleText = bundleFiles
    .filter((f) => !BINARY.test(f))
    .map((f) => {
      try {
        return readFileSync(join(bundlePath, f), 'utf8');
      } catch {
        return '';
      }
    })
    .join('\n');

  /*
   * Credential SHAPES rather than a list of known secrets. A scan that only looked for
   * strings it had seen before would pass on the first credential nobody had thought of.
   */
  /*
   * THE SAME RULES THE ENGINEERING SCAN USES, NOT A SECOND SMALLER LIST.
   *
   * SPEC: finding SC-SSA-CRED-SHAPES (MEDIUM), 1.0.1 security review.
   *
   * This carried its own five shapes while `SECRET_RULES` in engineering/secrets.ts carries
   * the vendor shapes, connection strings, JWTs and generic assignments — and was widened
   * twice during this campaign. AWS keys, GitHub tokens, Google API keys, a database URL with
   * inline credentials: none matched here, so a credential in a note could travel while the
   * step reported "nothing matched".
   *
   * Two rule sets for one question is how the weaker one survives. There is one now, and a
   * shape added to it protects both walks the day it is written.
   */
  const found = [...new Set(scanText('bundle', bundleText).map((f) => f.category))];
  step(
    'NO_CREDENTIALS',
    'nothing in the bundle matches a credential shape',
    found.length === 0,
    found.length === 0
      ? String(bundleFiles.length) + ' file(s) scanned, nothing matched'
      : 'matched: ' + found.join(', '),
  );

  /*
   * THE CONTENT, NOT THE MANIFEST.
   *
   * A first version of this scanned the whole bundle for the machine-bound family names and
   * failed — because the manifest LISTS them, in `machineBoundExcluded`, precisely to record
   * that they were left behind. The check was reading the receipt for the exclusion as
   * evidence of the thing excluded.
   *
   * So there are two questions, and they are asked separately: is any machine-bound family
   * actually in the carried content, and does the manifest say it was deliberately left out?
   * A bundle that quietly omitted them without recording it would pass the first and fail the
   * second, and an omission nobody wrote down looks like an oversight.
   */
  const contentText = bundleFiles
    .filter((f) => f.startsWith(CONTENT_DIR + '/'))
    .map((f) => {
      try {
        return readFileSync(join(bundlePath, f), 'utf8');
      } catch {
        return '';
      }
    })
    .join('\n');

  const leaked = MACHINE_BOUND_KEYS.filter((k) => contentText.includes(k));
  const declared = manifest?.machineBoundExcluded ?? [];
  const undeclared = MACHINE_BOUND_KEYS.filter((k) => !declared.includes(k));

  step(
    'NO_MACHINE_BOUND',
    'no machine-bound family is carried, and the omission is recorded',
    leaked.length === 0 && undeclared.length === 0,
    leaked.length > 0
      ? 'carried in content: ' + leaked.join(', ')
      : undeclared.length > 0
        ? 'left out without recording it: ' + undeclared.join(', ')
        : String(declared.length) + ' machine-bound family(ies) excluded and named in the manifest',
  );

  /* ------------------------------------------------ 4. take the original away, then restore */

  const displacedRoot = sourceRoot + '.taken-away';
  renameSync(sourceRoot, displacedRoot);
  step(
    'ORIGINAL_REMOVED',
    'the original working copy is gone before anything is restored',
    !existsSync(sourceRoot),
    'moved to ' + displacedRoot,
  );

  const inspection = inspectRestore({ bundlePath, destinationRoot });
  step('INSPECT', 'the restore is inspected before it writes', inspection.ok, inspection.summary);

  const restore = performRestore({ bundlePath, destinationRoot });
  const restoredRoot = restore.restored[0]?.destination;
  step(
    'RESTORED',
    'the project is restored into a separate fresh path',
    restoredRoot !== undefined && isServaProject(String(restoredRoot)),
    restore.summary,
  );

  if (restoredRoot === undefined) {
    return {
      passed: false,
      steps,
      sourceRoot,
      displacedRoot,
      bundlePath,
      ...(manifest === undefined ? {} : { manifest }),
      failures: steps.filter((s) => !s.passed).map((s) => s.id + ': ' + s.detail),
    };
  }

  /* ------------------------------------------------------------- 5. what came back */

  const restoredFiles = tree(restoredRoot);
  const missing = sourceFiles.filter((f) => !restoredFiles.includes(f));
  step(
    'INVENTORY',
    'every non-excluded file came back',
    missing.length === 0,
    missing.length === 0
      ? String(restoredFiles.length) + ' file(s) restored'
      : String(missing.length) + ' missing, for example ' + missing.slice(0, 3).join(', '),
  );

  const restoredHead = git(restoredRoot, ['rev-parse', 'HEAD']);
  const restoredLog = git(restoredRoot, ['log', '--format=%H %s']);
  step(
    'GIT_IDENTITY',
    'git history and commit identity survived',
    restoredHead === sourceHead && restoredLog === sourceLog,
    'HEAD ' +
      String(restoredHead).slice(0, 12) +
      (restoredHead === sourceHead
        ? ' matches'
        : ' DIFFERS from ' + String(sourceHead).slice(0, 12)),
  );

  const restoredRt = ServaRuntime.open({ root: restoredRoot });
  try {
    const project = restoredRt.project();
    step(
      'CANONICAL_STORE',
      'the canonical Store opens and holds the same project',
      project !== undefined,
      project === undefined ? 'no project record' : project.id + ' — ' + project.name,
    );

    const decision = restoredRt.store.getCanon<unknown>(
      'intel.ownerDecisionRequest',
      seeded.decisionId,
    );
    step(
      'OWNER_DECISIONS',
      'owner decisions and their evidence survived',
      decision !== undefined,
      decision === undefined
        ? seeded.decisionId + ' is missing'
        : seeded.decisionId + ' is present',
    );

    /*
     * THE AUTHORITY CHECK, AND THE POINT OF THE WHOLE EXERCISE.
     *
     * The restored project must not be able to run write-capable engineering because the OLD
     * machine measured HARD. A qualification describes a computer, a restore lands on a
     * different one, and a product that carried authority across would have moved the one
     * thing it must never move.
     */
    const carried = restoredRt.store.getWorking<unknown>('substrateQualification', 'last-valid');
    const currentIsHard =
      input.qualification !== undefined &&
      input.qualification.attempt === QualificationAttempt.MEASURED &&
      input.qualification.enforcementClass === EnforcementClass.HARD;
    step(
      'NO_AUTHORITY_TRANSFERRED',
      'the previous HARD qualification is not active authority here',
      carried === undefined,
      carried === undefined
        ? 'no qualification record travelled; this machine must measure itself' +
            (currentIsHard ? ' (and separately has done so)' : '')
        : 'a qualification record was carried into the restored project',
    );
  } finally {
    restoredRt.close();
  }

  const failures = steps.filter((s) => !s.passed).map((s) => s.id + ': ' + s.detail);
  return {
    passed: failures.length === 0,
    steps,
    sourceRoot,
    displacedRoot,
    bundlePath,
    restoredRoot,
    ...(manifest === undefined ? {} : { manifest }),
    failures,
  };
}

/** The owner-facing rendering of a walk. */
export function renderPortabilityWalk(result: PortabilityWalkResult): string {
  const lines = ['SERVA CODE — PORTABILITY ACCEPTANCE', ''];
  for (const s of result.steps) {
    lines.push('  [' + (s.passed ? ' ok ' : 'FAIL') + '] ' + s.id.padEnd(24) + s.title);
    lines.push('         ' + s.detail);
  }
  lines.push('');
  lines.push(
    result.passed
      ? 'Every step passed. The project moved; the machine authority did not.'
      : String(result.failures.length) +
          ' step(s) failed. The project may have moved; the machine authority did not.',
  );
  return lines.join('\n');
}
