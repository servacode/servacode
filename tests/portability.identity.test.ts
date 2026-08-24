import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { ServaRuntime } from '../src/app/runtime.js';
import { ACTIONS, invokeAction } from '../src/app/actions.js';
import { isServaProject } from '../src/app/services.js';
import { MANIFEST_NAME } from '../src/portability/backup.js';
import { cleanup, tempRoot } from './helpers.js';

/**
 * A BACKUP KNOWS WHICH PROJECT IT IS, AND A RESTORE WORKS ON A MACHINE WITH NOTHING ON IT.
 *
 * SPEC: Phase 6 closure §7; §24, §26, §32.
 *
 * Two findings, and they meet in the same place: the fresh machine.
 *
 * The panel passed the literals `PRJ-1` and `project` as the identity of every backup it
 * made, and the CLI derived an id from the FOLDER NAME — so renaming a directory renamed the
 * project as far as every backup taken afterwards was concerned. Neither failed loudly: a
 * manifest with a plausible id looks exactly like a correct one, right up until somebody
 * restores two of them onto one machine.
 *
 * And restore itself opened the Store before it would start, so it gave up in an empty
 * folder — which is the entire situation restore exists for. The one machine state where an
 * owner most needs their work back was the one state the command refused to begin in.
 */

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) cleanup(r);
});

function folder(): string {
  const root = tempRoot();
  roots.push(root);
  return root;
}

function project(name = 'RahalGo'): ServaRuntime {
  return ServaRuntime.init(name, 'Stop losing phone orders', { root: folder() });
}

function manifestOf(bundlePath: string): {
  projects: { projectId: string; name: string }[];
} {
  return JSON.parse(readFileSync(join(bundlePath, MANIFEST_NAME), 'utf8')) as {
    projects: { projectId: string; name: string }[];
  };
}

/* ================================================================ the identity is read */

describe('the caller says where a backup goes, not what is in it', () => {
  it('backup.create does not accept a project identity at all', () => {
    /*
     * The strongest available form of this fix: a caller cannot pass the wrong id if there
     * is no field to pass it in. A test asserting "the panel passes the right id" would go
     * green again the moment a second caller appeared.
     */
    const schema = ACTIONS.get('backup.create')?.schema;
    const parsed = schema?.safeParse({
      destination: 'somewhere',
      projectId: 'PRJ-1',
      name: 'project',
    });
    expect(parsed?.success).toBe(false);
  });

  it('the manifest carries the project’s real id and name', async () => {
    const rt = project('RahalGo');
    const destination = join(folder(), 'bundle');
    const result = await invokeAction(
      { rt },
      { id: 'backup.create', input: { destination }, confirmed: true },
    );
    expect(result.ok, String(result.refusal)).toBe(true);

    const recorded = manifestOf(destination).projects[0];
    expect(recorded?.projectId).toBe(rt.requireProject().id);
    expect(recorded?.name).toBe('RahalGo');
    /* The two literals that used to be here. */
    expect(recorded?.projectId).not.toBe('PRJ-1');
    expect(recorded?.name).not.toBe('project');
  });

  it('renaming the folder does not rename the project', async () => {
    const rt = project('RahalGo');
    const original = rt.root;
    rt.close();

    const renamed = original + '-renamed';
    renameSync(original, renamed);
    roots.push(renamed);

    const reopened = ServaRuntime.open({ root: renamed });
    try {
      const destination = join(folder(), 'bundle');
      await invokeAction(
        { rt: reopened },
        { id: 'backup.create', input: { destination }, confirmed: true },
      );
      const recorded = manifestOf(destination).projects[0];
      expect(recorded?.projectId).toBe(reopened.requireProject().id);
      expect(recorded?.name).toBe('RahalGo');
      expect(recorded?.projectId).not.toContain('renamed');
    } finally {
      reopened.close();
    }
  });

  it('two projects produce two distinguishable backups', async () => {
    const first = project('RahalGo');
    const second = project('Mataam');
    const a = join(folder(), 'a');
    const b = join(folder(), 'b');
    await invokeAction(
      { rt: first },
      { id: 'backup.create', input: { destination: a }, confirmed: true },
    );
    await invokeAction(
      { rt: second },
      { id: 'backup.create', input: { destination: b }, confirmed: true },
    );
    expect(manifestOf(a).projects[0]?.projectId).not.toBe(manifestOf(b).projects[0]?.projectId);
    expect(manifestOf(a).projects[0]?.name).toBe('RahalGo');
    expect(manifestOf(b).projects[0]?.name).toBe('Mataam');
  });
});

