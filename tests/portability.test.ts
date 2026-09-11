import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Store } from '../src/store/store.js';
import { FixedClock } from '../src/core/clock.js';
import { SequentialIdSource } from '../src/core/ids.js';
import { ARTIFACT_TYPES, repository } from '../src/intelligence/repository.js';
import { ProjectGoalSchema } from '../src/intelligence/artifacts/framing.js';
import { OwnerDecisionRequestSchema } from '../src/intelligence/artifacts/governance.js';
import {
  CONTENT_DIR,
  MANIFEST_NAME,
  createBackup,
  credentialScan,
  isExcluded,
  manifestDigest,
  safeBundlePath,
  verifyBackup,
} from '../src/portability/backup.js';
import { RestoreConflict, inspectRestore, performRestore } from '../src/portability/restore.js';
import {
  MIGRATION_STEPS,
  MigrationOutcome,
  migrationNeedsOwner,
  planMigration,
} from '../src/portability/migration.js';
import {
  BACKUP_FORMAT_VERSION,
  backupCompatibility,
  VersionCompatibility,
} from '../src/portability/version.js';
import {
  MACHINE_QUALIFICATION_TYPE,
  isMachineBound,
  MachineQualificationState,
  MachineQualificationSchema,
  machineIdentity,
  qualificationRefusal,
  unqualified,
} from '../src/portability/machine.js';
import { CheckState, machineDoctor, renderDoctor } from '../src/portability/doctor.js';
import { cleanup, tempRoot } from './helpers.js';
import type { DoctorProbes } from '../src/portability/doctor.js';

/**
 * PORTABILITY — THE FEATURE THAT DECIDES WHETHER SERVA IS SOMETHING YOU CAN RELY ON.
 *
 * Everything Serva knows lives on one machine. The day the disk dies, the company dies
 * with it unless this works — and "mostly works" is not a property a backup can have,
 * because nobody can tell you which part is missing.
 *
 * These tests use REAL disposable stores on the REAL filesystem. A backup proved with
 * in-memory objects proves the objects, and the failures that matter — a truncated write,
 * a path that escapes, a credential that travelled — all live on disk.
 */

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) cleanup(r);
});

function tmp(): string {
  const r = tempRoot();
  roots.push(r);
  return r;
}

const clock = (): FixedClock => new FixedClock();

/** A project with real canon in it: a goal, an owner decision, a source file, a git dir. */
function seedProject(
  o: { readonly withCredential?: boolean; readonly withSymlink?: boolean } = {},
): {
  root: string;
  goalId: string;
  decisionId: string;
} {
  const root = tmp();
  const c = clock();
  const ids = new SequentialIdSource();
  const store = Store.initialize(root, { clock: c, ids, actor: 'PORTABILITY_TEST' });

  const at = c.now();
  const goalId = ids.next('SC-GOAL');
  const decisionId = ids.next('SC-ODR');
  const tx = store.begin();
  repository(store, ARTIFACT_TYPES.PROJECT_GOAL, ProjectGoalSchema).put(tx, {
    id: goalId,
    createdAt: at,
    statement: 'Stop losing phone orders during the morning rush',
    successIndicator: 'no order lost over two weeks',
    priority: 'MUST',
    meta: { provenance: { marking: 'OWNER_STATED', statedAt: at }, attribution: { at } },
  } as never);
  repository(store, ARTIFACT_TYPES.OWNER_DECISION_REQUEST, OwnerDecisionRequestSchema).put(tx, {
    id: decisionId,
    createdAt: at,
    question: 'Should merchants set their own cancellation policy?',
    whyServaCannotDecide: 'it is a commercial policy, not a technical choice',
    purpose: 'BUSINESS_RULE',
    options: [
      { option: 'One platform-wide policy', impact: 'simpler', disposition: 'INFORM' },
      { option: 'Per-merchant policy', impact: 'flexible', disposition: 'INFORM' },
    ],
    recommendation: 'One platform-wide policy',
    recommendationRationale: 'nothing yet suggests merchants differ',
    blocksWork: true,
    blockedRefs: [],
    state: 'ANSWERED',
    chosenOption: 'One platform-wide policy',
    answeredBy: 'owner',
    answeredAt: at,
    meta: { provenance: { marking: 'SYSTEM', component: 'test' }, attribution: { at } },
  } as never);
  tx.commit();

  /* Real project files, including the git history a restore has to bring back. */
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'index.ts'), 'export const answer = 42;\n', 'utf8');
  mkdirSync(join(root, '.git', 'refs', 'heads'), { recursive: true });
  writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
  writeFileSync(join(root, '.git', 'refs', 'heads', 'main'), 'a'.repeat(40) + '\n', 'utf8');

  /* Things that must never travel. */
  mkdirSync(join(root, 'node_modules', 'left-pad'), { recursive: true });
  writeFileSync(join(root, 'node_modules', 'left-pad', 'index.js'), 'module.exports=1\n', 'utf8');
  writeFileSync(join(root, '.env'), 'DATABASE_URL=postgres://localhost/app\n', 'utf8');
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(join(root, '.claude', 'session.json'), '{"token":"private"}', 'utf8');

  /* A machine-bound record, as a qualified machine would have written one. */
  const qtx = store.begin();
  qtx.putCanon(
    MACHINE_QUALIFICATION_TYPE,
    'MACHINE-1',
    MachineQualificationSchema.parse({
      machineId: 'MACHINE-1',
      identity: {
        platform: 'win32',
        release: '10.0.26200',
        architecture: 'x64',
        nodeVersion: 'v20.11.0',
      },
      fingerprint: machineIdentity({
        platform: 'win32',
        release: '10.0.26200',
        architecture: 'x64',
        nodeVersion: 'v20.11.0',
      }).fingerprint,
      state: MachineQualificationState.HARD,
      qualifiedAt: at,
      cases: [{ id: 'Q-A', passed: true, detail: 'measured' }],
      reason: 'measured on this machine',
    }),
  );
  qtx.commit();

  if (o.withCredential === true) {
    writeFileSync(
      join(root, 'src', 'notes.md'),
      'Reminder, the key is sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n',
      'utf8',
    );
  }
  if (o.withSymlink === true) {
    try {
      symlinkSync(join(root, '.claude'), join(root, 'src', 'link-to-secrets'), 'junction');
    } catch {
      /* Symlink creation needs privilege on Windows; the test below tolerates absence. */
    }
  }

  return { root, goalId, decisionId };
}

/* ================================================================= backup format */

