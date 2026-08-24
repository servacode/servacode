import { z } from 'zod';
import { ACTIONS } from '../app/actions.js';

/**
 * THE WEBVIEW PROTOCOL — A BROWSER IS TALKING TO A HIGH-AUTHORITY PROCESS.
 *
 * SPEC: §47, §48.
 *
 * The Control Center is a webview. That means it is a browser, its messages are strings
 * somebody could forge, and the content it renders comes from a project directory that may
 * have been cloned from anywhere. On the other side of the message channel sits a process
 * that can answer owner decisions, restore over a project, and read the whole Store.
 *
 * So the channel is narrow by construction. There are exactly three message kinds, each
 * parsed by a schema before anything reads a field, and the only one that can cause an
 * effect names an action that must already exist in the registry.
 *
 * `postMessage` is not authentication. A page inside the webview — including anything an
 * injected script managed to run — can send any of these. That is why the protocol grants
 * nothing on its own: the strongest thing a forged message achieves is invoking an action
 * that the action layer will then validate, confirm and possibly refuse.
 */

/** Messages the panel may send to the extension host. */
export const WebviewMessageSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('READY'),
    })
    .strict(),
  z
    .object({
      kind: z.literal('REFRESH'),
    })
    .strict(),
  z
    .object({
      kind: z.literal('INVOKE'),
      /** Correlates the reply. Opaque to the host, and never used as authority. */
      requestId: z.string().min(1).max(64),
      actionId: z.string().min(1).max(120),
      input: z.unknown().optional(),
      /**
       * Set by the panel AFTER showing the confirmation prompt.
       *
       * A boolean in a message a page could forge, which is exactly why it is not the
       * only protection: the action layer refuses without it, and a genuinely destructive
       * action ALSO goes through a native VS Code modal that a webview cannot fabricate.
       */
      confirmed: z.boolean().optional(),
    })
    .strict(),
]);
export type WebviewMessage = z.output<typeof WebviewMessageSchema>;

/** Messages the extension host sends to the panel. */
export interface HostMessage {
  readonly kind: 'STATE' | 'RESULT' | 'ERROR';
  readonly requestId?: string;
  readonly payload: unknown;
}

export interface ParsedMessage {
  readonly ok: boolean;
  readonly message?: WebviewMessage;
  readonly refusal?: string;
}

/**
 * Parse a message from the panel.
 *
 * Non-throwing, because a malformed message is expected input rather than an exception: a
 * stale panel after an upgrade sends the old shape, and the honest response is to say so
 * rather than to crash the extension host.
 */
export function parseWebviewMessage(raw: unknown): ParsedMessage {
  const parsed = WebviewMessageSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      refusal:
        'The panel sent a message Serva does not accept: ' +
        parsed.error.issues
          .slice(0, 2)
          .map((i) => (i.path.join('.') === '' ? i.message : i.path.join('.') + ' ' + i.message))
          .join('; '),
    };
  }
  if (parsed.data.kind === 'INVOKE' && !ACTIONS.has(parsed.data.actionId)) {
    /*
     * Checked here as well as in the action layer. Not redundancy for its own sake: this
     * is the boundary where an unknown id should stop being a string at all, and failing
     * early keeps a forged id out of every log line downstream.
     */
    return {
      ok: false,
      refusal:
        'The panel asked for "' +
        parsed.data.actionId +
        '", which is not a Serva action. Dispatch is by exact id against a fixed table.',
    };
  }
  return { ok: true, message: parsed.data };
}

/**
 * Actions a webview may invoke at all.
 *
 * A separate, smaller list than the registry. Some actions are perfectly reasonable from a
 * terminal and have no business being reachable from a page: restoring over a project is
 * the clearest, because the destination is a path and a page should never be the thing
 * that chose it.
 */
export const WEBVIEW_INVOCABLE: ReadonlySet<string> = new Set([
  'project.snapshot',
  'release.readiness',
  'coverage.report',
  'reconcile.inspect',
  'reconcile.repair',
  'conversation.read',
  'conversation.send',
  'owner.answer',
  'backup.verify',
  'restore.inspect',
  'migration.plan',
]);

/** Is this action reachable from the panel? Destructive paths are host-only. */
export function webviewMayInvoke(actionId: string): boolean {
  return WEBVIEW_INVOCABLE.has(actionId);
}
