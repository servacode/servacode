import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SERVA_VERSION } from '../../src/portability/version.js';

/**
 * THE ARTIFACT AN OWNER ACTUALLY INSTALLS, INSTALLED THE WAY THEY WOULD INSTALL IT.
 *
 * SPEC: Phase 6 closure §12; the 1.0.1 packaging audit.
 *
 * Distribution acceptance for 1.0.0 was broader than its proof. Every offline test passed, the
 * build succeeded, `npm pack` reported success — and the package was missing
 * `dist/coverage/index.js`, because `.gitignore` carries a `coverage/` rule and npm honours it
 * when no `files` whitelist is present. The CLI died on first run:
 *
 *   ERR_MODULE_NOT_FOUND  Cannot find module .../dist/coverage/index.js
 *
 * Nothing in the repository could have caught that, because everything in the repository has
 * the repository. The defect lives exactly in the gap between "the source tree works" and
 * "the artifact works", so the test has to cross that gap for real: pack, install somewhere
 * that cannot see `D:/SEVACODE/node_modules`, and run the binary.
 *
 * This suite is separate from the default one because it is slow and does real I/O —
 * `npm run test:package`. It is NOT excluded for being inconvenient: it is the only evidence
 * that the thing an owner downloads is the thing that runs.
 */

const repoRoot = join(import.meta.dirname, '..', '..');
const workspaces: string[] = [];

afterAll(() => {
  for (const w of workspaces.splice(0)) rmSync(w, { recursive: true, force: true });
});

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  workspaces.push(dir);
  return dir;
}

function npm(args: readonly string[], cwd: string): string {
  return execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', [...args], {
    cwd,
    encoding: 'utf8',
    timeout: 10 * 60_000,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  });
}

/**
 * Build once, then pack once, and share the artifact across the tests below.
 *
 * `dist/` must exist for the artifact to mean anything. Building here rather than skipping is
 * deliberate: a packaging test that quietly passes because there was nothing to package is the
 * same vacuous-success shape this suite exists to catch.
 */
let tarball: string | undefined;
let contents: readonly string[] | undefined;

function build(): void {
  if (!existsSync(join(repoRoot, 'dist', 'cli', 'main.js'))) npm(['run', 'build'], repoRoot);
}

/**
 * What npm itself says goes into the package.
 *
 * npm's own view rather than a tar listing: it is the authority that decides inclusion, it
 * already answers in JSON, and reading it needs no external archiver — which on Windows is a
 * different program than on the machine that wrote the test.
 */
function packedFiles(): readonly string[] {
  if (contents !== undefined) return contents;
  build();
  const report = JSON.parse(npm(['pack', '--dry-run', '--json'], repoRoot)) as {
    files?: { path: string }[];
  }[];
  contents = (report[0]?.files ?? []).map((f) => f.path);
  return contents;
}

/** The real artifact, written where nothing else will pick it up. */
function artifact(): string {
  if (tarball !== undefined) return tarball;
  build();
  const out = scratch('serva-pack-');
  npm(['pack', '--pack-destination', out], repoRoot);
  const found = readdirSync(out).find((f) => f.endsWith('.tgz'));
  expect(found, 'npm pack produced no tarball').toBeDefined();
  tarball = join(out, String(found));
  return tarball;
}