describe('a backup is a verified, bounded, credential-free bundle', () => {
  it('captures project truth and git identity, and verifies itself', () => {
    const { root, goalId } = seedProject();
    const destination = join(tmp(), 'bundle');

    const result = createBackup(
      { clock: clock() },
      { projects: [{ projectId: 'PRJ-1', name: 'RahalGo', root }], destination },
    );

    expect(result.verified).toBe(true);
    expect(existsSync(join(destination, MANIFEST_NAME))).toBe(true);
    expect(result.manifest.formatVersion).toBe(BACKUP_FORMAT_VERSION);

    /* The canon is there, by path, not by claim. */
    const paths = result.manifest.inventory.map((e) => e.path);
    expect(paths.some((p) => p.includes(goalId))).toBe(true);
    expect(paths.some((p) => p.endsWith('src/index.ts'))).toBe(true);

    /* Git identity is READ from the repository rather than asserted. */
    const project = result.manifest.projects[0];
    expect(project?.git.present).toBe(true);
    expect(project?.git.branch).toBe('main');
    expect(project?.git.head).toBe('a'.repeat(40));

    /* And the bundle proves itself on re-open. */
    expect(verifyBackup(destination).ok).toBe(true);
  });

  it('excludes credentials, regenerable trees and machine-bound truth, and says so', () => {
    const { root } = seedProject();
    const destination = join(tmp(), 'bundle');
    const result = createBackup(
      { clock: clock() },
      { projects: [{ projectId: 'PRJ-1', name: 'RahalGo', root }], destination },
    );

    const paths = result.manifest.inventory.map((e) => e.path);
    expect(paths.some((p) => p.includes('node_modules'))).toBe(false);
    expect(paths.some((p) => p.endsWith('.env'))).toBe(false);
    expect(paths.some((p) => p.includes('.claude'))).toBe(false);

    /* An omission nobody recorded is indistinguishable from an oversight. */
    const excludedPaths = result.manifest.excluded.map((e) => e.path);
    expect(excludedPaths).toContain('node_modules');
    expect(excludedPaths).toContain('.env');
    expect(excludedPaths).toContain('.claude');
    expect(result.manifest.machineBoundExcluded).toContain(MACHINE_QUALIFICATION_TYPE);

    /* Nothing anywhere in the bundle looks like a credential. */
    for (const e of result.manifest.inventory) {
      const content = readFileSync(join(destination, CONTENT_DIR, ...e.path.split('/')), 'utf8');
      expect(credentialScan(content), e.path).toEqual([]);
    }
  });

  it('refuses a file whose CONTENT carries a key, not only one whose name does', () => {
    const { root } = seedProject({ withCredential: true });
    const destination = join(tmp(), 'bundle');
    const result = createBackup(
      { clock: clock() },
      { projects: [{ projectId: 'PRJ-1', name: 'RahalGo', root }], destination },
    );

    /* A deny-list of filenames catches `.env`; it does not catch a key pasted into a note. */
    expect(result.manifest.inventory.some((e) => e.path.endsWith('notes.md'))).toBe(false);
    const note = result.manifest.excluded.find((e) => e.path.endsWith('notes.md'));
    expect(note?.reason).toBe('SENSITIVE');
    expect(note?.detail).toContain('Anthropic API key');
  });

  it('does not follow a symbolic link out of the project', () => {
    const { root } = seedProject({ withSymlink: true });
    const linkExists = existsSync(join(root, 'src', 'link-to-secrets'));
    const destination = join(tmp(), 'bundle');
    const result = createBackup(
      { clock: clock() },
      { projects: [{ projectId: 'PRJ-1', name: 'RahalGo', root }], destination },
    );
    /* Whether or not this platform let the link be created, nothing followed it. */
    expect(result.manifest.inventory.some((e) => e.path.includes('link-to-secrets'))).toBe(false);
    if (linkExists) {
      expect(result.manifest.excluded.some((e) => e.path.includes('link-to-secrets'))).toBe(true);
    }
  });

  it('refuses to overwrite an existing bundle, and leaves nothing behind on failure', () => {
    const { root } = seedProject();
    const destination = join(tmp(), 'bundle');
    createBackup(
      { clock: clock() },
      { projects: [{ projectId: 'PRJ-1', name: 'RahalGo', root }], destination },
    );
    expect(() =>
      createBackup(
        { clock: clock() },
        { projects: [{ projectId: 'PRJ-1', name: 'RahalGo', root }], destination },
      ),
    ).toThrow(/already exists/);
    expect(existsSync(destination + '.partial')).toBe(false);
  });

  it('refuses a directory that is not a Serva project', () => {
    const notAProject = tmp();
    writeFileSync(join(notAProject, 'readme.md'), 'hello\n', 'utf8');
    expect(() =>
      createBackup(
        { clock: clock() },
        {
          projects: [{ projectId: 'PRJ-1', name: 'X', root: notAProject }],
          destination: join(tmp(), 'bundle'),
        },
      ),
    ).toThrow(/not a Serva project/);
  });
});

/* ============================================================ backup verification */

