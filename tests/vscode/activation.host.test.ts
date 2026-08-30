import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { SERVA_VERSION } from '../../src/portability/version.js';

/**
 * THE EXTENSION ACTUALLY LOADS, AND ITS COMMANDS ACTUALLY EXIST.
 *
 * SPEC: Phase 6 closure §8.
 *
 * This is the test that would have caught the defect the whole unit suite could not: the
 * manifest pointed `main` at `./dist/extension.js` and the compiler emitted
 * `./dist/extension/src/extension.js`. Every renderer test, protocol test and action test was
 * green, and the extension could not have activated on any machine on earth.
 *
 * So the first assertions here are the boring ones. They are the ones that were missing.
 */

const EXTENSION_ID = 'serva.serva-code';

/** Give VS Code a moment to finish an activation it has already started. */
async function activate(): Promise<vscode.Extension<unknown>> {
  const extension = vscode.extensions.all.find((e) => e.packageJSON.name === 'serva-code');
  assert.ok(
    extension !== undefined,
    'the Serva extension is not loaded at all; VS Code did not find it under the development path',
  );
  if (!extension.isActive) await extension.activate();
  return extension;
}

describe('the extension loads in a real VS Code', () => {
  it('is present, and its entry point resolves', async () => {
    const extension = await activate();
    /*
     * `activate()` above throws if `main` names a file that is not there — which it did,
     * for the whole of Phase 6, without one unit test noticing.
     */
    assert.equal(extension.isActive, true, 'the extension did not activate');
  });

  it('declares the version the package claims', async () => {
    /*
     * Against SERVA_VERSION rather than a literal.
     *
     * SPEC: the 1.0.1 packaging audit, section F.
     *
     * This read `'1.0.0'`, so it did not assert version identity at all — it asserted that
     * nobody had shipped a new version yet, and it failed the moment one was. A test that has
     * to be hand-edited on every release is a test that will one day be hand-edited to match
     * whatever the code happens to say.
     */
    const extension = await activate();
    assert.equal(String(extension.packageJSON.version), SERVA_VERSION);
  });

  it('registers every command it contributes', async () => {
    const extension = await activate();
    const contributed = (extension.packageJSON.contributes.commands as { command: string }[]).map(
      (c) => c.command,
    );
    const registered = await vscode.commands.getCommands(true);

    for (const command of contributed) {
      assert.ok(
        registered.includes(command),
        command + ' is contributed in package.json but never registered at runtime',
      );
    }
    /* And the two the closure added specifically. */
    assert.ok(contributed.includes('serva.newProject'));
    assert.ok(contributed.includes('serva.openControlCenter'));
  });

  it('activates without a project open, so New Project and Restore are reachable', async () => {
    /*
     * The window this suite runs in has no Serva project in it. If activation required one,
     * everything above would have failed — which is the point: an owner's first machine has
     * no project on it either.
     */
    const extension = await activate();
    assert.equal(extension.isActive, true);
    const registered = await vscode.commands.getCommands(true);
    assert.ok(registered.includes('serva.newProject'));
    assert.ok(registered.includes('serva.restoreBackup'));
  });

  it('does not throw when asked to refresh with nothing open', async () => {
    await activate();
    /*
     * An ordinary folder is not an error condition. A modal on every window that happens to
     * contain one is how an extension gets uninstalled.
     */
    await vscode.commands.executeCommand('serva.refresh');
  });
});

export { EXTENSION_ID };
