import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { ServaRuntime } from '../../src/app/runtime.js';
import { invokeAction, ACTIONS, ActionConsequence } from '../../src/app/actions.js';
import { ProjectHealth, isServaProject, projectSnapshot } from '../../src/app/services.js';
import { NewProjectField, createProject, newProjectRefusal } from '../../src/app/create.js';
import { parseWebviewMessage, webviewMayInvoke } from '../../src/extension/protocol.js';
import { Language, t } from '../../src/extension/i18n.js';
import { renderControlCenter, statusBarText } from '../../src/extension/render.js';
import { machineDoctor, renderDoctor } from '../../src/portability/doctor.js';
import { nodeDoctorProbes } from '../../src/portability/probes.js';
import type { ProjectSnapshot } from '../../src/app/services.js';

/**
 * THE EXTENSION IS A CLIENT.
 *
 * SPEC: §2, §3, §4, §38, §39, §47.
 *
 * Everything of substance lives in `src/` and is tested by the ordinary suite: the
 * snapshot, the action registry, the message protocol, the renderer. This file is the
 * adapter — it knows about VS Code and nothing about governance.
 *
 * That split is deliberate and it is the reason the security properties are testable at
 * all. An extension whose escaping and dispatch live inside an activation function has
 * security that can only be verified by running VS Code, which means in practice it is
 * verified by hope.
 *
 * Three rules this file follows:
 *
 *   OPENING A FOLDER SPENDS NOTHING. Activation reconstructs state and shows it. It does
 *   not start the company, does not call a model, and does not repair anything.
 *
 *   NOTHING LONG-RUNNING BLOCKS THE HOST. Work happens with progress and cancellation, and
 *   the Store stays authoritative if the window closes mid-operation.
 *
 *   THE PANEL ASKS; SERVA DECIDES. A webview message can only ever name an action that
 *   already exists, and a destructive one is confirmed with a native modal a page cannot
 *   fabricate.
 */

let statusBar: vscode.StatusBarItem | undefined;
let panel: vscode.WebviewPanel | undefined;
let runtime: ServaRuntime | undefined;
/*
 * Set at activation. `handleMessage` needs to repaint the whole surface after a governed
 * mutation, and it has no `context` to build a panel with; without this it repainted the
 * status bar alone, so an answered question stayed on screen looking unanswered.
 */
let refreshEverything: (() => void) | undefined;

function language(): Language {
  const configured = vscode.workspace.getConfiguration('serva').get<string>('language');
  return configured === 'ar' ? Language.AR : Language.EN;
}

/** The project root, or undefined when this window has no Serva project in it. */
function projectRoot(): string | undefined {
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (isServaProject(folder.uri.fsPath)) return folder.uri.fsPath;
  }
  return undefined;
}

/**
 * Open the Store, once, and keep it.
 *
 * Returns undefined rather than throwing when the folder is not a project: an ordinary
 * folder is not an error condition, and a modal on every window that happens to contain
 * one is how an extension gets uninstalled.
 */
function open(): ServaRuntime | undefined {
  if (runtime !== undefined) return runtime;
  const root = projectRoot();
  if (root === undefined) return undefined;
  try {
    runtime = ServaRuntime.open({ root });
    return runtime;
  } catch (e) {
    void vscode.window.showErrorMessage(
      'Serva could not open this project: ' + (e instanceof Error ? e.message : String(e)),
    );
    return undefined;
  }
}

function snapshot(): ProjectSnapshot | undefined {
  const rt = open();
  if (rt === undefined) return undefined;
  try {
    return projectSnapshot(rt, {});
  } catch (e) {
    void vscode.window.showErrorMessage(
      'Serva could not read this project’s state: ' + (e instanceof Error ? e.message : String(e)),
    );
    return undefined;
  }
}

/**
 * The status bar, derived every time.
 *
 * There is no path here that sets a state. The text comes from a snapshot and the snapshot
 * comes from the Store, so an owner reading a tick is reading a governed company rather
 * than a loaded extension.
 */
function refreshStatusBar(): void {
  if (statusBar === undefined) return;
  const current = snapshot();
  if (current === undefined) {
    statusBar.hide();
    return;
  }
  statusBar.text = statusBarText(current, language());
  statusBar.tooltip = current.headline + '\n\n' + current.nextAction;
  statusBar.backgroundColor =
    current.health === ProjectHealth.BLOCKED || current.health === ProjectHealth.RECOVERY_REQUIRED
      ? new vscode.ThemeColor('statusBarItem.errorBackground')
      : current.health === ProjectHealth.OWNER_ACTION ||
          current.health === ProjectHealth.UNQUALIFIED ||
          current.health === ProjectHealth.DIVERGENCE
        ? new vscode.ThemeColor('statusBarItem.warningBackground')
        : undefined;
  statusBar.show();
}