describe('a corrupt or tampered backup is refused, not repaired', () => {
  function goodBundle(): string {
    const { root } = seedProject();
    const destination = join(tmp(), 'bundle');
    createBackup(
      { clock: clock() },
      { projects: [{ projectId: 'PRJ-1', name: 'RahalGo', root }], destination },
    );
    return destination;
  }

  it('a truncated file fails its digest and the bundle is refused', () => {
    const bundle = goodBundle();
    const manifest = JSON.parse(readFileSync(join(bundle, MANIFEST_NAME), 'utf8')) as {
      inventory: { path: string }[];
    };
    const victim = manifest.inventory.find((e) => e.path.endsWith('src/index.ts'));
    writeFileSync(join(bundle, CONTENT_DIR, ...String(victim?.path).split('/')), 'trunc', 'utf8');

    const result = verifyBackup(bundle);
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toMatch(/bytes|digest/);
  });

  it('a tampered manifest fails its own integrity digest', () => {
    const bundle = goodBundle();
    const manifest = JSON.parse(readFileSync(join(bundle, MANIFEST_NAME), 'utf8')) as Record<
      string,
      unknown
    >;
    manifest['servaVersion'] = '9.9.9';
    writeFileSync(join(bundle, MANIFEST_NAME), JSON.stringify(manifest), 'utf8');

    const result = verifyBackup(bundle);
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toContain('integrity digest');
  });

  it('a bundle bigger than this build will read is refused before it is walked', () => {
    /*
     * SPEC: finding RELEASE-HANDOVER/RELH-F1 (MEDIUM), 1.0.1 security review.
     *
     * BACKUP_LIMITS bound the WRITING side only - a project this machine already holds, where
     * the totals are whatever they are. The header promised a bundle arriving from elsewhere is
     * treated as hostile and its totals capped, and the reading side capped nothing: the schema
     * puts no maximum on `inventory`, so a crafted manifest was walked in full by verify and
     * then again by restore.
     *
     * Tiny limits rather than a 200,000-entry fixture, because the property under test is that
     * the declared totals are checked at all, and a test that had to build the real limit would
     * be paying the cost the fix exists to refuse.
     */
    const bundle = goodBundle();
    const tiny = { maxEntries: 1, maxTotalBytes: 8 * 1024 * 1024 * 1024, maxFileBytes: 512 };

    const result = verifyBackup(bundle, tiny);

    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toMatch(/entries, over the/);
    expect(result.summary).toContain('larger than this build will read');
  });

  it('refuses a manifest whose declared bytes exceed the total, and one oversized file', () => {
    const bundle = goodBundle();
    const byTotal = verifyBackup(bundle, {
      maxEntries: 200_000,
      maxTotalBytes: 1,
      maxFileBytes: 512 * 1024 * 1024,
    });
    expect(byTotal.problems.join(' ')).toMatch(/bytes, over the/);

    const byFile = verifyBackup(bundle, {
      maxEntries: 200_000,
      maxTotalBytes: 8 * 1024 * 1024 * 1024,
      maxFileBytes: 1,
    });
    expect(byFile.problems.join(' ')).toMatch(/per-file limit/);
  });

  it('a bundle within the limits still verifies, so the cap is a bound and not a wall', () => {
    expect(verifyBackup(goodBundle()).ok).toBe(true);
  });

  it('catches the credential shapes the engineering scanner knows, not a private five', () => {
    /*
     * SPEC: finding RELH-REV-M1 (MEDIUM), 1.0.1 security review.
     *
     * The third instance of one class in this campaign, after SC-SSA-CRED-SHAPES in
     * portabilityProof.ts: a module carrying its own credential list beside SECRET_RULES. Two
     * rule sets for one question is how the weaker one survives, and this is the list guarding
     * the bundle the header says 'gets copied to a USB stick and emailed'.
     *
     * None of these matched the local five: a database URL with inline credentials, a Google
     * API key, a Slack token, a JWT, a password assignment. All of them are shapes the shared
     * rules already knew.
     */
    for (const sample of [
      'DATABASE_URL=postgres://admin:hunter2@db.internal:5432/app',
      'GOOGLE_KEY=AIza' + 'SyD3k7Qw9tR5mB2xCdE4fG6hJ8kL0nP2qRs',
      'token: xoxb-' + '2846117248-2847283746-' + 'A9bC3dE5fG7hJ1kL2mN4pQ6r',
      'password = "s3cr3t-Pa55phrase-value"',
    ]) {
      expect(credentialScan(sample), sample.slice(0, 24)).not.toHaveLength(0);
    }
  });

  it('excludes every dotenv variant, not the three that were listed', () => {
    /*
     * `.env.development`, `.env.test`, `.env.staging` and a nested `config/.env` were none of
     * them `.env`, `.env.local` or `.env.production`, so each was copied verbatim.
     */
    for (const name of ['.env', '.env.local', '.env.production', '.env.development', '.env.test']) {
      expect(isExcluded(name), name).toBeDefined();
    }
    /* A file that merely starts with the letters is not a dotenv file. */
    expect(isExcluded('.environment-notes.md')).toBeUndefined();
  });

  it('a file added to the bundle that the manifest never listed is reported', () => {
    const bundle = goodBundle();
    writeFileSync(join(bundle, CONTENT_DIR, 'smuggled.txt'), 'extra\n', 'utf8');
    const result = verifyBackup(bundle);
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toContain('smuggled.txt');
  });

  it('a missing file is reported rather than skipped', () => {
    const bundle = goodBundle();
    const manifest = JSON.parse(readFileSync(join(bundle, MANIFEST_NAME), 'utf8')) as {
      inventory: { path: string }[];
    };
    const victim = String(manifest.inventory[0]?.path);
    const { rmSync } = require('node:fs') as typeof import('node:fs');
    rmSync(join(bundle, CONTENT_DIR, ...victim.split('/')));
    const result = verifyBackup(bundle);
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toContain('missing from the bundle');
  });

  it('a crafted detached HEAD does not reach the manifest verbatim', () => {
    /*
     * SPEC: finding RELEASE-HANDOVER/RELH-REVIEW-1 (MEDIUM), 1.0.1 security review.
     *
     * `.git/HEAD` is file content, so it is input. The `ref:` arm of that read was hardened for
     * BACKUP-RESTORE-F1 and its commit id checked against a shape; the DETACHED arm returned
     * the raw contents into the manifest unchecked — a field the credential scan never sees,
     * because that scan runs over copied content only. The guard went into one arm of the same
     * `if` and not the other.
     */
    const { root } = seedProject();
    writeFileSync(
      join(root, '.git', 'HEAD'),
      'sk-ant-api03-' + 'K7mQ2wX9tLpV4nB6cYzR8dHs' + String.fromCharCode(10),
      'utf8',
    );

    const destination = join(tmp(), 'bundle-head');
    createBackup(
      { clock: clock() },
      { projects: [{ projectId: 'PRJ-1', name: 'RahalGo', root }], destination },
    );

    const manifest = readFileSync(join(destination, MANIFEST_NAME), 'utf8');
    expect(manifest, 'raw HEAD content must not reach the manifest').not.toContain(
      'K7mQ2wX9tLpV4nB6cYzR8dHs',
    );
  });

  it('a credential hidden in an innocently-named file is refused on the way IN', () => {
    /*
     * SPEC: finding RELEASE-HANDOVER/RELH-1 (MEDIUM), 1.0.1 security review.
     *
     * Writing a backup scans file CONTENT. Verifying one checked the NAME against a deny-list
     * and nothing else, so 'no credential ever comes back' held only for bundles this machine
     * wrote. A bundle from elsewhere could carry a live key inside notes.txt, pass every
     * check, and be copied verbatim onto the owner's tree by performRestore.
     *
     * The bundle here is made CONSISTENT — content digest and manifest integrity digest both
     * recomputed — so nothing else can refuse it. Without a content scan this bundle verifies.
     */
    const bundle = goodBundle();
    const manifestPath = join(bundle, MANIFEST_NAME);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      inventory: { path: string; bytes: number; digest: string }[];
      totalBytes: number;
      integrityDigest?: string;
    };
    const victim = manifest.inventory.find((e) => e.path.endsWith('src/index.ts'));
    expect(victim, 'the fixture must contain the file this test rewrites').toBeDefined();

    const smuggled = 'notes\naws_access_key_id=AKIA' + 'Q7X4ZL2MN8VBCD3R' + '\n';
    const target = join(bundle, CONTENT_DIR, ...String(victim?.path).split('/'));
    writeFileSync(target, smuggled, 'utf8');

    const bytes = Buffer.byteLength(smuggled, 'utf8');
    const digest = createHash('sha256').update(readFileSync(target)).digest('hex');
    for (const entry of manifest.inventory) {
      if (entry.path === victim?.path) {
        entry.bytes = bytes;
        entry.digest = digest;
      }
    }
    manifest.totalBytes = manifest.inventory.reduce((n, e) => n + e.bytes, 0);
    delete manifest.integrityDigest;
    writeFileSync(
      manifestPath,
      JSON.stringify({ ...manifest, integrityDigest: manifestDigest(manifest as never) }),
      'utf8',
    );

    const result = verifyBackup(bundle);
    expect(result.ok, 'a consistent bundle carrying a live key must still be refused').toBe(false);
    expect(result.problems.join(' ')).toMatch(/no credential comes back/);
  });

  it('a directory with no manifest is not a Serva backup', () => {
    const result = verifyBackup(tmp());
    expect(result.ok).toBe(false);
    expect(result.summary).toContain('not a Serva backup');
  });
});