/* ============================================================== restore with nothing open */

describe('restoring onto a machine with no project open', () => {
  async function backupOf(name = 'RahalGo'): Promise<string> {
    const rt = project(name);
    const destination = join(folder(), 'bundle');
    await invokeAction({ rt }, { id: 'backup.create', input: { destination }, confirmed: true });
    rt.close();
    return destination;
  }

  it('restore.inspect and restore.perform declare that they need no project', () => {
    expect(ACTIONS.get('restore.inspect')?.needsProject).toBe(false);
    expect(ACTIONS.get('restore.perform')?.needsProject).toBe(false);
    expect(ACTIONS.get('backup.verify')?.needsProject).toBe(false);
  });

  it('inspects a backup with an empty action context', async () => {
    const bundlePath = await backupOf();
    const destinationRoot = folder();
    const inspection = await invokeAction(
      {},
      { id: 'restore.inspect', input: { bundlePath, destinationRoot } },
    );
    expect(inspection.ok, String(inspection.refusal)).toBe(true);
  });

  it('restores into an empty folder, and the project is there afterwards', async () => {
    const bundlePath = await backupOf('RahalGo');
    const destinationRoot = folder();
    expect(isServaProject(destinationRoot)).toBe(false);

    const result = await invokeAction(
      {},
      { id: 'restore.perform', input: { bundlePath, destinationRoot }, confirmed: true },
    );
    expect(result.ok, String(result.refusal)).toBe(true);

    /*
     * Each project lands in `<destinationRoot>/<project id>`, and the result says exactly
     * where. A surface that assumed the chosen folder WAS the project would show the owner a
     * directory listing instead of their company.
     */
    const landed = (result.data as { restored: { destination: string }[] }).restored[0]
      ?.destination;
    expect(landed).toBeDefined();
    expect(isServaProject(String(landed))).toBe(true);

    const restored = ServaRuntime.open({ root: String(landed) });
    try {
      expect(restored.requireProject().name).toBe('RahalGo');
    } finally {
      restored.close();
    }
  });

  it('the extension opens where the project landed, not the folder above it', () => {
    /* The defect this avoids is silent: the window opens, and shows nothing recognisable. */
    const host = readFileSync('extension/src/extension.ts', 'utf8');
    expect(host).toContain('?.restored?.[0]?.destination');
    expect(host).not.toMatch(/openFolder',\s*vscode\.Uri\.file\(destinationRoot\)/);
  });

  it('an action that reads a project is still refused politely without one', async () => {
    const result = await invokeAction({}, { id: 'project.snapshot', input: {} });
    expect(result.ok).toBe(false);
    expect(String(result.refusal)).toContain('no Serva project here');
    /* And it says what to do about it, rather than only what went wrong. */
    expect(String(result.refusal)).toContain('restore a backup');
  });

  it('still refuses an unverified bundle when nothing is open to protect it', async () => {
    /*
     * Reaching restore without a project must not mean reaching it without the checks. The
     * absence of an open Store is not a reason to trust a directory more.
     */
    const bundlePath = folder();
    mkdirSync(join(bundlePath, 'not-a-backup'), { recursive: true });
    const result = await invokeAction(
      {},
      { id: 'restore.perform', input: { bundlePath, destinationRoot: folder() }, confirmed: true },
    );
    expect(result.ok).toBe(false);
  });

  it('still requires confirmation when nothing is open', async () => {
    const bundlePath = await backupOf();
    const destinationRoot = folder();
    const result = await invokeAction(
      {},
      { id: 'restore.perform', input: { bundlePath, destinationRoot } },
    );
    expect(result.ok).toBe(false);
    expect(readdirSync(destinationRoot)).toHaveLength(0);
    expect(existsSync(join(destinationRoot, '.serva'))).toBe(false);
  });
});
