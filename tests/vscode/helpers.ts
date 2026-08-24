import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { ServaRuntime } from '../../src/app/runtime.js';
import { projectSnapshot } from '../../src/app/services.js';
import { renderControlCenter } from '../../src/extension/render.js';
import { Language } from '../../src/extension/i18n.js';
import type { RenderOptions } from '../../src/extension/render.js';

/**
 * Shared scaffolding for the Extension Host suite.
 *
 * Named `helpers.ts` rather than `*.host.test.ts` deliberately: the runner loads only files
 * matching the test pattern, so this is imported by tests rather than run as one.
 */

/** Activate the extension, exactly as VS Code would when an owner opens a folder. */
export async function activated(): Promise<vscode.Extension<unknown>> {
  const extension = vscode.extensions.all.find((e) => e.packageJSON.name === 'serva-code');
  if (extension === undefined) throw new Error('the Serva extension is not loaded');
  if (!extension.isActive) await extension.activate();
  return extension;
}

/** A real project, on real disk, outside the workspace so tests do not collide. */
export function project(name = 'RahalGo'): ServaRuntime {
  const root = mkdtempSync(join(tmpdir(), 'serva-host-'));
  return ServaRuntime.init(name, 'Stop losing phone orders', { root });
}

/**
 * Render the Control Center into a REAL webview and hand back the document.
 *
 * This is the part only the Extension Host can do. `cspSource` comes from a live webview
 * rather than a string a test invented, the document is assigned to `panel.webview.html`
 * where VS Code parses it, and a policy that VS Code would reject fails here and nowhere
 * else.
 */
export async function renderedInWebview(
  options: Omit<RenderOptions, 'nonce' | 'cspSource' | 'styleUri' | 'scriptUri'>,
): Promise<string> {
  const panel = vscode.window.createWebviewPanel(
    'serva.test',
    'Serva test',
    { viewColumn: vscode.ViewColumn.One, preserveFocus: true },
    { enableScripts: true },
  );
  try {
    const html =
      '<!doctype html><html><head>' +
      renderControlCenter({
        ...options,
        nonce: 'test-nonce',
        cspSource: panel.webview.cspSource,
        styleUri: panel.webview.asWebviewUri(vscode.Uri.file('/style.css')).toString(),
        scriptUri: panel.webview.asWebviewUri(vscode.Uri.file('/panel.js')).toString(),
      }) +
      '</head></html>';
    panel.webview.html = html;
    /* Let the webview process the assignment before the panel is disposed. */
    await new Promise((r) => setTimeout(r, 50));
    return html;
  } finally {
    panel.dispose();
  }
}

export { Language, ServaRuntime, projectSnapshot, vscode };