/* ================================================================ archive safety */

describe('a backup is input, and is treated as hostile', () => {
  it('refuses every shape of traversal path', () => {
    for (const hostile of [
      '../escape',
      '../../etc/passwd',
      '/absolute/path',
      'C:\\Windows\\System32',
      'a/../../b',
      '',
    ]) {
      expect(safeBundlePath(hostile), hostile).toBeUndefined();
    }
  });

  it('accepts only normalized, relative, forward-slashed paths', () => {
    expect(safeBundlePath('projects/PRJ-1/src/index.ts')).toBe('projects/PRJ-1/src/index.ts');
    expect(safeBundlePath('a/./b')).toBe('a/b');
  });

  it('a manifest naming a path outside the bundle is refused on restore', () => {
    const { root } = seedProject();
    const bundle = join(tmp(), 'bundle');
    createBackup(
      { clock: clock() },
      { projects: [{ projectId: 'PRJ-1', name: 'RahalGo', root }], destination: bundle },
    );

    const manifestPath = join(bundle, MANIFEST_NAME);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    const inventory = manifest['inventory'] as { path: string }[];
    inventory.push({ path: '../../../escaped.txt', bytes: 0, digest: 'x' } as never);
    const rest = { ...manifest };
    delete (rest as { integrityDigest?: string }).integrityDigest;
    writeFileSync(
      manifestPath,
      JSON.stringify({ ...rest, integrityDigest: manifestDigest(rest as never) }),
      'utf8',
    );

    /* The manifest is internally consistent and still refused: consistency is not safety. */
    const verification = verifyBackup(bundle);
    expect(verification.ok).toBe(false);
    expect(verification.problems.join(' ')).toContain('escapes the bundle');
  });

  it('recognises machine-bound store paths wherever they appear', () => {
    expect(isMachineBound('.serva/canon/' + MACHINE_QUALIFICATION_TYPE + '/MACHINE-1/1.json')).toBe(
      true,
    );
    expect(isMachineBound('.serva/canon/intel.projectGoal/SC-GOAL-1/1.json')).toBe(false);
    expect(isMachineBound('src/index.ts')).toBe(false);
  });
});

/* ======================================================================= restore */

describe('restore looks before it touches anything', () => {
  function bundleOf(): { bundle: string; goalId: string; decisionId: string } {
    const seeded = seedProject();
    const bundle = join(tmp(), 'bundle');
    createBackup(
      { clock: clock() },
      {
        projects: [{ projectId: 'PRJ-1', name: 'RahalGo', root: seeded.root }],
        destination: bundle,
      },
    );
    return { bundle, goalId: seeded.goalId, decisionId: seeded.decisionId };
  }

  it('inspection reports the plan and writes nothing', () => {
    const { bundle } = bundleOf();
    const destinationRoot = tmp();
    const inspection = inspectRestore({ bundlePath: bundle, destinationRoot });

    expect(inspection.ok).toBe(true);
    expect(inspection.projects[0]?.conflict).toBe(RestoreConflict.EMPTY);
    expect(inspection.projects[0]?.files).toBeGreaterThan(0);
    /* Told beforehand, not discovered afterwards. */
    expect(inspection.notRestored.join(' ')).toContain('UNQUALIFIED');
    expect(inspection.notRestored.join(' ')).toContain('Claude authentication');
    expect(readdirSync(destinationRoot)).toEqual([]);
  });

  it('restores project truth, git history and owner decisions to a new location', () => {
    const { bundle, goalId, decisionId } = bundleOf();
    const destinationRoot = tmp();
    const result = performRestore({ bundlePath: bundle, destinationRoot });

    expect(result.restored).toHaveLength(1);
    const restoredRoot = String(result.restored[0]?.destination);

    /* The Store reopens, and the canon is the same canon. */
    const reopened = Store.open(restoredRoot, {
      clock: clock(),
      ids: new SequentialIdSource(),
      actor: 'RESTORE_TEST',
    });
    const goals = repository(reopened, ARTIFACT_TYPES.PROJECT_GOAL, ProjectGoalSchema).list();
    expect(goals.map((g) => g.id)).toContain(goalId);
    const decisions = repository(
      reopened,
      ARTIFACT_TYPES.OWNER_DECISION_REQUEST,
      OwnerDecisionRequestSchema,
    ).list();
    expect(decisions.find((d) => d.id === decisionId)?.chosenOption).toBe(
      'One platform-wide policy',
    );

    /* Git identity survives. */
    expect(readFileSync(join(restoredRoot, '.git', 'HEAD'), 'utf8')).toContain('refs/heads/main');
    expect(readFileSync(join(restoredRoot, 'src', 'index.ts'), 'utf8')).toContain('42');
  });

  it('the restored machine is UNQUALIFIED, and the old HARD record did not travel', () => {
    const { bundle } = bundleOf();
    const destinationRoot = tmp();
    const result = performRestore({ bundlePath: bundle, destinationRoot });
    const restoredRoot = String(result.restored[0]?.destination);

    /* The qualification record is simply not there. */
    const canonDir = join(restoredRoot, '.serva', 'canon');
    const families = existsSync(canonDir) ? readdirSync(canonDir) : [];
    expect(families).not.toContain(MACHINE_QUALIFICATION_TYPE);

    /* And the result says so in words the owner will read. */
    expect(result.notes.join(' ')).toContain('UNQUALIFIED');
    expect(result.notes.join(' ')).toContain('never a property of the project');
  });

  it('refuses to restore over a different project without explicit confirmation', () => {
    const { bundle } = bundleOf();
    const destinationRoot = tmp();
    const occupied = join(destinationRoot, 'PRJ-1');
    mkdirSync(join(occupied, '.serva'), { recursive: true });
    writeFileSync(join(occupied, 'important.txt'), 'somebody else’s work\n', 'utf8');

    const inspection = inspectRestore({ bundlePath: bundle, destinationRoot });
    expect(inspection.ok).toBe(false);
    expect(inspection.problems.join(' ')).toContain('already contains');
    expect(() => performRestore({ bundlePath: bundle, destinationRoot })).toThrow(/Refusing/);
    /* And nothing was touched. */
    expect(readFileSync(join(occupied, 'important.txt'), 'utf8')).toContain('somebody else');
  });

  it('with confirmation, the displaced contents are moved aside rather than deleted', () => {
    const { bundle } = bundleOf();
    const destinationRoot = tmp();
    const occupied = join(destinationRoot, 'PRJ-1');
    mkdirSync(join(occupied, '.serva'), { recursive: true });
    writeFileSync(join(occupied, 'important.txt'), 'previous\n', 'utf8');

    const result = performRestore({ bundlePath: bundle, destinationRoot, overwrite: true });
    expect(result.restored).toHaveLength(1);
    const displaced = readdirSync(destinationRoot).find((n) => n.includes('.replaced-'));
    expect(displaced, 'the previous contents must still exist somewhere').toBeDefined();
    expect(
      readFileSync(join(destinationRoot, String(displaced), 'important.txt'), 'utf8'),
    ).toContain('previous');
  });

  it('restoring twice into fresh locations produces identical inventories', () => {
    const { bundle } = bundleOf();
    const first = performRestore({ bundlePath: bundle, destinationRoot: tmp() });
    const second = performRestore({ bundlePath: bundle, destinationRoot: tmp() });
    expect(second.files).toBe(first.files);
    expect(second.bytes).toBe(first.bytes);
  });

  it('an unverified backup is never restored', () => {
    const { bundle } = bundleOf();
    writeFileSync(join(bundle, CONTENT_DIR, 'smuggled.txt'), 'extra\n', 'utf8');
    expect(() => performRestore({ bundlePath: bundle, destinationRoot: tmp() })).toThrow(
      /unverified backup/,
    );
  });
});

