import * as assert from 'node:assert/strict';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { ACTIONS, invokeAction } from '../../src/app/actions.js';
import { isServaProject } from '../../src/app/services.js';
import { ServaRuntime } from '../../src/app/runtime.js';
import { activated, project } from './helpers.js';

/**
 * RESTORING ONTO A MACHINE WITH NOTHING OPEN, IN A REAL EDITOR.
 *
 * SPEC: Phase 6 closure §7, §8.
 *
 * This is the fresh-machine case, run in the state it actually happens in: a VS Code window
 * whose folder holds no Serva project at all. The command used to open the Store first and
 * give up here, which meant restore was unreachable in exactly the situation it exists for.
 *
 * The dialogs cannot be driven from a test, so what is proved is everything around them: the
 * command is registered in this projectless window, the action layer accepts a context with
 * no runtime, and every check that stands between a bundle and the disk still stands.
 */

function folder(): string {
  return mkdtempSync(join(tmpdir(), 'serva-restore-'));
}

async function backup(name = 'RahalGo'): Promise<string> {
  const rt = project(name);
  const destination = join(folder(), 'bundle');
  const result = await invokeAction(
    { rt },
    { id: 'backup.create', input: { destination }, confirmed: true },
  );
  assert.equal(result.ok, true, String(result.refusal));
  rt.close();
  return destination;
}

describe('restore, in a window with no project', () => {
  it('the command is registered in this projectless window', async () => {
    await activated();
    const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    assert.equal(isServaProject(workspace), false, 'this window has a project, so it proves less');

    const registered = await vscode.commands.getCommands(true);
    assert.ok(registered.includes('serva.restoreBackup'));
  });

  it('restore and verify declare that they need no open project', async () => {
    await activated();
    assert.equal(ACTIONS.get('restore.inspect')?.needsProject, false);
    assert.equal(ACTIONS.get('restore.perform')?.needsProject, false);
    assert.equal(ACTIONS.get('backup.verify')?.needsProject, false);
  });

  it('inspects and restores a real bundle with no runtime at all', async () => {
    await activated();
    const bundlePath = await backup('RahalGo');
    const destinationRoot = folder();

    const inspection = await invokeAction(
      {},
      { id: 'restore.inspect', input: { bundlePath, destinationRoot } },
    );
    assert.equal(inspection.ok, true, String(inspection.refusal));

    const result = await invokeAction(
      {},
      { id: 'restore.perform', input: { bundlePath, destinationRoot }, confirmed: true },
    );
    assert.equal(result.ok, true, String(result.refusal));

    const landed = (result.data as { restored: { destination: string }[] }).restored[0]
      ?.destination;
    assert.ok(landed !== undefined, 'the restore reported no destination');
    assert.equal(isServaProject(String(landed)), true);

    const restored = ServaRuntime.open({ root: String(landed) });
    try {
      assert.equal(restored.requireProject().name, 'RahalGo');
    } finally {
      restored.close();
    }
  });

  it('the identity in the bundle is the project’s, not a placeholder', async () => {
    await activated();
    const bundlePath = await backup('Mataam');
    const destinationRoot = folder();
    const result = await invokeAction(
      {},
      { id: 'restore.perform', input: { bundlePath, destinationRoot }, confirmed: true },
    );
    const landed = String(
      (result.data as { restored: { destination: string }[] }).restored[0]?.destination,
    );
    /* `PRJ-1` was the literal the panel used to pass, and it must never appear again. */
    assert.ok(!landed.includes('PRJ-1'), 'a placeholder identity survived into a real restore');

    const restored = ServaRuntime.open({ root: landed });
    try {
      assert.equal(restored.requireProject().name, 'Mataam');
      assert.match(restored.requireProject().id, /^SC-PROJ-/);
    } finally {
      restored.close();
    }
  });

  it('still refuses without confirmation, and writes nothing', async () => {
    await activated();
    const bundlePath = await backup();
    const destinationRoot = folder();
    const result = await invokeAction(
      {},
      { id: 'restore.perform', input: { bundlePath, destinationRoot } },
    );
    assert.equal(result.ok, false);
    assert.equal(readdirSync(destinationRoot).length, 0);
  });

  it('an action that reads a project is refused politely, with what to do instead', async () => {
    await activated();
    const result = await invokeAction({}, { id: 'project.snapshot', input: {} });
    assert.equal(result.ok, false);
    assert.match(String(result.refusal), /no Serva project here/);
    assert.match(String(result.refusal), /restore a backup/);
  });
});
