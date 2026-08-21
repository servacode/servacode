import { emitJson, openRuntime, wantsJson } from './_shared.js';
import { buildEngineeringLayer } from '../../app/engineering.js';
import { implementWorkItem, ImplementOutcome } from '../../app/implement.js';
import { resolveEngineeringEngine } from '../../engineering/engine.js';
import { EngineeringFactory } from '../../engineering/factory.js';
import { makeFixtureDir, removeFixtureDir } from '../../substrate/fake.js';
import { describeBoundary } from '../../substrate/boundary.js';
import { EnforcementClass } from '../../vocab/index.js';
import type { ParsedArgs } from '../main.js';

/**
 * `serva implement <work-item-id>` — the owner-facing engineering control surface.
 *
 * SPEC: Phase 4 §26, execution-binding closure §11.
 *
 * It asks the owner nothing about implementation technology. Serva already holds the
 * work item, the scope, the recipes and the agents; a command that stopped to ask which
 * framework to use would be admitting the plan was never deterministic.
 *
 * The output leads with the execution boundary, because every other line is meaningless
 * without it. A Producer, a ChangeSet and a green gate under an unmeasured boundary is
 * not a smaller version of the same thing — it is a different thing wearing its clothes.
 */
export async function cmdImplement(args: ParsedArgs): Promise<number> {
  const workItemId = args.positionals[0];
  if (typeof workItemId !== 'string' || workItemId.length === 0) {
    console.error('Usage: serva implement <work-item-id>');
    return 2;
  }

  const rt = openRuntime(args);
  try {
    const layer = await buildEngineeringLayer(rt);

    const factory = new EngineeringFactory({
      store: rt.store,
      git: layer.git,
      workspaces: layer.workspaces,
      recipes: layer.recipes,
      registry: layer.registry,
      // Only used to look the work item up; nothing is dispatched from this instance.
      qualification: await qualifyRecipes(layer),
      executorDeps: {
        store: rt.store,
        clock: rt.clock,
        ids: rt.ids,
        substrate: layer.substrate,
        qualification: await qualifyRecipes(layer),
        env: process.env,
      },
      gateDeps: { ids: rt.ids, clock: rt.clock, evaluator: 'ENGINEERING_GATE' },
      projectRoot: rt.root,
      enabledProducers: new Set(),
    });

    const item = factory.getWorkItem(workItemId);
    if (item === undefined) {
      console.error('No engineering work item ' + workItemId + '.');
      console.error('Work items are recorded by the planning flow before they can be built.');
      return 1;
    }

    const recipeQualification = await qualifyRecipes(layer);
    const engine = await resolveEngineeringEngine({ clock: rt.clock, projectRoot: rt.root });

    /*
     * Stop BEFORE anything is created, dispatched or run.
     *
     * A refusal that had already opened a worktree or spent a model call would not be a
     * refusal; it would be a partial execution with an apology attached.
     */
    if (engine.refusal !== undefined || engine.qualification === undefined) {
      return reportBlocked(args, {
        workItemId,
        basis: engine.basis,
        refusal: engine.refusal ?? 'No engineering engine is available on this machine.',
        prerequisites: engine.prerequisites.filter((p) => !p.satisfied),
      });
    }
    if (engine.qualification.enforcementClass !== EnforcementClass.HARD) {
      return reportBlocked(args, {
        workItemId,
        basis: engine.basis,
        refusal:
          'The Producer boundary measured ' +
          engine.qualification.enforcementClass +
          '. ' +
          (engine.qualification.blockedBy ?? ''),
        prerequisites: engine.qualification.probe.prerequisites.filter((p) => !p.satisfied),
      });
    }

    const result = await implementWorkItem(
      {
        rt,
        registry: layer.registry,
        recipes: layer.recipes,
        recipeSubstrate: layer.substrate,
        recipeQualification,
        engine,
      },
      item,
    );

    if (wantsJson(args)) {
      emitJson(result);
      return result.outcome === ImplementOutcome.ACCEPTED ? 0 : 1;
    }

    console.log('SERVA CODE');
    console.log(
      '  Engineering Governance: ' + (result.refusal === undefined ? 'ACTIVE' : 'BLOCKED'),
    );
    console.log(
      '  Execution Boundary:     ' +
        (engine.boundary === undefined ? '(none)' : describeBoundary(engine.boundary)),
    );
    console.log('  Work item:              ' + item.workItemId + '  ' + item.title);
    console.log('  Producer:               ' + item.producerAgentId);
    console.log('  Reviewer:               ' + item.reviewerAgentId);
    console.log('');

    for (const a of result.attempts) {
      console.log('  Attempt ' + String(a.attempt));
      console.log('    Workspace:   ' + a.workspaceId);
      console.log('    Producer:    ' + (a.producerRunId ?? '(not dispatched)'));
      console.log('    ChangeSet:   ' + (a.changeSetId ?? '(none)'));
      console.log('    Reviewer:    ' + (a.reviewerRunId ?? '(not dispatched)'));
      console.log('    Gate:        ' + (a.verdict ?? '(not evaluated)'));
      for (const n of a.notes) console.log('      - ' + n);
      console.log('');
    }

    if (result.verification !== undefined) {
      console.log('  Measured checks:');
      for (const e of result.verification.evidence) {
        console.log(
          '    [' + e.outcome + '] ' + (e.runtimeComponentId ?? 'JUDGED') + '  ' + e.detail,
        );
      }
      console.log('');
    }

    console.log('  Result: ' + result.outcome);
    if (result.commit !== undefined) {
      console.log('    commit ' + result.commit + ' on ' + String(result.branch));
      console.log('    Phase 4 performs no remote write; the change is local and unmerged.');
    }
    if (result.refusal !== undefined) console.log('    ' + result.refusal);

    return result.outcome === ImplementOutcome.ACCEPTED ? 0 : 1;
  } finally {
    rt.close();
  }
}

async function qualifyRecipes(layer: Awaited<ReturnType<typeof buildEngineeringLayer>>) {
  const fixture = makeFixtureDir();
  try {
    return await layer.substrate.qualify(fixture);
  } finally {
    removeFixtureDir(fixture);
  }
}

function reportBlocked(
  args: ParsedArgs,
  o: {
    workItemId: string;
    basis: string;
    refusal: string;
    prerequisites: readonly { id: string; what: string; why: string; remedy: string }[];
  },
): number {
  if (wantsJson(args)) {
    emitJson({ outcome: 'BLOCKED', ...o });
    return 1;
  }
  console.log('SERVA CODE');
  console.log('  Engineering Governance: BLOCKED');
  console.log('  Work item:              ' + o.workItemId);
  console.log('  Execution Boundary:     ' + o.basis);
  console.log('');
  console.log('  ' + o.refusal);
  if (o.prerequisites.length > 0) {
    console.log('');
    console.log(
      '  PLATFORM_PREREQUISITE_REQUIRED — ' + String(o.prerequisites.length) + ' item(s):',
    );
    for (const p of o.prerequisites) {
      console.log('    - ' + p.id + '  ' + p.what);
      console.log('        why:    ' + p.why);
      console.log('        remedy: ' + p.remedy);
    }
  }
  console.log('');
  console.log('  Nothing was created. No worktree, no model call, no command.');
  console.log("  Serva installs no prerequisites: changing the machine is the owner's decision.");
  return 1;
}
