import { z } from 'zod';
import { fail } from '../core/errors.js';
import { answerOwnerDecision } from '../intelligence/app.js';
import { projectSnapshot } from './services.js';
import { assessReleaseReadiness } from '../intelligence/releaseReadiness.js';
import { coverageSummary, gateCoverage, lifecycleCoverage } from '../coverage/index.js';
import { createBackup, verifyBackup } from '../portability/backup.js';
import { inspectRestore, performRestore } from '../portability/restore.js';
import { planMigration } from '../portability/migration.js';
import type { ServaRuntime } from './runtime.js';

/**
 * EVERY CONSEQUENTIAL ACTION IS A VALIDATED COMMAND. UI STATE IS NEVER AUTHORITY.
 *
 * SPEC: §47, §48, §2, §49.
 *
 * The extension turns Serva into a high-authority local surface: a panel that can answer an
 * owner decision, restore a project over another one, or approve a release. A webview is a
 * browser, its messages are strings, and a project file can put HTML on a screen. So the
 * boundary between "the UI asked" and "Serva did" has to be a real one.
 *
 * This registry is that boundary. Three properties, and none of them is optional:
 *
 *   AN ACTION EXISTS OR IT DOES NOT. Dispatch is by id against this table. There is no
 *   path from a message to a function name, no `rt[method]`, and no eval-shaped anything —
 *   a forged message can only ever name an action that already exists.
 *
 *   THE INPUT IS PARSED, NOT CAST. Every action declares a Zod schema and the payload is
 *   validated before the handler sees it. A webview message is untrusted input in exactly
 *   the sense a captured web page is.
 *
 *   CONSEQUENCE IS DECLARED, AND CONFIRMATION IS NOT INFERRED. An action that changes
 *   project truth, overwrites a project, or authorises something carries `consequential`
 *   and refuses without an explicit confirmation token from the caller. A UI that had
 *   already shown a dialog cannot skip it by remembering that it did.
 *
 * What this deliberately does NOT contain is an action that sets a status, marks a gate,
 * or declares readiness. Those are derived, and an action that could set one would make
 * every derivation decorative.
 */

export const ActionConsequence = {
  /** Reads. Safe to run whenever a panel refreshes. */
  READ: 'READ',
  /** Changes project truth or governance state. Needs explicit confirmation. */
  CONSEQUENTIAL: 'CONSEQUENTIAL',
  /** Destroys or replaces something. Needs confirmation and says what is at stake. */
  DESTRUCTIVE: 'DESTRUCTIVE',
} as const;
export type ActionConsequence = (typeof ActionConsequence)[keyof typeof ActionConsequence];

export interface ActionContext {
  readonly rt: ServaRuntime;
  /**
   * The person, for actions that record who decided.
   *
   * Never an agent id. `answerOwnerDecision` refuses one, and this is the layer where a
   * UI could most easily supply the wrong thing.
   */
  readonly actor?: string;
}

export interface ActionResult {
  readonly ok: boolean;
  readonly summary: string;
  readonly data?: unknown;
  /** Present when the action was refused rather than failed. */
  readonly refusal?: string;
}

export interface ActionDefinition<S extends z.ZodTypeAny = z.ZodTypeAny> {
  readonly id: string;
  readonly title: string;
  readonly consequence: ActionConsequence;
  /** Shown before a consequential action runs. Required for anything but READ. */
  readonly confirmPrompt?: string;
  readonly schema: S;
  handler(ctx: ActionContext, input: z.output<S>): Promise<ActionResult> | ActionResult;
}

const empty = z.object({}).strict();

/* ------------------------------------------------------------------- the registry */