describe('the packed runtime carries everything it needs', () => {
  it('packs an artifact named for the current version', () => {
    expect(artifact()).toContain(SERVA_VERSION);
  });

  it('contains dist/coverage/index.js — the file .gitignore silently removed', () => {
    /*
     * The exact 1.0.0 defect. `coverage/` in .gitignore matched `dist/coverage/`, npm honoured
     * it, and the CLI imported a module that was not in the package.
     */
    expect(packedFiles()).toContain('dist/coverage/index.js');
  });

  it('contains the generated catalogues the runtime reads at startup', () => {
    /* Generated assets are the other thing a whitelist can silently drop. */
    expect(packedFiles()).toContain('dist/catalogue/generated/catalogues.json');
    expect(packedFiles()).toContain('dist/agents/generated/contracts.json');
  });

  it('ships no source, tests, evidence or scratch output', () => {
    /*
     * The other direction. An artifact carrying `evidence/` or `out/` would leak this
     * machine's runs to whoever installs it, and shipping `src/` invites an owner to edit
     * files that are never executed.
     */
    const leaked = packedFiles().filter((f) => /^(src|tests|evidence|out|scripts)\//.test(f));
    expect(leaked, 'these do not belong in a runtime artifact').toEqual([]);
  });

  it('every compiled entrypoint the CLI can reach is present', () => {
    /*
     * A whitelist that catches `dist` but drops a subdirectory is the shape of the original
     * defect, so this compares the package against the build rather than against a list
     * somebody remembered to write.
     */
    build();
    const onDisk = new Set<string>();
    const walk = (dir: string, prefix: string): void => {
      for (const entry of readdirSync(join(repoRoot, dir), { withFileTypes: true })) {
        const rel = prefix + entry.name;
        if (entry.isDirectory()) walk(join(dir, entry.name), rel + '/');
        else if (entry.name.endsWith('.js')) onDisk.add(rel);
      }
    };
    walk('dist', 'dist/');

    const packed = new Set(packedFiles());
    const missing = [...onDisk].filter((f) => !packed.has(f));
    expect(missing, 'compiled modules the package would not carry').toEqual([]);
  });
});

describe('the artifact runs where the repository cannot help it', () => {
  /*
   * Installed into a temp directory with its own `node_modules`, so nothing resolves back to
   * `D:/SEVACODE/node_modules`. If this passes only because the repository is nearby, it
   * proves nothing about the owner's machine.
   */
  let installed: string | undefined;

  function install(): string {
    if (installed !== undefined) return installed;
    const home = scratch('serva-install-');
    writeFileSync(
      join(home, 'package.json'),
      JSON.stringify({ name: 'isolated-host', version: '1.0.0', private: true }) + '\n',
      'utf8',
    );
    npm(['install', artifact(), '--no-audit', '--no-fund'], home);
    installed = home;
    return home;
  }

  function serva(args: readonly string[], cwd: string): { out: string; code: number } {
    const cli = join(install(), 'node_modules', 'serva-code', 'dist', 'cli', 'main.js');
    try {
      return {
        out: execFileSync(process.execPath, [cli, ...args], {
          cwd,
          encoding: 'utf8',
          timeout: 5 * 60_000,
          stdio: ['ignore', 'pipe', 'pipe'],
        }),
        code: 0,
      };
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; status?: number };
      return { out: String(err.stdout ?? '') + String(err.stderr ?? ''), code: err.status ?? 1 };
    }
  }

  it('installs without reaching into the repository', () => {
    const home = install();
    expect(existsSync(join(home, 'node_modules', 'serva-code', 'dist', 'cli', 'main.js'))).toBe(
      true,
    );
    /* Its own dependency tree, resolved by npm from the manifest rather than borrowed. */
    expect(existsSync(join(home, 'node_modules', 'zod'))).toBe(true);
  });

  it('declares the runtime dependency it actually imports, and a bin', () => {
    const pkg = JSON.parse(
      readFileSync(join(install(), 'node_modules', 'serva-code', 'package.json'), 'utf8'),
    ) as { version?: string; dependencies?: Record<string, string>; bin?: Record<string, string> };
    expect(pkg.version).toBe(SERVA_VERSION);
    expect(pkg.dependencies?.['zod'], 'the CLI imports zod at runtime').toBeDefined();
    expect(pkg.bin?.['serva'], 'the owner runs `serva`').toBeDefined();
  });

  it('reports the product version', () => {
    const r = serva(['--version'], install());
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain(SERVA_VERSION);
  });

  it('prints help', () => {
    const r = serva(['--help'], install());
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('Usage: serva');
  });

  it('loads the generated catalogues, which live in the package rather than the repo', () => {
    /* `--help` proves the entrypoint resolves; this proves the assets came with it. */
    for (const command of ['gates', 'workflows']) {
      const r = serva([command], install());
      expect(r.code, command + ': ' + r.out).toBe(0);
      expect(r.out.length, command).toBeGreaterThan(40);
    }
  });

  it('initialises and reads back a real project', () => {
    /*
     * The owner's actual first minutes, and the strongest available statement that the
     * artifact is complete: `--help` can pass on a package whose store layer is broken.
     */
    const project = scratch('serva-owner-project-');
    const init = serva(['init', 'RahalGo', '--idea', 'Stop losing phone orders'], project);
    expect(init.code, init.out).toBe(0);
    expect(init.out).toContain('Initialized Serva project');

    const status = serva(['status'], project);
    expect(status.code, status.out).toBe(0);
    expect(status.out).toContain('RahalGo');

    const doctor = serva(['doctor'], project);
    expect(doctor.code, doctor.out).toBe(0);
  });

  it('every module the CLI loads resolves inside the package', () => {
    /*
     * The general form of the 1.0.0 defect. A missing file surfaces as ERR_MODULE_NOT_FOUND,
     * so any command that reports one has found another gap in the whitelist — whatever the
     * command happened to be doing.
     */
    for (const args of [
      ['--help'],
      ['gates'],
      ['workflows'],
      ['acceptance'],
      ['machine', 'doctor'],
    ]) {
      const r = serva(args, install());
      expect(r.out, args.join(' ')).not.toContain('ERR_MODULE_NOT_FOUND');
      expect(r.out, args.join(' ')).not.toContain('Cannot find module');
      expect(r.out, args.join(' ')).not.toContain('Cannot find package');
    }
  });
});