/* ===================================================================== migration */

describe('migration is forward, visible, and refuses the unknown', () => {
  it('a current backup needs no migration', () => {
    const plan = planMigration(BACKUP_FORMAT_VERSION, 1);
    expect(plan.outcome).toBe(MigrationOutcome.NOT_REQUIRED);
    expect(plan.snapshotRequired).toBe(false);
  });

  it('a backup from the future is refused rather than read partially', () => {
    const plan = planMigration(BACKUP_FORMAT_VERSION + 1);
    expect(plan.outcome).toBe(MigrationOutcome.FROM_THE_FUTURE);
    expect(plan.explanation).toContain('silently discards');

    const compat = backupCompatibility(BACKUP_FORMAT_VERSION + 1, new Set());
    expect(compat.state).toBe(VersionCompatibility.UNSUPPORTED_NEW);
  });

  it('an unknown older format is UNSUPPORTED rather than attempted', () => {
    const plan = planMigration(0);
    expect(plan.outcome).toBe(MigrationOutcome.UNSUPPORTED);
    expect(plan.steps).toEqual([]);
  });

  it('the registry is the single source of truth about what can move forward', () => {
    /* Empty at 1.0, and that is the honest state: there is no earlier released format. */
    expect(MIGRATION_STEPS).toEqual([]);
    expect(migrationNeedsOwner(planMigration(BACKUP_FORMAT_VERSION))).toBe(false);
  });

  it('a future backup cannot be restored even if it verifies', () => {
    const { root } = seedProject();
    const bundle = join(tmp(), 'bundle');
    createBackup(
      { clock: clock() },
      { projects: [{ projectId: 'PRJ-1', name: 'RahalGo', root }], destination: bundle },
    );
    const manifestPath = join(bundle, MANIFEST_NAME);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    manifest['formatVersion'] = BACKUP_FORMAT_VERSION + 1;
    const rest = { ...manifest };
    delete (rest as { integrityDigest?: string }).integrityDigest;
    writeFileSync(
      manifestPath,
      JSON.stringify({ ...rest, integrityDigest: manifestDigest(rest as never) }),
      'utf8',
    );

    const inspection = inspectRestore({ bundlePath: bundle, destinationRoot: tmp() });
    expect(inspection.ok).toBe(false);
    expect(inspection.problems.join(' ')).toContain('newer Serva');
  });
});

/* ============================================================== machine identity */

describe('machine qualification is local and does not travel', () => {
  const FACTS = {
    platform: 'win32',
    release: '10.0.26200',
    architecture: 'x64',
    nodeVersion: 'v20.11.0',
    guestDistro: 'Ubuntu-24.04',
    guestUser: 'serva',
    sandboxMechanism: 'bubblewrap',
    sandboxVersion: '0.8.0',
  };

  it('a restored qualification is refused however green it says it is', () => {
    const identity = machineIdentity(FACTS);
    const restored = MachineQualificationSchema.parse({
      machineId: 'MACHINE-1',
      identity: FACTS,
      fingerprint: identity.fingerprint,
      state: MachineQualificationState.HARD,
      cases: [],
      reason: 'measured on the old machine',
      restoredFromBackup: true,
    });
    const refusal = qualificationRefusal(restored, identity);
    expect(refusal).toContain('restored from a backup');
    expect(refusal).toContain('property of a machine');
  });

  it('a changed machine invalidates the fingerprint, and the reason names what moved', () => {
    const before = machineIdentity(FACTS);
    const qualified = MachineQualificationSchema.parse({
      machineId: 'MACHINE-1',
      identity: FACTS,
      fingerprint: before.fingerprint,
      state: MachineQualificationState.HARD,
      cases: [],
      reason: 'measured here',
    });

    const after = machineIdentity({ ...FACTS, sandboxVersion: '0.9.0' });
    const refusal = qualificationRefusal(qualified, after);
    expect(refusal).toContain('sandboxVersion: 0.8.0 → 0.9.0');
  });

  it('interop being re-enabled invalidates qualification', () => {
    const before = machineIdentity({ ...FACTS, interopEnabled: false });
    const qualified = MachineQualificationSchema.parse({
      machineId: 'M',
      identity: { ...FACTS, interopEnabled: false },
      fingerprint: before.fingerprint,
      state: MachineQualificationState.HARD,
      cases: [],
      reason: 'measured here',
    });
    const after = machineIdentity({ ...FACTS, interopEnabled: true });
    expect(qualificationRefusal(qualified, after)).toContain('interopEnabled');
  });

  it('no record at all means no engineering', () => {
    expect(qualificationRefusal(undefined, machineIdentity(FACTS))).toContain(
      'never been qualified',
    );
  });

  it('a fresh machine starts UNQUALIFIED', () => {
    const fresh = unqualified({
      machineId: 'MACHINE-2',
      identity: FACTS,
      reason: 'restored from a backup taken on another computer',
      restoredFromBackup: true,
    });
    expect(fresh.state).toBe(MachineQualificationState.UNQUALIFIED);
    expect(fresh.restoredFromBackup).toBe(true);
  });
});

/* ================================================================ machine doctor */

