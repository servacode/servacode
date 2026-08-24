import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { NewProjectField, createProject, newProjectRefusal } from '../src/app/create.js';
import { ServaRuntime } from '../src/app/runtime.js';
import { isServaProject } from '../src/app/services.js';
import { cleanup, tempRoot } from './helpers.js';

/**
 * A PROJECT CAN BE CREATED WITHOUT LEAVING VS CODE, AND IT IS THE SAME PROJECT.
 *
 * SPEC: Phase 6 closure §4; 03 §2.
 *
 * An independent audit found the extension had no way to bring a project into existence, so
 * the first act required of an owner of a VS Code product was to open a terminal.
 *
 * The fix could have been a second creation path in the extension, and that would have been
 * worse than the gap. Two paths drift, and the one that drifts is the one nobody runs in CI,
 * so a project made from the panel ends up subtly unlike one made from the CLI and the
 * difference surfaces much later as a project that behaves oddly for no visible reason.
 *
 * These tests are mostly about that: one service, one set of rules, and an Idea that survives
 * the trip verbatim.
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

const IDEA =
  'أريد نظاماً يوقف ضياع طلبات الهاتف — I want the phone orders to stop getting lost,\n' +
  'especially on Fridays when two people answer at once.';

/* ============================================================= the rules, before anything */

describe('creation refuses before it writes, and says which answer was wrong', () => {
  it('refuses an empty name and an empty idea, each against its own field', () => {
    const root = folder();
    expect(newProjectRefusal({ root, name: '   ', idea: IDEA })?.field).toBe(NewProjectField.NAME);
    expect(newProjectRefusal({ root, name: 'RahalGo', idea: '  \n ' })?.field).toBe(
      NewProjectField.IDEA,
    );
  });

  it('checks one field at a time, so a wizard can validate as the owner types', () => {
    /* Asking about the name must not complain that the idea is still empty. */
    expect(newProjectRefusal({ name: 'RahalGo' }, NewProjectField.NAME)).toBeUndefined();
    expect(newProjectRefusal({ idea: IDEA }, NewProjectField.IDEA)).toBeUndefined();
  });

  it('refuses a folder that does not exist rather than creating one', () => {
    const missing = join(folder(), 'not-here');
    const refusal = newProjectRefusal({ root: missing, name: 'RahalGo', idea: IDEA });
    expect(refusal?.field).toBe(NewProjectField.ROOT);
    expect(existsSync(missing)).toBe(false);
  });

  it('refuses to create a second company inside an existing one', () => {
    const root = folder();
    createProject({ root, name: 'RahalGo', idea: IDEA });
    const refusal = newProjectRefusal({ root, name: 'RahalGo Again', idea: IDEA });
    expect(refusal?.field).toBe(NewProjectField.ROOT);
    expect(refusal?.message).toContain('already exists');
  });

  it('a refused request leaves the folder exactly as it was', () => {
    const root = folder();
    writeFileSync(join(root, 'README.md'), '# existing work\n', 'utf8');
    const before = readdirSync(root).sort();
    expect(() => createProject({ root, name: '', idea: IDEA })).toThrow();
    expect(readdirSync(root).sort()).toEqual(before);
    expect(isServaProject(root)).toBe(false);
  });

  it('refuses a name carrying a control character, which is invisible in one surface and corrupting in another', () => {
    const root = folder();
    const refusal = newProjectRefusal({
      root,
      name: 'Rahal' + String.fromCharCode(7) + 'Go',
      idea: IDEA,
    });
    expect(refusal?.field).toBe(NewProjectField.NAME);
  });
});

/* ====================================================================== the idea survives */

describe('the Idea is recorded verbatim', () => {
  it('keeps the owner’s words, including newlines and non-Latin script', () => {
    const root = folder();
    const created = createProject({ root, name: 'RahalGo', idea: IDEA });
    expect(created.idea).toBe(IDEA);

    /* And it is what is on disk, not merely what was returned. */
    const rt = ServaRuntime.open({ root });
    try {
      expect(rt.requireProject().idea.text).toBe(IDEA);
      expect(rt.requireProject().idea.source).toBe('OWNER_STATED');
    } finally {
      rt.close();
    }
  });

  it('trims only the surrounding whitespace, and nothing inside', () => {
    const root = folder();
    const created = createProject({ root, name: '  RahalGo  ', idea: '\n  ' + IDEA + '  \n' });
    expect(created.name).toBe('RahalGo');
    expect(created.idea).toBe(IDEA);
  });
});

/* ============================================================ one service, both surfaces */

describe('the CLI and the extension create the same project the same way', () => {
  it('`serva init` produces exactly what `createProject` produces', () => {
    const viaService = folder();
    const viaCli = folder();

    const created = createProject({ root: viaService, name: 'RahalGo', idea: IDEA });

    execFileSync(
      process.execPath,
      [join('dist', 'cli', 'main.js'), 'init', 'RahalGo', '--idea', IDEA, '--root', viaCli],
      { encoding: 'utf8', timeout: 120_000 },
    );

    const shape = (root: string): unknown => {
      const rt = ServaRuntime.open({ root });
      try {
        const p = rt.requireProject();
        return {
          name: p.name,
          idea: p.idea.text,
          source: p.idea.source,
          profile: p.profile,
          riskClass: p.riskClass,
          servaVersion: p.servaVersion,
        };
      } finally {
        rt.close();
      }
    };

    expect(shape(viaCli)).toEqual(shape(viaService));
    expect(created.projectId).toMatch(/^SC-PROJ-/);
  });

  it('the CLI refuses the same things the service refuses, with the same remedy', () => {
    const root = folder();
    let output = '';
    try {
      execFileSync(
        process.execPath,
        [join('dist', 'cli', 'main.js'), 'init', '', '--idea', IDEA, '--root', root],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 },
      );
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string };
      output = String(err.stdout ?? '') + String(err.stderr ?? '');
    }
    expect(output).toContain('A project needs a name');
    expect(isServaProject(root)).toBe(false);
  });
});

/* ================================================================= what exists afterwards */

describe('a created project is immediately readable by every surface', () => {
  it('is a Serva project, with a store the snapshot can open', () => {
    const root = folder();
    const created = createProject({ root, name: 'RahalGo', idea: IDEA });
    expect(isServaProject(root)).toBe(true);
    expect(existsSync(created.storePath)).toBe(true);
    expect(created.servaVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('does not disturb work already in the folder', () => {
    const root = folder();
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'app.ts'), 'export const x = 1;\n', 'utf8');
    createProject({ root, name: 'RahalGo', idea: IDEA });
    expect(readFileSync(join(root, 'src', 'app.ts'), 'utf8')).toBe('export const x = 1;\n');
  });
});
