import type { Store } from '../store/store.js';
import { EnforcementClass } from '../vocab/index.js';
import { selectExecutionSubstrate } from '../substrate/host.js';
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
import { join } from 'node:path';
import { SERVA_INTERNAL_DIR } from '../agents/toolPolicy.js';
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
  /** Why this substrate was chosen for this machine. */
  readonly substrateBasis: string;
  /**
   * Where the last valid qualification is kept.
   *
   * Optional because `serva engineering status` is legitimately run outside a project, and a
   * status command that threw there would be worse than one that reports "never measured".
   * Absent means no measurement is preserved, which grants nothing.
   */
  readonly store?: Store;
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

/**
 * Wire the engineering layer for this project.
 *
 * Asynchronous because choosing the substrate means asking the machine what it is —
 * on Windows, which WSL2 distributions exist. Doing that lazily on first use was the
 * alternative and it is worse: the owner would not learn the substrate is unavailable
 * until something was already half-dispatched.
 */
export async function buildEngineeringLayer(
  rt: ServaRuntime,
  opts: EngineeringLayerOptions = {},
): Promise<EngineeringLayer> {
  const registry = opts.registry ?? ContractRegistry.shared();
  const git = new GitService({ repoRoot: rt.root });
  const workspaces = new EngineeringWorkspaceManager({
    store: rt.store,
    git,
    clock: rt.clock,
    projectRoot: rt.root,
  });

  let substrate = opts.substrate;
  let basis = 'substrate supplied by the caller';
  if (substrate === undefined) {
    const selection = await selectExecutionSubstrate({
      clock: rt.clock,
      engineVersion: opts.engineVersion ?? 'UNKNOWN',
      projectRoot: rt.root,
      alwaysDenyRead: [join(rt.root, SERVA_INTERNAL_DIR)],
    });
    substrate = selection.substrate;
    basis = selection.basis;
  }

  return {
    substrate,
    substrateBasis: basis,
    store: rt.store,
    git,
    workspaces,
    recipes: opts.recipes ?? new RecipeRegistry(),
    registry,
  };
}

import {
  FingerprintComparison,
  ProducerAuthority,
  lastValidQualification,
  producerAuthority,
  recordQualification,
} from '../substrate/qualificationRecord.js';
import { ExecutionAvailability, QualificationAttempt } from '../substrate/types.js';
import type { QualificationRecord } from '../substrate/qualificationRecord.js';

export interface EngineeringStatusView {
  readonly system: 'SERVA CODE';
  readonly governance: EngineeringGovernance;
  /**
   * The boundary that contains a RECIPE, as measured this attempt.
   *
   * SPEC: Phase 6 qualification transport invariant §7.
   *
   * Renamed from `executionSubstrate`, which was one string carrying four different facts —
   * the recipe boundary, the Producer boundary, whether the guest could be reached, and
   * whether a measurement happened at all. An owner reading `NONE` could not tell whether
   * their sandbox was broken or their WSL was busy, and on this machine it was usually the
   * second. Each of those facts now has its own field, and none of them is inferred from
   * another.
   *
   * Meaningful only when `qualificationAttempt` is MEASURED.
   */
  readonly recipeBoundary: EnforcementClass;
  /** What the last COMPLETED measurement of this machine found, whatever this attempt did. */
  readonly producerQualification: EnforcementClass | 'NOT_MEASURED';
  /** Whether this attempt measured anything. */
  readonly qualificationAttempt: QualificationAttempt;
  /** Whether commands can reach the execution environment right now. */
  readonly guestAvailability: ExecutionAvailability;
  /** Whether a Producer may actually be dispatched, and why not when it may not. */
  readonly producerAuthority: ProducerAuthority;
  readonly producerAuthorityReason: string;
  /** How the preserved measurement compares to this machine, or UNKNOWN when unmeasurable. */
  readonly fingerprintComparison: FingerprintComparison;
  /** The last attempt that actually measured something, preserved across outages. */
  readonly lastValidQualification?: QualificationRecord;
  readonly substrateId: string;
  readonly hostPlatform: string;
  readonly guestPlatform?: string;
  readonly isolationMethod: string;
  /** Why this substrate, on this machine. */
  readonly substrateBasis: string;
  /**
   * True when the substrate simulates rather than contains.
   *
   * Reported next to the governance state because ACTIVE-on-a-simulation and
   * ACTIVE-on-a-boundary are very different facts, and a reader must not have to know
   * which class was wired to tell them apart.
   */
  readonly simulated: boolean;
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

  /*
   * The preserved measurement, and what it authorises RIGHT NOW.
   *
   * `store` is optional so a caller with no project — `serva engineering status` outside one
   * — still gets an honest answer rather than an exception. Without it there is no preserved
   * record, which reads as "this machine has never been measured": true from the point of
   * view of a caller that cannot see the record, and it grants nothing.
   */
  const preserved = layer.store === undefined ? undefined : lastValidQualification(layer.store);
  if (layer.store !== undefined) recordQualification(layer.store, qualification);
  const authority = producerAuthority(preserved, qualification);

  const view: EngineeringStatusView = {
    system: 'SERVA CODE',
    governance:
      refusal === undefined
        ? EngineeringGovernance.ACTIVE
        : qualification.attempt !== QualificationAttempt.MEASURED
          ? /*
             * Not measured is not DEGRADED and not BLOCKED-by-boundary. It is the absence of
             * a measurement, and the governance state must not imply Serva learned something
             * about containment that it did not.
             */
            EngineeringGovernance.BLOCKED
          : qualification.enforcementClass === EnforcementClass.SOFT
            ? EngineeringGovernance.DEGRADED
            : EngineeringGovernance.BLOCKED,
    recipeBoundary: qualification.enforcementClass,
    producerQualification:
      qualification.attempt === QualificationAttempt.MEASURED
        ? qualification.enforcementClass
        : (preserved?.enforcementClass ?? 'NOT_MEASURED'),
    qualificationAttempt: qualification.attempt,
    guestAvailability: qualification.availability,
    producerAuthority: authority.authority,
    producerAuthorityReason: authority.reason,
    fingerprintComparison: authority.fingerprint,
    ...(preserved === undefined ? {} : { lastValidQualification: preserved }),
    substrateId: qualification.probe.substrateId,
    hostPlatform: qualification.probe.hostPlatform,
    ...(qualification.probe.guestPlatform === undefined
      ? {}
      : { guestPlatform: qualification.probe.guestPlatform }),
    isolationMethod: qualification.probe.isolationMethod,
    substrateBasis: layer.substrateBasis,
    simulated: qualification.probe.simulated === true,
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