describe('the doctor inspects, and never reports READY for something it could not measure', () => {
  const READY_PROBES: DoctorProbes = {
    platform: () => ({ platform: 'win32', release: '10.0.26200', arch: 'x64' }),
    node: () => ({ version: 'v20.11.0' }),
    wsl: () => ({ installed: true, version: '2', detail: 'WSL2 present' }),
    distro: () => ({
      name: 'Ubuntu-24.04',
      kernel: '5.15',
      user: 'serva',
      detail: 'Ubuntu-24.04 as serva',
    }),
    claude: () => ({
      installed: true,
      location: '/usr/local/bin/claude',
      version: '1.2.3',
      credentialsFilePresent: true,
      detail: 'installed, with a credentials file present',
    }),
    sandbox: () => ({
      mechanism: 'bubblewrap',
      version: '0.8.0',
      available: true,
      producerLauncher: '/usr/bin/claude-sandbox-runtime',
      detail: 'ok',
    }),
    git: () => ({ installed: true, version: '2.43.0', detail: 'ok' }),
    interop: () => ({ enabled: false, detail: 'interop disabled' }),
  };

  it('a machine with every prerequisite but no qualification is not engineering-ready', () => {
    const report = machineDoctor({ probes: READY_PROBES });
    expect(report.checks.every((c) => c.state !== CheckState.ACTION_REQUIRED)).toBe(true);
    /* Prerequisites present is not the same as measured. */
    expect(report.qualification).toBe(MachineQualificationState.UNQUALIFIED);
    expect(report.engineeringReady).toBe(false);
    expect(report.qualificationReason).toContain('never been qualified');
  });

  it('a missing prerequisite blocks engineering and names the remedy', () => {
    const report = machineDoctor({
      probes: {
        ...READY_PROBES,
        claude: () => ({ installed: false, credentialsFilePresent: false, detail: 'not found' }),
      },
    });
    const claude = report.checks.find((c) => c.id === 'CLAUDE');
    expect(claude?.state).toBe(CheckState.ACTION_REQUIRED);
    expect(claude?.remedy).toBeDefined();
    expect(report.engineeringReady).toBe(false);
  });

  it('not signed in is ACTION REQUIRED, and never suggests an API key', () => {
    const report = machineDoctor({
      probes: {
        ...READY_PROBES,
        claude: () => ({
          installed: true,
          location: '/usr/local/bin/claude',
          credentialsFilePresent: false,
          detail: 'installed, with no credentials file',
        }),
      },
    });
    const auth = report.checks.find((c) => c.id === 'CLAUDE_AUTH');
    expect(auth?.state).toBe(CheckState.ACTION_REQUIRED);
    expect(auth?.remedy).toContain('subscription');
    expect(auth?.remedy).toContain('never creates an API key');
    /* And it never prints who is signed in. */
    expect(auth?.detail).not.toMatch(/@/);
  });

  it('a probe that throws reports UNKNOWN rather than READY', () => {
    const report = machineDoctor({
      probes: {
        ...READY_PROBES,
        platform: () => {
          throw new Error('probe failed');
        },
      },
    });
    expect(report.checks.find((c) => c.id === 'PLATFORM')?.state).toBe(CheckState.UNKNOWN);
    expect(report.engineeringReady).toBe(false);
  });

  it('a root guest user is DEGRADED with the reason, not silently accepted', () => {
    const report = machineDoctor({
      probes: {
        ...READY_PROBES,
        distro: () => ({ name: 'Ubuntu-24.04', user: 'root', detail: 'running as root' }),
      },
    });
    const distro = report.checks.find((c) => c.id === 'DISTRO');
    expect(distro?.state).toBe(CheckState.DEGRADED);
    expect(distro?.remedy).toContain('not contained');
  });

  it('interop enabled is reported as a hole in the boundary', () => {
    const report = machineDoctor({
      probes: { ...READY_PROBES, interop: () => ({ enabled: true, detail: 'interop enabled' }) },
    });
    const interop = report.checks.find((c) => c.id === 'INTEROP');
    expect(interop?.state).toBe(CheckState.DEGRADED);
    expect(interop?.remedy).toContain('hole in the boundary');
  });

  it('reports a backup that does not verify', () => {
    const { root } = seedProject();
    const bundle = join(tmp(), 'bundle');
    createBackup(
      { clock: clock() },
      { projects: [{ projectId: 'PRJ-1', name: 'RahalGo', root }], destination: bundle },
    );
    writeFileSync(join(bundle, CONTENT_DIR, 'smuggled.txt'), 'x\n', 'utf8');

    const report = machineDoctor({ probes: READY_PROBES, lastBackupPath: bundle });
    const backup = report.checks.find((c) => c.id === 'BACKUP');
    expect(backup?.state).toBe(CheckState.ACTION_REQUIRED);
    expect(backup?.remedy).toContain('will not restore');
  });

  it('a guest that did not answer is UNKNOWN, not "not installed"', () => {
    /*
     * The distinction a diagnostic gets wrong most easily. Telling an owner to install an
     * engine they already have — because the guest was asleep — sends them to fix the
     * wrong thing, and the root cause (WSL) is already on the same screen.
     */
    const report = machineDoctor({
      probes: {
        ...READY_PROBES,
        wsl: () => ({ installed: false, detail: 'no working WSL guest responded' }),
        distro: () => ({ measured: false, detail: 'no WSL guest responded' }),
        claude: () => ({
          installed: false,
          credentialsFilePresent: false,
          measured: false,
          detail: 'no WSL guest responded',
        }),
        sandbox: () => ({ available: false, measured: false, detail: 'no WSL guest responded' }),
        interop: () => ({ detail: 'no WSL guest responded, so interop could not be measured' }),
      },
    });

    for (const id of ['DISTRO', 'CLAUDE', 'CLAUDE_AUTH', 'SANDBOX', 'INTEROP']) {
      expect(report.checks.find((c) => c.id === id)?.state, id).toBe(CheckState.UNKNOWN);
    }
    /* The root cause is the one that says what to do. */
    expect(report.checks.find((c) => c.id === 'WSL2')?.state).toBe(CheckState.ACTION_REQUIRED);
    expect(report.checks.find((c) => c.id === 'CLAUDE')?.remedy).toContain('Fix WSL first');
    /* And nothing is ready. */
    expect(report.engineeringReady).toBe(false);
  });

  it('interop that could not be measured is never reported as disabled', () => {
    const report = machineDoctor({
      probes: { ...READY_PROBES, interop: () => ({ detail: 'could not be measured' }) },
    });
    const interop = report.checks.find((c) => c.id === 'INTEROP');
    /*
     * `enabled: false` here would say "interop disabled" — a containment property reported
     * as safe because nothing answered.
     */
    expect(interop?.state).toBe(CheckState.UNKNOWN);
    expect(interop?.detail).not.toContain('disabled');
  });

  it('a credentials file never reaches READY, because it is not a session', () => {
    /*
     * The live acceptance found this doctor reporting "Claude subscription READY" on a
     * machine whose engine reported `authenticated: false`, and the factory then refused
     * the Producer. A green line above a refusal is the failure this product exists to
     * prevent, so there is now no branch that returns READY from a file.
     */
    const report = machineDoctor({ probes: READY_PROBES });
    const auth = report.checks.find((c) => c.id === 'CLAUDE_AUTH');
    expect(auth?.state).not.toBe(CheckState.READY);
    expect(auth?.detail).toContain('not established here');
    expect(auth?.remedy).toContain('serva engineering doctor');
  });

  it('the producer launcher is a separate check from the recipe sandbox', () => {
    /* Two boundaries, two mechanisms; bubblewrap is no evidence about the other. */
    const report = machineDoctor({
      probes: {
        ...READY_PROBES,
        sandbox: () => ({
          mechanism: 'bubblewrap',
          version: '0.8.0',
          available: true,
          detail: 'bubblewrap only',
        }),
      },
    });
    expect(report.checks.find((c) => c.id === 'SANDBOX')?.state).toBe(CheckState.READY);
    const producer = report.checks.find((c) => c.id === 'SANDBOX_PRODUCER');
    expect(producer?.state).toBe(CheckState.ACTION_REQUIRED);
    expect(producer?.remedy).toContain('sandbox-runtime');
    expect(producer?.remedy).toContain('bubblewrap is not a substitute');
    expect(report.engineeringReady).toBe(false);
  });

  it('renders owner-facing lines with the remedies underneath', () => {
    const rendered = renderDoctor(
      machineDoctor({
        probes: {
          ...READY_PROBES,
          sandbox: () => ({ available: false, detail: 'bubblewrap not found' }),
        },
      }),
    );
    expect(rendered).toContain('Sandbox (recipes)');
    expect(rendered).toContain('ACTION_REQUIRED');
    expect(rendered).toContain('→ Sandbox (recipes):');
  });
});