/* --------------------------------------------------------------- the Control Center */

function showControlCenter(context: vscode.ExtensionContext): void {
  const current = snapshot();
  if (current === undefined) {
    void vscode.window.showInformationMessage(t(language(), 'error.notAServaProject'));
    return;
  }

  if (panel === undefined) {
    panel = vscode.window.createWebviewPanel(
      'serva.controlCenter',
      'Serva Code',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        /*
         * The webview may load from the extension's own media directory and nowhere else.
         * Combined with the CSP, that means a project file cannot become a script.
         */
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
        retainContextWhenHidden: false,
      },
    );
    panel.onDidDispose(() => {
      panel = undefined;
    });
    panel.webview.onDidReceiveMessage((raw: unknown) => {
      void handleMessage(raw);
    });
  }

  renderPanel(context);
  panel.reveal();
}

function renderPanel(context: vscode.ExtensionContext): void {
  const current = snapshot();
  if (panel === undefined || current === undefined) return;
  const nonce = randomBytes(16).toString('base64');
  const media = vscode.Uri.joinPath(context.extensionUri, 'media');
  panel.webview.html =
    '<!doctype html><html><head>' +
    renderControlCenter({
      snapshot: current,
      language: language(),
      nonce,
      cspSource: panel.webview.cspSource,
      styleUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'style.css')).toString(),
      scriptUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'panel.js')).toString(),
    }) +
    '</head></html>';
}

/**
 * Handle one message from the panel.
 *
 * Parsed first, allow-listed second, confirmed third. The panel's own `confirmed` flag is
 * accepted only for CONSEQUENTIAL actions; anything destructive is confirmed here with a
 * native modal, because a boolean in a forgeable message is not consent.
 */
async function handleMessage(raw: unknown): Promise<void> {
  const parsed = parseWebviewMessage(raw);
  if (!parsed.ok || parsed.message === undefined) {
    void vscode.window.showWarningMessage('Serva: ' + String(parsed.refusal));
    return;
  }
  const message = parsed.message;
  if (message.kind !== 'INVOKE') {
    if (message.kind === 'REFRESH') void vscode.commands.executeCommand('serva.refresh');
    return;
  }

  if (!webviewMayInvoke(message.actionId)) {
    void vscode.window.showWarningMessage(
      'Serva: "' + message.actionId + '" cannot be run from the panel.',
    );
    return;
  }

  const rt = open();
  if (rt === undefined) return;
  const definition = ACTIONS.get(message.actionId);

  let confirmed = message.confirmed === true;
  if (definition !== undefined && definition.consequence !== ActionConsequence.READ) {
    /*
     * The native modal, not the page's word for it. A webview can set `confirmed` on any
     * message it sends; it cannot make a person click this.
     */
    const answer = await vscode.window.showWarningMessage(
      definition.confirmPrompt ?? definition.title,
      ((): vscode.MessageOptions => {
        const detail = describePayload(message.input);
        return detail === undefined ? { modal: true } : { modal: true, detail };
      })(),
      t(language(), 'common.confirm'),
    );
    confirmed = answer === t(language(), 'common.confirm');
    if (!confirmed) return;
  }

  const result = await invokeAction(
    { rt },
    { id: message.actionId, input: message.input, confirmed },
  );
  panel?.webview.postMessage({
    kind: result.ok ? 'RESULT' : 'ERROR',
    requestId: message.requestId,
    payload: result,
  });
  if (!result.ok) {
    void vscode.window.showWarningMessage(
      t(language(), 'error.actionRefused') + ': ' + String(result.refusal),
    );
    refreshStatusBar();
    return;
  }

  /*
   * A successful mutation changed the Store, so the panel is now describing a company that
   * no longer exists. Drop the runtime handle and repaint everything from disk: an answered
   * decision disappears from the owner-action list, the lifecycle moves, and the tree and
   * status bar agree with the panel because all three read the same fresh snapshot.
   */
  if (definition !== undefined && definition.consequence !== ActionConsequence.READ) {
    runtime = undefined;
    if (refreshEverything !== undefined) {
      refreshEverything();
      return;
    }
  }
  refreshStatusBar();
}

/**
 * What the owner is about to commit, in their own words rather than a schema's.
 *
 * Generic on purpose: it walks the parsed payload instead of knowing about any particular
 * action, so a new action gets a truthful confirmation without anybody remembering to write
 * one. A modal that says "this is consequential" without saying WHAT is a formality; one
 * that shows the value being recorded is a decision.
 */
