import { EnforcementClass } from '../vocab/index.js';
import { HostExecutionSubstrate } from '../substrate/host.js';
import {
  engineeringAuthorityRefusal,
  type ExecutionSubstrate,
  type SubstrateQualification,
} from '../substrate/types.js';
import { GitService } from '../engineering/git.js';
import { EngineeringWorkspaceManager } from '../engineering/workspace.js';
import { RecipeRegistry } from '../engineering/recipe.js';
import { EngineeringFactory } from '../engineering/factory.js';
import { reconcileWorkspaces, type ReconciliationReport } from '../engineering/reconcile.js';
import { ContractRegistry } from '../agents/registry.js';
import { producerContractRefusal } from '../engineering/capability.js';
import { makeFixtureDir, removeFixtureDir } from '../substrate/fake.js';
import type { ServaRuntime } from './runtime.js';

/**
 * Wiring for the Engineering Factory, and the owner-facing state it reports.
 *
 * SPEC: Phase 4 §26.
 *
 * The governance state is deliberately three-valued rather than a boolean:
 *
 *   ACTIVE    a qualified substrate exists and work can be dispatched
 *   DEGRADED  the factory is present and something narrower than the substrate is wrong
 *   BLOCKED   no qualified substrate; nothing that writes or executes may run
 *
 * BLOCKED is the honest state on a machine that cannot contain a Producer, and it is
 * reported as BLOCKED rather than quietly reported as ACTIVE-with-caveats.
 */

/**
 * Producer agents Phase 4 may enable ON A QUALIFIED SUBSTRATE.
 *
 * Membership here is necessary and nowhere near sufficient: `producerRefusal` still
 * requires HARD enforcement, a matching contract, an isolated worktree, an independent
 * reviewer and working executors. The set exists so that enabling a Producer stays a
 * deliberate act rather than a consequence of the contract loading.
 */
export const PHASE4_CANDIDATE_PRODUCERS: ReadonlySet<string> = new Set([
  'SC-AGENT-150', // Backend Engineer
  'SC-AGENT-160', // Frontend Engineer
  'SC-AGENT-180', // Database Engineer
  // Integration Engineer. Listed as a candidate and refused every time: its contract
  // declares DECLARED_HOSTS network scope, and Phase 4 grants a Producer no network at
  // all. It stays in the set so the status EXPLAINS why it is off, rather than quietly
  // omitting an agent the owner can see in the catalogue.
  'SC-AGENT-190',
]);

/** The independent verifiers the factory dispatches. Read-only, always. */
export const PHASE4_VERIFIERS: ReadonlySet<string> = new Set([
  'SC-AGENT-200', // Code Reviewer
  'SC-AGENT-214', // QA Verifier
]);

export const EngineeringGovernance = {
  ACTIVE: 'ACTIVE',
  DEGRADED: 'DEGRADED',
  BLOCKED: 'BLOCKED',
} as const;
export type EngineeringGovernance =
  (typeof EngineeringGovernance)[keyof typeof EngineeringGovernance];

export interface EngineeringLayer {
  readonly substrate: ExecutionSubstrate;
  readonly git: GitService;
  readonly workspaces: EngineeringWorkspaceManager;
  readonly recipes: RecipeRegistry;
  readonly registry: ContractRegistry;
}

export interface EngineeringLayerOptions {
  readonly substrate?: ExecutionSubstrate;
  readonly registry?: ContractRegistry;
  readonly recipes?: RecipeRegistry;
  readonly engineVersion?: string;
}

export function buildEngineeringLayer(
  rt: ServaRuntime,
  opts: EngineeringLayerOptions = {},
): EngineeringLayer {
  const registry = opts.registry ?? ContractRegistry.shared();
  const git = new GitService({ repoRoot: rt.root });
  const workspaces = new EngineeringWorkspaceManager({
    store: rt.store,
    git,
    clock: rt.clock,
    projectRoot: rt.root,
  });
  const substrate =
    opts.substrate ??
    new HostExecutionSubstrate({
      clock: rt.clock,
      engineVersion: opts.engineVersion ?? 'UNKNOWN',
    });
  return {
    substrate,
    git,
    workspaces,
    recipes: opts.recipes ?? new RecipeRegistry(),
    registry,
  };
}