/* ================= a bundle is INPUT, and projectId is part of the bundle ================= */

describe('a crafted projectId cannot reach outside the destination root', () => {
  /*
   * SPEC: §32; CRITICAL finding INSTALL-UPDATE-ROLLBACK/SEC-1 from the independent review.
   *
   * Every FILE path in a bundle went through `safeBundlePath`/`resolveInside`, and the module
   * header states the rule plainly: "A BACKUP IS INPUT... every path is checked for traversal."
   * The project's own id never was. `inspectRestore` computed
   * `join(destinationRoot, p.projectId)` and `performRestore` then drove `rmSync`,
   * `mkdirSync` and `renameSync` from that path — including displacing whatever it found there.
   *
   * So the entries were guarded and the directory they all live in was not, which is the kind
   * of gap that survives review precisely because the neighbouring code looks careful.
   */
  function craftedBundle(projectId: string): string {
    const seeded = seedProject();
    const bundle = join(tmp(), 'bundle');
    createBackup(
      { clock: clock() },
      {
        projects: [{ projectId: 'PRJ-1', name: 'RahalGo', root: seeded.root }],
        destination: bundle,
      },
    );
    /*
     * Craft AFTER writing, and RE-SIGN. A hostile bundle is one somebody hands you, not one you
     * made — and `manifestDigest` is exported, so recomputing it is exactly what an attacker
     * building a bundle from scratch would do. The digest proves a bundle is self-consistent;
     * it was never evidence that its contents are safe to act on.
     */
    const manifestPath = join(bundle, MANIFEST_NAME);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown> & {
      projects: { projectId: string }[];
      integrityDigest?: string;
    };
    manifest.projects[0]!.projectId = projectId;
    delete manifest.integrityDigest;
    manifest.integrityDigest = manifestDigest(manifest as never);
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    return bundle;
  }

  it('refuses a traversal projectId, and inspection says so before anything runs', () => {
    const bundle = craftedBundle('../../escaped');
    const destinationRoot = tmp();
    const inspection = inspectRestore({ bundlePath: bundle, destinationRoot });
    expect(inspection.ok).toBe(false);
    expect(JSON.stringify(inspection)).toContain('escape');
  });

  it('SAYS SO in problems, not merely in ok:false', () => {
    /*
     * SPEC: HIGH finding MIGRATION/MIGR-SEC-1 — a regression in this very fix.
     *
     * The returned literal set `problems` twice: once with the escaping-id warnings and again,
     * later, with destination conflicts. The later key wins, so with no conflicts present the
     * escaping-id text was discarded entirely and the summary read "ready to restore" for the
     * single most dangerous class of bundle.
     *
     * `performRestore` refuses independently, so nothing could be written — but any surface
     * showing an owner what inspection found would have reported a crafted bundle as safe,
     * which is precisely what "SAID BEFORE, NOT DISCOVERED AFTER" exists to prevent.
     */
    const bundle = craftedBundle('../../escaped');
    const destinationRoot = tmp();
    const inspection = inspectRestore({ bundlePath: bundle, destinationRoot });
    expect(inspection.problems.join(' ')).toContain('escape');
    expect(inspection.summary).not.toContain('ready to restore');
  });

  it('refuses an absolute projectId', () => {
    const bundle = craftedBundle(process.platform === 'win32' ? 'C:\Windows\Temp' : '/tmp/x');
    const destinationRoot = tmp();
    expect(inspectRestore({ bundlePath: bundle, destinationRoot }).ok).toBe(false);
  });

  it('refuses a projectId that walks back out after walking in', () => {
    /* `a/../../b` normalizes outside the root even though no segment starts with `..`. */
    const bundle = craftedBundle('a/../../b');
    const destinationRoot = tmp();
    expect(inspectRestore({ bundlePath: bundle, destinationRoot }).ok).toBe(false);
  });

  it('MUTATES NOTHING when it refuses', () => {
    /*
     * The property that actually matters. A refusal that happens after the first `rmSync` is
     * not a refusal — and `performRestore` reaches rmSync before it reaches anything else.
     */
    const bundle = craftedBundle('../../escaped');
    const destinationRoot = tmp();
    const outside = dirname(dirname(destinationRoot));
    const before = readdirSync(outside).sort();

    expect(() => performRestore({ bundlePath: bundle, destinationRoot })).toThrow();

    expect(readdirSync(outside).sort()).toEqual(before);
    expect(readdirSync(destinationRoot)).toEqual([]);
  });

  it('a nested projectId is legitimate and still restores', () => {
    /* Confinement is not a ban on structure: `team/project` stays inside the root. */
    const bundle = craftedBundle('team/rahalgo');
    const destinationRoot = tmp();
    const result = performRestore({ bundlePath: bundle, destinationRoot });
    expect(result.restored).toHaveLength(1);
    const target = String(result.restored[0]?.destination);
    expect(resolve(target).startsWith(resolve(destinationRoot))).toBe(true);
    expect(existsSync(join(target, '.serva'))).toBe(true);
  });

  it('an ordinary restore is unchanged', () => {
    const bundle = craftedBundle('PRJ-1');
    const destinationRoot = tmp();
    const result = performRestore({ bundlePath: bundle, destinationRoot });
    expect(result.restored).toHaveLength(1);
    expect(existsSync(join(destinationRoot, 'PRJ-1', '.serva'))).toBe(true);
  });
});

/* ====== HIGH: "the content is scanned before it is written" must actually hold ====== */