const DEFINITIONS: readonly ActionDefinition[] = Object.freeze([
  {
    id: 'project.snapshot',
    title: 'Read the project state',
    consequence: ActionConsequence.READ,
    schema: z
      .object({
        workItemId: z.string().min(1).optional(),
        divergence: z.boolean().optional(),
        recoveryRequired: z.boolean().optional(),
      })
      .strict(),
    handler: (ctx, input) => {
      const snapshot = projectSnapshot(ctx.rt, input);
      return { ok: true, summary: snapshot.headline, data: snapshot };
    },
  } as ActionDefinition<z.ZodTypeAny>,

  {
    id: 'release.readiness',
    title: 'Assess release readiness',
    consequence: ActionConsequence.READ,
    schema: empty,
    handler: (ctx) => {
      const readiness = assessReleaseReadiness({ store: ctx.rt.store, clock: ctx.rt.clock });
      return { ok: true, summary: readiness.summary, data: readiness };
    },
  } as ActionDefinition<z.ZodTypeAny>,

  {
    id: 'coverage.report',
    title: 'Read lifecycle and gate coverage',
    consequence: ActionConsequence.READ,
    schema: empty,
    handler: () => {
      const summary = coverageSummary();
      return {
        ok: true,
        summary:
          'stages ' +
          String(summary.stages.covered) +
          '/' +
          String(summary.stages.total) +
          ', gates ' +
          String(summary.gates.implemented) +
          '/' +
          String(summary.gates.total),
        data: { summary, stages: lifecycleCoverage(), gates: gateCoverage() },
      };
    },
  } as ActionDefinition<z.ZodTypeAny>,

  {
    id: 'owner.answer',
    title: 'Answer an owner decision',
    consequence: ActionConsequence.CONSEQUENTIAL,
    confirmPrompt:
      'This records a decision as project truth. Departments will proceed on it and it will be cited later.',
    schema: z
      .object({
        decisionId: z.string().min(1),
        /* Exactly one of these. `answerRefusal` decides which the question requires. */
        chosenOption: z.string().min(1).optional(),
        value: z.string().min(1).optional(),
        answeredBy: z.string().min(1),
      })
      .strict(),
    handler: (ctx, input) => {
      /*
       * Straight through to the governed function, which refuses an agent answering, a
       * free-text answer to an OPTION question and a meta-option answer to a VALUE one.
       * Re-implementing any of that here would be a second opinion about consent.
       */
      answerOwnerDecision(
        {
          store: ctx.rt.store,
          clock: ctx.rt.clock,
          ids: ctx.rt.ids,
          engine: undefined as never,
          projectRoot: ctx.rt.root,
        },
        {
          decisionId: input.decisionId,
          ...(input.chosenOption === undefined ? {} : { chosenOption: input.chosenOption }),
          ...(input.value === undefined ? {} : { value: input.value }),
          answeredBy: input.answeredBy,
        },
      );
      return { ok: true, summary: 'Decision ' + input.decisionId + ' recorded.' };
    },
  } as ActionDefinition<z.ZodTypeAny>,

  {
    id: 'backup.create',
    title: 'Create a verified backup',
    consequence: ActionConsequence.CONSEQUENTIAL,
    confirmPrompt: 'This writes a full copy of the project to the destination you chose.',
    schema: z
      .object({
        projectId: z.string().min(1),
        name: z.string().min(1),
        destination: z.string().min(1),
      })
      .strict(),
    handler: (ctx, input) => {
      const result = createBackup(
        { clock: ctx.rt.clock },
        {
          projects: [{ projectId: input.projectId, name: input.name, root: ctx.rt.root }],
          destination: input.destination,
        },
      );
      return { ok: result.verified, summary: result.summary, data: result.manifest };
    },
  } as ActionDefinition<z.ZodTypeAny>,

  {
    id: 'backup.verify',
    title: 'Verify a backup',
    consequence: ActionConsequence.READ,
    schema: z.object({ bundlePath: z.string().min(1) }).strict(),
    handler: (_ctx, input) => {
      const result = verifyBackup(input.bundlePath);
      return { ok: result.ok, summary: result.summary, data: result };
    },
  } as ActionDefinition<z.ZodTypeAny>,

  {
    id: 'restore.inspect',
    title: 'Inspect a backup before restoring',
    consequence: ActionConsequence.READ,
    schema: z
      .object({ bundlePath: z.string().min(1), destinationRoot: z.string().min(1) })
      .strict(),
    handler: (_ctx, input) => {
      const inspection = inspectRestore(input);
      return { ok: inspection.ok, summary: inspection.summary, data: inspection };
    },
  } as ActionDefinition<z.ZodTypeAny>,

  {
    id: 'restore.perform',
    title: 'Restore a backup',
    consequence: ActionConsequence.DESTRUCTIVE,
    confirmPrompt:
      'Restoring writes a whole project tree. Anything already at the destination is moved aside, and this machine will still need to be qualified before engineering can run.',
    schema: z
      .object({
        bundlePath: z.string().min(1),
        destinationRoot: z.string().min(1),
        overwrite: z.boolean().optional(),
      })
      .strict(),
    handler: (_ctx, input) => {
      const result = performRestore(input);
      return { ok: true, summary: result.summary, data: result };
    },
  } as ActionDefinition<z.ZodTypeAny>,

  {
    id: 'migration.plan',
    title: 'Plan a schema migration',
    consequence: ActionConsequence.READ,
    schema: z
      .object({
        formatVersion: z.number().int().positive(),
        storeSchemaVersion: z.number().int().positive().optional(),
      })
      .strict(),
    handler: (_ctx, input) => {
      const plan = planMigration(input.formatVersion, input.storeSchemaVersion);
      return { ok: plan.outcome !== 'UNSUPPORTED', summary: plan.explanation, data: plan };
    },
  } as ActionDefinition<z.ZodTypeAny>,
]);

