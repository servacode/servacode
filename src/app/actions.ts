import { z } from 'zod';
import { fail } from '../core/errors.js';
import { answerOwnerDecision } from '../intelligence/app.js';
import { projectSnapshot } from './services.js';
import { conversationTranscript, sendOwnerRequest } from './conversation.js';
import { reconciliationView, repairBookkeeping } from './reconciliation.js';
import { buildEngineeringLayer, engineeringReconcile } from './engineering.js';
import { buildAiLayer } from './ai.js';
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
 *   and refuses unless the caller confirms on this call. A UI that had already shown a
 *   dialog cannot skip it by remembering that it did.
 *
 *   WHAT CONFIRMATION IS NOT. SPEC: finding AAA-CONFIRM-1 (MEDIUM), 1.0.1 security review.
 *
 *   This said "an explicit confirmation token", and a token is what it is not: `confirmed`
 *   is a boolean on the request, so a forged or injected message can carry `confirmed: true`
 *   as easily as it carries the action id. Against a compromised webview it defends nothing,
 *   and the two properties above were the ones doing that work all along - dispatch by id
 *   against this table, and a schema that parses rather than casts. Confirmation defends
 *   against INFERENCE, which is a different and real failure: a UI deciding on the owner's
 *   behalf that asking once was enough.
 *
 *   Narrowed rather than fixed, because the fix is not here. A claim of anti-forgery would
 *   need the confirmation minted outside the webview - by the extension host, bound to this
 *   action and this payload - and until that exists, saying "token" would leave a reader
 *   believing a protection that is not in the code.
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
  /**
   * The open project.
   *
   * Optional, because a few actions genuinely have nothing to read it from. Restoring a
   * backup onto a fresh machine happens in an EMPTY folder: there is no project yet, and
   * that is the entire situation restore exists for. Requiring a runtime here meant the
   * extension bailed out before the dialog opened, so the one machine state where restore
   * matters most was the one where it could not be reached.
   *
   * Every action that needs it declares `needsProject` and is refused politely without one,
   * so the optionality never reaches a handler as an undefined surprise.
   */
  readonly rt?: ServaRuntime;
  /*
   * THERE IS NO `actor` FIELD HERE, DELIBERATELY.
   *
   * SPEC: finding APPLICATION-ACTION-AUTHORITY/AAA-1 (MEDIUM), 1.0.1 security review.
   *
   * One used to exist, documented as the trusted person — 'never an agent id... the layer
   * where a UI could most easily supply the wrong thing'. No caller ever set it and no handler
   * ever read it. A field that names itself a trust anchor and is filled by nobody is worse
   * than no field: it invites the next handler to trust `undefined`, and it invites a reader
   * to believe an identity was checked here when nothing was.
   *
   * The rule it claimed to carry is real and is enforced where the write happens:
   * `answerOwnerDecision` refuses any answerer whose id begins SC-AGENT- or SC-RUN-, and
   * `ownerDecisionRefusal` refuses a stored agent answer on every read. This layer has no
   * independent source of person-identity to add — Serva runs as the owner — so asserting one
   * here would be a check that agrees with whatever it is handed.
   */
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
  /**
   * Whether this action reads or writes an open project. Defaults to true.
   *
   * Declared rather than inferred from whether the handler happens to touch `ctx.rt`: an
   * action that stops using the runtime during a refactor would otherwise silently become
   * available in a folder with no project in it.
   */
  readonly needsProject?: boolean;
  /** Shown before a consequential action runs. Required for anything but READ. */
  readonly confirmPrompt?: string;
  readonly schema: S;
  handler(
    ctx: ActionContext & { readonly rt: ServaRuntime },
    input: z.output<S>,
  ): Promise<ActionResult> | ActionResult;
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
    id: 'conversation.read',
    title: 'Read the conversation with Serva',
    consequence: ActionConsequence.READ,
    schema: empty,
    handler: (ctx) => {
      const turns = conversationTranscript(ctx.rt);
      return {
        ok: true,
        summary: String(turns.length) + ' turn(s)',
        data: turns,
      };
    },
  } as ActionDefinition<z.ZodTypeAny>,

  {
    id: 'conversation.send',
    title: 'Ask Serva for something',
    consequence: ActionConsequence.CONSEQUENTIAL,
    confirmPrompt:
      'This asks the company to classify and plan your request. It records what you asked verbatim and may queue governed work.',
    schema: z
      .object({
        text: z.string().min(1),
        /* Join existing work rather than opening new work, when the surface knows which. */
        workItemId: z.string().min(1).optional(),
      })
      .strict(),
    handler: async (ctx, input) => {
      /*
       * The ONLY path from owner text to the engine, and it goes through the orchestrator.
       * There is deliberately no action here that invokes the adapter with what the owner
       * typed: that would be a chat box, and a chat box has no departments, no gates and no
       * canon it is allowed to write.
       */
      const layer = buildAiLayer(ctx.rt);
      const turn = await sendOwnerRequest(ctx.rt, input.text, {
        orchestrator: layer.orchestrator,
        ...(input.workItemId === undefined ? {} : { workItemId: input.workItemId }),
      });
      return {
        ok: turn.outcome !== 'REFUSED',
        summary:
          turn.outcome === 'QUEUED'
            ? 'Queued ' + String(turn.queued.length) + ' department(s).'
            : turn.outcome === 'HALTED'
              ? 'Serva stopped at ' + String(turn.stage) + '.'
              : 'Serva could not begin.',
        ...(turn.haltReason === undefined ? {} : { refusal: turn.haltReason }),
        data: turn,
      };
    },
  } as ActionDefinition<z.ZodTypeAny>,

  {
    id: 'reconcile.inspect',
    title: 'Compare Serva’s records with the repository',
    consequence: ActionConsequence.READ,
    schema: empty,
    handler: async (ctx) => {
      const layer = await buildEngineeringLayer(ctx.rt);
      const view = reconciliationView(await engineeringReconcile(ctx.rt, layer));
      return { ok: true, summary: view.headline, data: view };
    },
  } as ActionDefinition<z.ZodTypeAny>,

  {
    id: 'reconcile.repair',
    title: 'Correct Serva’s own records',
    consequence: ActionConsequence.CONSEQUENTIAL,
    confirmPrompt:
      'This corrects Serva’s own bookkeeping so it matches the repository. It does not revert, stash or clean anything in your working tree.',
    schema: empty,
    handler: async (ctx) => {
      /*
       * Re-detected here rather than taking a view from the caller. A view is a snapshot of
       * the world at a moment, and repairing against a stale one would mean acting on a
       * repository that has since changed — which is the exact failure this whole module is
       * about.
       */
      const layer = await buildEngineeringLayer(ctx.rt);
      const view = reconciliationView(await engineeringReconcile(ctx.rt, layer));
      const result = repairBookkeeping(ctx.rt, view);
      return { ok: true, summary: result.summary, data: result };
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
    /*
     * THE CALLER SAYS WHERE, NOT WHAT.
     *
     * SPEC: Phase 6 closure §7.
     *
     * This action used to accept `projectId` and `name` from whoever invoked it, and the
     * extension passed the literals `PRJ-1` and `project`. Every backup made from the panel
     * was therefore filed under an identity belonging to no project — and the failure was
     * silent, because a manifest with a plausible id in it looks exactly like a correct one
     * until somebody tries to restore onto a machine holding two of them.
     *
     * A caller cannot get the identity wrong if it is not asked for it. It is read from the
     * Store, which is the only thing that knows.
     */
    schema: z.object({ destination: z.string().min(1) }).strict(),
    handler: (ctx, input) => {
      const project = ctx.rt.requireProject();
      const result = createBackup(
        { clock: ctx.rt.clock },
        {
          projects: [{ projectId: project.id, name: project.name, root: ctx.rt.root }],
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
    needsProject: false,
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
    needsProject: false,
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
    needsProject: false,
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

  if (definition.needsProject !== false && ctx.rt === undefined) {
    return {
      ok: false,
      summary: definition.title + ' needs an open project',
      refusal:
        'There is no Serva project here, and ' +
        definition.id +
        ' reads one. Open a folder that holds a project, or restore a backup into this one.',
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
    return await definition.handler(
      ctx as ActionContext & { readonly rt: ServaRuntime },
      parsed.data,
    );
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