describe('a credential in a large file does not travel in a backup', () => {
  /*
   * SPEC: §32; HIGH finding BACKUP-RESTORE/SEC-1.
   *
   * `createBackup` scanned only files of 2MB or less. Anything larger was copied into the
   * bundle and listed in the inventory with no content scan at all — while the comment
   * directly above the check said "THE CONTENT IS SCANNED, NOT ONLY THE PATH" and the module
   * header promised the content is scanned before it is written.
   *
   * A log, a dump or a bundled config is exactly where a pasted key ends up, and exactly the
   * kind of file that exceeds 2MB. The cutoff protected the scan's running time at the cost of
   * the guarantee the scan exists to provide.
   */
  it('scans a file well over the old 2MB cutoff', () => {
    const seeded = seedProject();
    /* A believable large artifact: mostly noise, one key in the middle. */
    const filler = 'x'.repeat(1024 * 1024);
    writeFileSync(
      join(seeded.root, 'debug.log'),
      filler + '\nAKIAIOSFODNN7EXAMPLE\n' + filler + filler,
      'utf8',
    );

    const destination = join(tmp(), 'bundle');
    const result = createBackup(
      { clock: clock() },
      {
        projects: [{ projectId: 'PRJ-1', name: 'RahalGo', root: seeded.root }],
        destination,
      },
    );

    const excluded = result.manifest.excluded.find((e) => e.path.endsWith('debug.log'));
    expect(excluded, 'a 3MB file carrying a key was not excluded').toBeDefined();
    expect(excluded?.reason).toBe('SENSITIVE');
    /* And it is genuinely absent from the bundle, not merely annotated in the manifest. */
    expect(result.manifest.inventory.some((e) => e.path.endsWith('debug.log'))).toBe(false);
  });

  it('a large file with nothing sensitive in it still travels', () => {
    /* The guarantee is about credentials, not about size. */
    const seeded = seedProject();
    writeFileSync(join(seeded.root, 'big.txt'), 'y'.repeat(3 * 1024 * 1024), 'utf8');
    const destination = join(tmp(), 'bundle');
    const result = createBackup(
      { clock: clock() },
      {
        projects: [{ projectId: 'PRJ-1', name: 'RahalGo', root: seeded.root }],
        destination,
      },
    );
    expect(result.manifest.inventory.some((e) => e.path.endsWith('big.txt'))).toBe(true);
  });
});

/* ====== SWEEP: a declared exclusion the writer never performed ====== */

describe('nothing machine-bound travels, as the writer promises', () => {
  /*
   * SPEC: §32; HIGH findings MIGRATION/MIGR-1 and RELEASE-HANDOVER/REL-HANDOVER-1.
   *
   * `backup.ts` imports MACHINE_BOUND_KEYS and uses it in exactly one place: to write
   * `machineBoundExcluded: [...MACHINE_BOUND_KEYS]` into the manifest. Nothing in `walkProject`
   * or `isExcluded` ever consulted it, so the field described an exclusion the writer did not
   * perform. Enforcement lived only on the restore side.
   *
   * That is the difference between a bundle Serva restores and a bundle somebody opens — and
   * the header's own threat scenario is the second one: "a backup gets copied to a USB stick
   * and emailed". A manifest asserting what a reader would find, incorrectly, is worse than
   * one that asserts nothing.
   */
  it('leaves machine-bound canon out of the bundle entirely', () => {
    const seeded = seedProject();
    /* Machine-bound canon, laid out the way the Store writes it. */
    for (const family of ['machine.qualification', 'machine.identity']) {
      const dir = join(seeded.root, '.serva', 'canon', family, 'M-1');
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'v1.json'),
        JSON.stringify({ body: { id: 'M-1', fingerprint: 'f'.repeat(64) } }),
        'utf8',
      );
    }

    const destination = join(tmp(), 'bundle');
    const result = createBackup(
      { clock: clock() },
      {
        projects: [{ projectId: 'PRJ-1', name: 'RahalGo', root: seeded.root }],
        destination,
      },
    );

    const carried = result.manifest.inventory.filter(
      (e) => e.path.includes('machine.qualification') || e.path.includes('machine.identity'),
    );
    expect(carried, 'machine-bound canon travelled in the bundle').toEqual([]);
  });

  it('the manifest records the exclusion it actually performed', () => {
    const seeded = seedProject();
    const destination = join(tmp(), 'bundle');
    const result = createBackup(
      { clock: clock() },
      {
        projects: [{ projectId: 'PRJ-1', name: 'RahalGo', root: seeded.root }],
        destination,
      },
    );
    /* The claim stays, and now it is true of the bundle on disk. */
    expect(result.manifest.machineBoundExcluded.length).toBeGreaterThan(0);
  });

  it('ordinary project canon still travels', () => {
    /* The exclusion is about machine facts, not about the project. */
    const seeded = seedProject();
    const destination = join(tmp(), 'bundle');
    const result = createBackup(
      { clock: clock() },
      {
        projects: [{ projectId: 'PRJ-1', name: 'RahalGo', root: seeded.root }],
        destination,
      },
    );
    expect(result.manifest.inventory.length).toBeGreaterThan(0);
  });
});

/* ====== SWEEP: two more paths that trusted content they had just read ====== */

describe('a crafted .git/HEAD cannot pull an arbitrary file into the manifest', () => {
  /*
   * SPEC: §32; HIGH finding BACKUP-RESTORE/BACKUP-RESTORE-F1.
   *
   * `gitIdentity()` read `.git/HEAD`, and for a `ref: <path>` line built
   * `join(gitDir, ...ref.split('/'))` and read whatever that resolved to — the only place in
   * the file that builds a filesystem path out of file CONTENT without confining it. `join`
   * collapses `..`, so `ref: ../../../../secrets.txt` put that file's contents verbatim into
   * `git.head`, which `credentialScan` never sees because it only runs over copied content.
   */
  it('refuses a ref that escapes the git directory', () => {
    const seeded = seedProject();
    const secret = join(seeded.root, '..', 'outside-secret.txt');
    writeFileSync(secret, 'ANTHROPIC_API_KEY=sk-ant-not-a-real-key\n', 'utf8');
    writeFileSync(join(seeded.root, '.git', 'HEAD'), 'ref: ../../outside-secret.txt\n', 'utf8');

    const destination = join(tmp(), 'bundle');
    const result = createBackup(
      { clock: clock() },
      {
        projects: [{ projectId: 'PRJ-1', name: 'RahalGo', root: seeded.root }],
        destination,
      },
    );

    const head = result.manifest.projects[0]?.git?.head ?? '';
    expect(head, 'a file outside the git directory reached the manifest').not.toContain('sk-ant-');
  });

  it('an ordinary branch ref still records its commit', () => {
    const seeded = seedProject();
    const destination = join(tmp(), 'bundle');
    const result = createBackup(
      { clock: clock() },
      {
        projects: [{ projectId: 'PRJ-1', name: 'RahalGo', root: seeded.root }],
        destination,
      },
    );
    expect(result.manifest.projects[0]?.git?.present).toBe(true);
  });
});