function describePayload(input: unknown): string | undefined {
  if (input === null || typeof input !== 'object') return undefined;
  const lines = Object.entries(input as Record<string, unknown>)
    .filter(([, v]) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
    .map(([k, v]) => k + ': ' + String(v));
  return lines.length === 0 ? undefined : lines.join('\n');
}

/**
 * `Serva: New Project` — the way a company comes into existence inside VS Code.
 *
 * SPEC: Phase 6 closure §4; 03 §2.
 *
 * It decides nothing. Every rule about what may be created lives in `src/app/create.ts`,
 * which `serva init` calls too, so a project made here is the same project made the same way.
 *
 * Three properties matter more than the sequence of prompts:
 *
 *   THE IDEA IS THE OWNER'S WORDS. It is shown back before creation and recorded verbatim.
 *   Nothing here summarises it, and there is no "improve this" step, because a tidied idea is
 *   no longer the record of what was asked.
 *
 *   REFUSALS ARRIVE WHERE THEY BELONG. Each answer is validated as it is given, so an owner
 *   is told the folder already holds a project before they have written a paragraph into it.
 *
 *   CANCELLING LEAVES NOTHING BEHIND. Every step can be escaped, and creation happens once,
 *   at the end, after an explicit confirmation.
 */
async function newProjectCommand(): Promise<void> {
  const lang = language();
  const T = (key: Parameters<typeof t>[1]): string => t(lang, key);

  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: T('newProject.folderLabel'),
    title: T('newProject.chooseFolder'),
    ...(vscode.workspace.workspaceFolders?.[0] === undefined
      ? {}
      : { defaultUri: vscode.workspace.workspaceFolders[0].uri }),
  });
  const folder = picked?.[0];
  if (folder === undefined) return;
  const root = folder.fsPath;

  const rootRefusal = newProjectRefusal({ root }, NewProjectField.ROOT);
  if (rootRefusal !== undefined) {
    void vscode.window.showWarningMessage('Serva: ' + rootRefusal.message, {
      modal: true,
      detail: rootRefusal.remedy,
    });
    return;
  }

  const name = await vscode.window.showInputBox({
    title: T('newProject.title'),
    prompt: T('newProject.namePrompt'),
    placeHolder: T('newProject.namePlaceholder'),
    ignoreFocusOut: true,
    validateInput: (value) => newProjectRefusal({ name: value }, NewProjectField.NAME)?.message,
  });
  if (name === undefined) return;

  const idea = await vscode.window.showInputBox({
    title: T('newProject.title'),
    prompt: T('newProject.ideaPrompt'),
    placeHolder: T('newProject.ideaPlaceholder'),
    ignoreFocusOut: true,
    validateInput: (value) => newProjectRefusal({ idea: value }, NewProjectField.IDEA)?.message,
  });
  if (idea === undefined) return;

  /*
   * The last thing the owner sees before it becomes permanent is their own idea, unedited.
   * A confirmation that summarises what it is about to record would be confirming something
   * other than what gets written.
   */
  const confirm = await vscode.window.showInformationMessage(
    T('newProject.confirm'),
    {
      modal: true,
      detail:
        name.trim() + '\n' + root + '\n\n' + idea.trim() + '\n\n' + T('newProject.ideaVerbatim'),
    },
    T('common.confirm'),
  );
  if (confirm !== T('common.confirm')) {
    void vscode.window.showInformationMessage('Serva: ' + T('newProject.cancelled'));
    return;
  }

  let created;
  try {
    created = createProject({ root, name, idea });
  } catch (error) {
    const e = error as Error & { remedy?: string };
    void vscode.window.showWarningMessage(
      'Serva: ' + e.message,
      ...(e.remedy === undefined ? [] : ([{ modal: true, detail: e.remedy }] as never[])),
    );
    return;
  }

  const openIt = await vscode.window.showInformationMessage(
    T('newProject.created') + ': ' + created.name + ' (' + created.projectId + ')',
    T('newProject.openFolder'),
    T('newProject.stayHere'),
  );
  if (openIt === T('newProject.openFolder')) {
    /*
     * Opening the folder replaces this window's workspace, which ends this extension host.
     * Nothing may be scheduled after it.
     */
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(created.root), {
      forceNewWindow: false,
    });
    return;
  }
  if (refreshEverything !== undefined) refreshEverything();
}

/* ------------------------------------------------------------------- the tree view */

class CompanyTree implements vscode.TreeDataProvider<string> {
  private readonly emitter = new vscode.EventEmitter<string | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  refresh(): void {
    this.emitter.fire(undefined);
  }

  getTreeItem(element: string): vscode.TreeItem {
    const item = new vscode.TreeItem(element, vscode.TreeItemCollapsibleState.None);
    item.command = { command: 'serva.openControlCenter', title: 'Open' };
    return item;
  }

  getChildren(): string[] {
    const current = snapshot();
    if (current === undefined) return [t(language(), 'error.notAServaProject')];
    return [
      current.headline,
      t(language(), 'overview.nextAction') + ': ' + current.nextAction,
      t(language(), 'nav.ownerActions') + ': ' + String(current.ownerActions.length),
      t(language(), 'release.status') + ': ' + current.release.status,
      t(language(), 'machine.qualification') + ': ' + current.machine.state,
    ];
  }
}

