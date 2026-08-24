import * as assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { NewProjectField, createProject, newProjectRefusal } from '../../src/app/create.js';
import { isServaProject } from '../../src/app/services.js';
import { ServaRuntime } from '../../src/app/runtime.js';
import { activated } from './helpers.js';

/**
 * CREATING A PROJECT FROM INSIDE VS CODE.
 *
 * SPEC: Phase 6 closure §4, §8.
 *
 * The command's dialogs cannot be driven from a test — `showOpenDialog` and `showInputBox`
 * wait for a person, and a test that stubbed them would be testing the stub. What this suite
 * proves instead is everything either side of them: the command exists and is registered in a
 * real editor, it is reachable in a window with NO project open, and the creation service the
 * command calls behaves identically here to the way it behaves under the offline suite.
 *
 * That last point is the one worth having. The service is shared with `serva init`, so if it
 * behaved differently inside the extension host — different cwd, different module instance,
 * different filesystem semantics — the two surfaces would silently diverge.
 */

const IDEA = 'أريد نظاماً يوقف ضياع طلبات الهاتف — stop the phone orders getting lost';

function folder(): string {
  return mkdtempSync(join(tmpdir(), 'serva-newproj-'));
}

describe('Serva: New Project, in a real editor', () => {
  it('is registered and reachable with no project open', async () => {
    await activated();
    const registered = await vscode.commands.getCommands(true);
    assert.ok(
      registered.includes('serva.newProject'),
      'the command an owner needs on an empty machine is not there',
    );
    /* The window this suite runs in has no Serva project, which is the whole point. */
    assert.equal(vscode.workspace.workspaceFolders?.length, 1);
    assert.equal(isServaProject(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? ''), false);
  });

  it('creates a real project inside the extension host, verbatim idea and all', async () => {
    await activated();
    const root = folder();
    const created = createProject({ root, name: 'RahalGo', idea: IDEA });

    assert.equal(created.idea, IDEA, 'the Idea was altered somewhere between here and disk');
    assert.equal(isServaProject(root), true);

    const rt = ServaRuntime.open({ root });
    try {
      assert.equal(rt.requireProject().name, 'RahalGo');
      assert.equal(rt.requireProject().idea.text, IDEA);
    } finally {
      rt.close();
    }
  });

  it('refuses the same things here that it refuses anywhere', async () => {
    await activated();
    const root = folder();
    assert.equal(newProjectRefusal({ root, name: '', idea: IDEA })?.field, NewProjectField.NAME);
    assert.equal(newProjectRefusal({ root, name: 'X', idea: '  ' })?.field, NewProjectField.IDEA);

    createProject({ root, name: 'RahalGo', idea: IDEA });
    assert.equal(
      newProjectRefusal({ root, name: 'Second', idea: IDEA })?.field,
      NewProjectField.ROOT,
      'a second company was allowed inside the first',
    );
  });

  it('a refused request leaves the folder untouched', async () => {
    await activated();
    const root = folder();
    const before = readdirSync(root);
    assert.throws(() => createProject({ root, name: '', idea: IDEA }));
    assert.deepEqual(readdirSync(root), before);
    assert.equal(existsSync(join(root, '.serva')), false);
  });

  it('the workspace this suite runs in is still not a project afterwards', async () => {
    /*
     * Creating projects in temporary folders must not leave one behind in the window's own
     * workspace. A suite that quietly turned its host workspace into a project would make
     * every later "with nothing open" assertion meaningless.
     */
    await activated();
    const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    assert.equal(isServaProject(workspace), false);
  });
});