export interface EngineeringStatusView {
  readonly system: 'SERVA CODE';
  readonly governance: EngineeringGovernance;
  readonly executionSubstrate: EnforcementClass;
  readonly substrateId: string;
  readonly hostPlatform: string;
  readonly guestPlatform?: string;
  readonly isolationMethod: string;
  readonly blockedBy?: string;
  readonly missingPrerequisites: readonly { id: string; what: string; remedy: string }[];
  readonly enabledProducers: readonly string[];
  readonly disabledProducers: readonly { id: string; reason: string }[];
  readonly workspaces: number;
  readonly recipes: readonly string[];
  readonly checkedAt: string;
}

/**
 * The owner-facing engineering state.
 *
 * Takes only the layer: after the Producer check moved to `producerContractRefusal`,
 * nothing here needs the runtime, and a status call that cannot reach the store cannot
 * accidentally mutate it.
 */
export async function engineeringStatus(
  layer: EngineeringLayer,
): Promise<{ view: EngineeringStatusView; qualification: SubstrateQualification }> {
  const fixture = makeFixtureDir();
  let qualification: SubstrateQualification;
  try {
    qualification = await layer.substrate.qualify(fixture);
  } finally {
    removeFixtureDir(fixture);
  }

  const refusal = engineeringAuthorityRefusal(qualification);
  const missing = qualification.probe.prerequisites
    .filter((p) => !p.satisfied)
    .map((p) => ({ id: p.id, what: p.what, remedy: p.remedy }));

  const enabled: string[] = [];
  const disabled: { id: string; reason: string }[] = [];
  for (const id of PHASE4_CANDIDATE_PRODUCERS) {
    if (!layer.registry.has(id)) {
      disabled.push({ id, reason: 'contract not in the registry' });
      continue;
    }
    if (refusal !== undefined) {
      disabled.push({ id, reason: refusal });
      continue;
    }
    const contractual = producerContractRefusal(layer.registry.get(id), PHASE4_CANDIDATE_PRODUCERS);
    if (contractual !== undefined) {
      disabled.push({ id, reason: contractual });
      continue;
    }
    enabled.push(id);
  }

  const view: EngineeringStatusView = {
    system: 'SERVA CODE',
    governance:
      refusal === undefined
        ? EngineeringGovernance.ACTIVE
        : qualification.enforcementClass === EnforcementClass.SOFT
          ? EngineeringGovernance.DEGRADED
          : EngineeringGovernance.BLOCKED,
    executionSubstrate: qualification.enforcementClass,
    substrateId: qualification.probe.substrateId,
    hostPlatform: qualification.probe.hostPlatform,
    ...(qualification.probe.guestPlatform === undefined
      ? {}
      : { guestPlatform: qualification.probe.guestPlatform }),
    isolationMethod: qualification.probe.isolationMethod,
    ...(refusal === undefined ? {} : { blockedBy: refusal }),
    missingPrerequisites: missing,
    enabledProducers: enabled,
    disabledProducers: disabled,
    workspaces: layer.workspaces.list().filter((w) => w.state !== 'REMOVED').length,
    recipes: layer.recipes.all().map((r) => r.id),
    checkedAt: qualification.qualifiedAt,
  };

  return { view, qualification };
}

export async function engineeringReconcile(
  rt: ServaRuntime,
  layer: EngineeringLayer,
): Promise<ReconciliationReport> {
  return reconcileWorkspaces({
    store: rt.store,
    git: layer.git,
    workspaces: layer.workspaces,
    clock: rt.clock,
  });
}

export { EngineeringFactory };