/* -------------------------------------------------------------------- activation */

export function activate(context: vscode.ExtensionContext): void {
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.command = 'serva.openControlCenter';
  context.subscriptions.push(statusBar);

  const tree = new CompanyTree();
  context.subscriptions.push(vscode.window.registerTreeDataProvider('serva.company', tree));

  const refreshAll = (): void => {
    refreshStatusBar();
    tree.refresh();
    if (panel !== undefined) renderPanel(context);
  };
  refreshEverything = refreshAll;

  context.subscriptions.push(
    vscode.commands.registerCommand('serva.newProject', () => {
      void newProjectCommand();
    }),
    vscode.commands.registerCommand('serva.openControlCenter', () => {
      showControlCenter(context);
    }),
    vscode.commands.registerCommand('serva.refresh', () => {
      /*
       * A refresh REOPENS the Store rather than reusing the handle. The point of a refresh
       * after an external change is to read what is actually on disk.
       */
      runtime = undefined;
      refreshAll();
    }),
    vscode.commands.registerCommand('serva.answerDecision', async () => {
      const rt = open();
      if (rt === undefined) return;
      const current = snapshot();
      const open_ = current?.ownerActions ?? [];
      if (open_.length === 0) {
        void vscode.window.showInformationMessage(t(language(), 'overview.nothingWaiting'));
        return;
      }
      /*
       * The command palette route to the same governed action. It opens the Control
       * Center rather than answering inline: an owner decision deserves the recommendation
       * and the consequences in front of it, not a one-line quick pick.
       */
      showControlCenter(context);
    }),
    vscode.commands.registerCommand('serva.machineDoctor', () => {
      const report = machineDoctor({ probes: nodeDoctorProbes() });
      const channel = vscode.window.createOutputChannel('Serva Doctor');
      channel.clear();
      channel.appendLine(renderDoctor(report));
      channel.show();
    }),
    vscode.commands.registerCommand('serva.releaseReadiness', async () => {
      const rt = open();
      if (rt === undefined) return;
      const result = await invokeAction({ rt }, { id: 'release.readiness' });
      void vscode.window.showInformationMessage('Serva: ' + result.summary);
    }),
    vscode.commands.registerCommand('serva.coverage', async () => {
      const rt = open();
      if (rt === undefined) return;
      const result = await invokeAction({ rt }, { id: 'coverage.report' });
      void vscode.window.showInformationMessage('Serva: ' + result.summary);
    }),
    vscode.commands.registerCommand('serva.createBackup', async () => {
      const rt = open();
      if (rt === undefined) return;
      const destination = await vscode.window.showInputBox({
        prompt: 'Where should the verified backup be written?',
        value: vscode.workspace.getConfiguration('serva').get<string>('backupLocation') ?? '',
      });
      if (destination === undefined || destination.trim() === '') return;
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Serva: creating a verified backup',
        },
        async () => {
          const result = await invokeAction(
            { rt },
            {
              id: 'backup.create',
              input: { projectId: 'PRJ-1', name: 'project', destination },
              confirmed: true,
            },
          );
          void vscode.window.showInformationMessage('Serva: ' + (result.refusal ?? result.summary));
        },
      );
    }),
    vscode.commands.registerCommand('serva.restoreBackup', async () => {
      const rt = open();
      if (rt === undefined) return;
      const picked = await vscode.window.showOpenDialog({
        canSelectFolders: true,
        canSelectFiles: false,
        openLabel: 'Inspect this backup',
      });
      const bundlePath = picked?.[0]?.fsPath;
      if (bundlePath === undefined) return;

      const inspection = await invokeAction(
        { rt },
        { id: 'restore.inspect', input: { bundlePath, destinationRoot: rt.root } },
      );
      /*
       * INSPECT, SHOW, THEN ASK. The owner sees what would happen — including what will
       * NOT come back — before anything is written.
       */
      const proceed = await vscode.window.showWarningMessage(
        inspection.summary,
        { modal: true, detail: String(inspection.refusal ?? '') },
        'Restore',
      );
      if (proceed !== 'Restore') return;
      const result = await invokeAction(
        { rt },
        {
          id: 'restore.perform',
          input: { bundlePath, destinationRoot: rt.root },
          confirmed: true,
        },
      );
      void vscode.window.showInformationMessage('Serva: ' + (result.refusal ?? result.summary));
      refreshAll();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('serva')) refreshAll();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      runtime = undefined;
      refreshAll();
    }),
  );

  refreshAll();
}

export function deactivate(): void {
  statusBar?.dispose();
  panel?.dispose();
  runtime = undefined;
}