export const ACTIONS: ReadonlyMap<string, ActionDefinition> = new Map(
  DEFINITIONS.map((d) => [d.id, d]),
);

/** Everything a client may invoke, with what each one costs. Used to build a UI safely. */
export function actionCatalogue(): readonly {
  readonly id: string;
  readonly title: string;
  readonly consequence: ActionConsequence;
  readonly confirmPrompt?: string;
}[] {
  return DEFINITIONS.map((d) => ({
    id: d.id,
    title: d.title,
    consequence: d.consequence,
    ...(d.confirmPrompt === undefined ? {} : { confirmPrompt: d.confirmPrompt }),
  }));
}

export interface InvokeRequest {
  readonly id: string;
  readonly input?: unknown;
  /**
   * Explicit confirmation for a consequential action.
   *
   * A boolean the CALLER sets after showing the prompt. It is not remembered, not
   * defaulted and not inferred from a previous call — a UI that has already asked cannot
   * skip asking again, which is the only way the check survives a refactor of the UI.
   */
  readonly confirmed?: boolean;
}

/**
 * Run one action, or refuse.
 *
 * Refusals are RESULTS rather than exceptions, because every one of them is something the
 * owner needs shown: an unknown action means the client is out of date, a validation
 * failure means the payload was wrong, and a missing confirmation means somebody tried to
 * skip a step. A thrown error would become a red toast that says "something went wrong".
 */
export async function invokeAction(
  ctx: ActionContext,
  request: InvokeRequest,
): Promise<ActionResult> {
  const definition = ACTIONS.get(request.id);
  if (definition === undefined) {
    return {
      ok: false,
      summary: 'No such action',
      refusal:
        'Serva has no action named "' +
        request.id +
        '". Dispatch is by exact id against a fixed table, so a message can only ever name something that already exists.',
    };
  }

  const parsed = definition.schema.safeParse(request.input ?? {});
  if (!parsed.success) {
    return {
      ok: false,
      summary: 'Invalid input for ' + definition.id,
      refusal:
        'The payload does not match what ' +
        definition.id +
        ' accepts: ' +
        parsed.error.issues
          .slice(0, 3)
          .map((i) => (i.path.join('.') === '' ? i.message : i.path.join('.') + ' ' + i.message))
          .join('; '),
    };
  }

  if (definition.consequence !== ActionConsequence.READ && request.confirmed !== true) {
    return {
      ok: false,
      summary: 'Confirmation required',
      refusal:
        definition.confirmPrompt ??
        'This action changes project truth and needs explicit confirmation.',
    };
  }

  try {
    return await definition.handler(ctx, parsed.data);
  } catch (e) {
    /*
     * A governed refusal — an agent answering an owner decision, a restore over another
     * project — arrives here as a thrown ServaError with a remedy on it. Turning it into a
     * result preserves that remedy instead of flattening it into a stack trace.
     */
    /*
     * The remedy travels with the message. A governed refusal says what happened AND what
     * to do instead, and dropping the second half is how a precise refusal becomes a red
     * toast that says something went wrong.
     */
    const message = e instanceof Error ? e.message : String(e);
    const remedy = (e as { readonly remedy?: unknown })?.remedy;
    return {
      ok: false,
      summary: definition.title + ' was refused',
      refusal: typeof remedy === 'string' ? message + ' — ' + remedy : message,
    };
  }
}

/** Assert an id exists. Used by the CLI so a typo fails at parse rather than at dispatch. */
export function requireAction(id: string): ActionDefinition {
  const definition = ACTIONS.get(id);
  if (definition === undefined) {
    return fail({
      code: 'E_VALIDATION',
      message: 'Unknown Serva action: ' + id,
      remedy: 'Run `serva actions` to list what exists.',
      details: { known: [...ACTIONS.keys()] },
      specRef: '§49',
    });
  }
  return definition;
}
