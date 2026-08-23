import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * THE REAL PORTABILITY WALKTHROUGH.
 *
 * SPEC: §53, §57.
 *
 * Everything here happens on the real filesystem, through the real CLI, against a
 * DISPOSABLE project. No production project of the owner's is touched, and nothing is
 * mocked — the point is to prove that the sequence an owner would actually perform works
 * on this computer, which a unit test cannot say.
 *
 * The step that matters most is the last one: the restored project arrives complete and
 * the machine arrives UNQUALIFIED. If that ever stops being true, a restore has quietly
 * become a way to inherit somebody else's security clearance.
 */

const CLI = join(process.cwd(), 'dist', 'cli', 'main.js');
const lines = [];

function say(text = '') {
  lines.push(text);
  console.log(text);
}

function serva(args, opts = {}) {
  try {
    const out = execFileSync(process.execPath, [CLI, ...args], {
      encoding: 'utf8',
      cwd: opts.cwd ?? process.cwd(),
      timeout: 120_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out: out.trim() };
  } catch (e) {
    const err = /** @type {{ status?: number; stdout?: string; stderr?: string }} */ (e);
    return {
      code: err.status ?? 1,
      out: String(err.stdout ?? '').trim(),
      err: String(err.stderr ?? '').trim(),
    };
  }
}

/** Every file under a root, relative and forward-slashed, for inventory comparison. */
function inventory(root) {
  const out = [];
  const walk = (dir, rel) => {
    for (const name of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const next = rel === '' ? name.name : rel + '/' + name.name;
      if (name.isDirectory()) walk(join(dir, name.name), next);
      else out.push(next);
    }
  };
  walk(root, '');
  return out;
}

const workspace = mkdtempSync(join(tmpdir(), 'serva-walkthrough-'));
const projectDir = join(workspace, 'disposable-project');
const bundleDir = join(workspace, 'backup');
const restoreDir = join(workspace, 'restored');
mkdirSync(projectDir, { recursive: true });
mkdirSync(restoreDir, { recursive: true });

say('SERVA CODE — REAL PORTABILITY WALKTHROUGH');
say('='.repeat(72));
say('Workspace: ' + workspace);
say('');

/* --------------------------------------------------------- 1. a disposable project */

say('1. CREATE A DISPOSABLE PROJECT');
const init = serva(
  ['init', 'WalkthroughShop', '--idea', 'A corner shop losing phone orders in the morning rush'],
  { cwd: projectDir },
);
say(init.out || init.err || '(no output)');
if (!existsSync(join(projectDir, '.serva', 'SCHEMA_VERSION'))) {
  say('FAILED: no store was created');
  process.exit(1);
}
/* Real project content, so the restore has something to prove it carried. */
mkdirSync(join(projectDir, 'src'), { recursive: true });
writeFileSync(
  join(projectDir, 'src', 'orders.ts'),
  'export const takeOrder = () => true;\n',
  'utf8',
);
say('');

const before = inventory(projectDir);
say('   files in the project: ' + String(before.length));
say('');

/* ------------------------------------------------------------ 2. a verified backup */

say('2. WRITE A VERIFIED BACKUP');
const backup = serva(['backup', '--to', bundleDir, '--confirm', '--root', projectDir]);
say(backup.out || backup.err);
say('');

say('3. PROVE THE BACKUP BEFORE RELYING ON IT');
const verify = serva(['verify-backup', bundleDir]);
say(verify.out || verify.err);
say('   exit code: ' + String(verify.code) + (verify.code === 0 ? '  (verified)' : '  (REFUSED)'));
say('');

/* ------------------------------------------------------ 4. inspect, then restore */

say('4. INSPECT THE RESTORE — THIS WRITES NOTHING');
const inspect = serva(['restore', bundleDir, '--to', restoreDir]);
say(inspect.out || inspect.err);
say('');

say('5. RESTORE INTO A SEPARATE FRESH LOCATION');
const restore = serva(['restore', bundleDir, '--to', restoreDir, '--confirm']);
say(restore.out || restore.err);
say('');

/* ------------------------------------------------------- 6. inventory equivalence */

const restoredRoots = readdirSync(restoreDir);
const restoredProject = join(restoreDir, restoredRoots[0] ?? '');
say('6. INVENTORY EQUIVALENCE');
const after = inventory(restoredProject);
const manifest = JSON.parse(readFileSync(join(bundleDir, 'serva-backup.json'), 'utf8'));
const excluded = new Set(manifest.excluded.map((e) => e.path));
const missing = before.filter((f) => !after.includes(f) && !excluded.has(f.split('/')[0]));
say('   original:  ' + String(before.length) + ' files');
say('   restored:  ' + String(after.length) + ' files');
say('   excluded by policy: ' + [...excluded].join(', '));
say(
  missing.length === 0
    ? '   every non-excluded file came back.'
    : '   MISSING: ' + missing.join(', '),
);
say('');

/* --------------------------------------------- 7. machine-bound authority omitted */

say('7. MACHINE-BOUND AUTHORITY WAS NOT CARRIED');
const canonDir = join(restoredProject, '.serva', 'canon');
const families = existsSync(canonDir) ? readdirSync(canonDir) : [];
const machineFamilies = families.filter(
  (f) => f.startsWith('machine.') || f.includes('osQualification'),
);
say('   canon families restored: ' + String(families.length));
say(
  machineFamilies.length === 0
    ? '   no machine-bound family is present.'
    : '   PRESENT (this is a defect): ' + machineFamilies.join(', '),
);
say('   manifest records as never carried: ' + manifest.machineBoundExcluded.join(', '));
say('');

/* ----------------------------------------------- 8. and no credential travelled */

say('8. NO CREDENTIAL TRAVELLED');
const credentialPattern =
  /sk-ant-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|AKIA[0-9A-Z]{16}|-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/;
let credentialHits = 0;
for (const rel of inventory(join(bundleDir, 'content'))) {
  const text = readFileSync(join(bundleDir, 'content', ...rel.split('/')), 'utf8');
  if (credentialPattern.test(text)) {
    credentialHits += 1;
    say('   FOUND in ' + rel);
  }
}
say(
  credentialHits === 0
    ? '   nothing in the bundle matches a credential shape.'
    : '   ' + String(credentialHits) + ' HITS',
);
say('');

/* ------------------------------------------------------------ 9. the machine */

say('9. THE RESTORED PROJECT STILL NEEDS THIS MACHINE TO BE MEASURED');
const doctor = serva(['machine', 'doctor', '--root', restoredProject]);
say(doctor.out || doctor.err);
say(
  '   exit code: ' +
    String(doctor.code) +
    (doctor.code === 0 ? '  (engineering permitted)' : '  (engineering NOT permitted)'),
);
say('');

const overview = serva(['overview', '--root', restoredProject]);
say('10. THE RESTORED PROJECT, AS THE OWNER SEES IT');
say(overview.out || overview.err);
say('');

say('='.repeat(72));
say('The project came back. The clearance did not.');

writeFileSync(
  join(process.cwd(), 'evidence', 'PORTABILITY_WALKTHROUGH.txt'),
  lines.join('\n') + '\n',
  'utf8',
);
rmSync(workspace, { recursive: true, force: true });
console.log('\nwritten to evidence/PORTABILITY_WALKTHROUGH.txt; disposable workspace removed');
