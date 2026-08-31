import { recordRunQualification } from '../substrate/qualificationRecord.js';
import { z } from 'zod';
import { existsSync, readFileSync } from 'node:fs';
import { canonicalJson, digestOf } from '../core/hash.js';
import { fail } from '../core/errors.js';
import { RunOutcome } from '../vocab/index.js';
import { AuditAction, audit } from '../events/audit.js';
import { engineeringAuthorityRefusal } from '../substrate/types.js';
import { BoundaryPurpose, describeBoundary, executionBoundary } from '../substrate/boundary.js';
import {
  resolveOsSandboxQualificationPolicy,
  resolveProducerPolicy,
  resolveReviewerPolicy,
} from './capability.js';
import {
  buildSandboxProfile,
  removeSandboxProfile,
  sandboxProfileDrift,
  validateSandboxProfile,
  writeSandboxProfile,
  SANDBOX_MEASUREMENT_TYPE,
  measurementRefusal,
  sandboxProfileStatuses,
  type SandboxMeasurement,
  type GeneratedSandboxProfile,
} from './sandboxProfile.js';
import { REVIEWER_RESULT_SCHEMA, ReviewerVerdictSchema, recordReview } from './review.js';
import type { AgentRuntime, AgentRunResult } from '../agents/runtime.js';
import type { RunBudget } from '../engine/types.js';
import type { ContractRegistry } from '../agents/registry.js';
import type { EngineeringWorkspace } from './workspace.js';
import type { EngineeringWorkItem } from './factory.js';
import type { ChangeSet } from './changeset.js';
import type { EngineeringEvidence } from './execution.js';
import type { ExecutionSubstrate, SubstrateQualification } from '../substrate/types.js';
import type { EngineCapabilities } from '../engine/types.js';
import type { PersistedReview } from './review.js';
import type { Store } from '../store/store.js';
import type { Clock } from '../core/clock.js';
import type { IdSource } from '../core/ids.js';

/**
 * Dispatching the company's own agents into the factory.
 *
 * SPEC: Phase 4 §9–§10, §19, closure blocker 2.
 *
 * What this file replaces: nothing. There was no production path from the factory to
 * `AgentRuntime` at all. `resolveProducerPolicy`, `buildSandboxProfile`,
 * `writeSandboxProfile` and `sandboxProfileDrift` all existed, were all tested, and
 * were called by nothing that could dispatch an agent. The live acceptance stood a
 * `writeFileSync` in for the Producer and a string literal in for the Reviewer, so the
 * one thing Phase 4 is FOR — a governed agent changing code under a measured boundary
 * — was the one thing that had never happened.
 *
 * The flow, and the reason each step precedes the next:
 *
 *   substrate qualified HARD          nothing is dispatched onto an unmeasured machine
 *     -> Producer policy resolved     the eight-condition gate, before anything runs
 *     -> sandbox profile written      under `.serva`, which the run itself is denied
 *     -> profile confirmed in force   see verifySandboxProfileInForce for its limits
 *     -> AgentRuntime.run(...)        ONE runtime; Phase 4 adds no second one
 *     -> Serva computes the ChangeSet the agent's account of its edits is not consulted
 *
 * The Reviewer follows the same shape with a read-only grant, a separate run, a
 * separate session, and a context bundle built from evidence rather than from anything
 * the Producer said.
 */

/* ------------------------------------------------------------------ producer */

/** The structured payload a Producer AgentRun returns. Its edits are on disk. */
export const ProducerResultSchema = z
  .object({
    summary: z.string().min(1),
    /**
     * What the Producer BELIEVES it changed.
     *
     * Recorded, and deliberately not used for anything that matters. Serva computes the
     * ChangeSet from the repository; this exists so the two can be COMPARED, which
     * makes a Producer that misreports its own work visible rather than merely wrong.
     */
    claimedPaths: z.array(z.string()).default([]),
    /** Things it noticed outside its scope. An Observation, never a silent edit. */
    observations: z.array(z.string()).default([]),
    /** Why it could not finish, when it could not. */
    blockers: z.array(z.string()).default([]),
  })
  .strict();

export type ProducerResult = z.output<typeof ProducerResultSchema>;

export const PRODUCER_RESULT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'claimedPaths', 'observations', 'blockers'],
  properties: {
    summary: { type: 'string' },
    claimedPaths: { type: 'array', items: { type: 'string' } },
    observations: { type: 'array', items: { type: 'string' } },
    blockers: { type: 'array', items: { type: 'string' } },
  },
};

export interface DispatchDeps {
  readonly store: Store;
  readonly clock: Clock;
  readonly ids: IdSource;
  readonly runtime: AgentRuntime;
  readonly registry: ContractRegistry;
  readonly substrate: ExecutionSubstrate;
  readonly qualification: SubstrateQualification;
  readonly projectRoot: string;
  readonly enabledProducers: ReadonlySet<string>;
  /** The engine's declared capabilities, used to confirm the profile can be applied. */
  readonly engineCapabilities: EngineCapabilities;
  /** The engine version the runtime's adapter reported. Observed, not configured. */
  readonly engineVersion: string;
  /** TEST ONLY. Permits a simulated boundary; no production caller sets it. */
  readonly allowSimulatedBoundary?: boolean;
  /** A host path as the engine names it. Identity when the engine runs on this host. */
  readonly toExecutionPath?: (hostPath: string) => string;
  /**
   * QUALIFICATION ONLY. Bash commands pre-approved so a probe can reach the OS boundary.
   *
   * A normal Producer pre-approves no Bash at all, so under `dontAsk` every Bash call is
   * refused by the permission layer and the OS sandbox is never exercised. That is the
   * right default and it is also why the boundary's second line of defence cannot be
   * demonstrated by an ordinary run: the first line stops everything first.
   *
   * This grant names individual command shapes for a disposable qualification fixture.
   * It is not the production Producer policy, nothing in the normal dispatch path sets
   * it, and it never widens Bash to anything unbounded.
   */
  /**
   * ACTIVATION ONLY. Probe commands for the OS-sandbox qualification profile.
   *
   * Present means "this dispatch is a measurement, not production work": the grant is
   * swapped for `resolveOsSandboxQualificationPolicy` AFTER the full Producer gate has
   * passed, so the OS boundary can be reached and observed. Absent — which is every
   * production path — means the ordinary Producer grant, unchanged.
   */
  readonly qualificationCommands?: readonly string[];
  /**
   * ACTIVATION ONLY. A larger budget for a qualification run.
   *
   * The default budget is sized for engineering work: a qualification that runs two
   * dozen probes exhausted it and stopped halfway through, leaving the remaining probes
   * NOT_RUN — which counts as failure and would have been read as a missing measurement
   * rather than as a truncated one. Production leaves this undefined.
   */
  readonly budget?: Partial<RunBudget>;
}

export interface ProducerDispatch {
  readonly runId: string;
  readonly outcome: RunOutcome;
  readonly result?: ProducerResult;
  readonly sandboxProfile: GeneratedSandboxProfile;
  readonly diagnostics: readonly string[];
  /** What the pre-dispatch check could not establish, carried rather than dropped. */
  readonly unprovedBoundary: readonly string[];
}

/**
 * Confirm the sandbox profile is actually in force before granting write authority.
 *
 * The first attempt at this probed Serva's own substrate: it ran a command through
 * `substrate.execute()` that tried to write outside the worktree, and required it to
 * fail. That test is a fine test — and it answers the wrong question. Serva's substrate
 * contains the DETERMINISTIC RECIPES. The profile written here governs a different
 * boundary: the engine's own sandbox, which constrains the Producer's tool calls and
 * whatever its Bash commands spawn. Proving one says nothing about the other, and
 * conflating them would have let a real gap hide behind a green check.
 *
 * What can be established without spending a model call, and is:
 *
 *   1. the engine can carry a Serva-supplied settings file at all — a profile that
 *      cannot be passed is a profile that is not in force;
 *   2. the file Serva wrote is on disk and still digests to what Serva intended,
 *      catching a write that failed, truncated, or was changed in between;
 *   3. no drift against the effective policy, whenever the engine reports one.
 *
 * What CANNOT be established here, stated rather than papered over: whether the engine
 * honours the profile at runtime. That is measured by the substrate qualification for
 * recipes, and by the live acceptance for a real Producer session. Returning "verified"
 * for something unverifiable is the failure this whole phase exists to prevent, so the
 * absence is reported as an unresolved qualification instead.
 */
export interface SandboxProfileCheck {
  /** The reason the profile is not in force, or undefined. */
  readonly refusal?: string;
  /** What could not be established, and is therefore not claimed. */
  readonly unproved: readonly string[];
}

export function verifySandboxProfileInForce(o: {
  readonly profile: GeneratedSandboxProfile;
  readonly capabilities: EngineCapabilities;
  readonly engineVersion: string;
  readonly effectiveSettings?: Record<string, unknown>;
}): SandboxProfileCheck {
  /*
   * Validity FIRST, and blocking.
   *
   * "Serva generated a settings file" was never the same claim as "the engine accepted
   * it". One unsupported key — `sandbox.network.enabled` — made the engine discard the
   * whole file in silence, and the Producer ran under default policy while Serva
   * recorded a boundary that did not exist. Measured on 2.1.231, `claude doctor` cannot
   * tell the two profiles apart, so there is nothing to ask; the only defence is to
   * refuse to emit a key that is not known to be accepted.
   */
  const validation = validateSandboxProfile(o.profile, o.engineVersion);
  if (!validation.ok) {
    return { refusal: validation.reason ?? 'SANDBOX_PROFILE_REJECTED', unproved: [] };
  }

  if (!o.capabilities.supportsAmbientConfigIsolation) {
    return {
      refusal:
        'This engine version cannot be given an isolated settings source, so a Serva-generated sandbox profile could not be applied to the run.',
      unproved: [],
    };
  }

  if (o.profile.path === undefined) {
    return { refusal: 'No sandbox profile was written for this run.', unproved: [] };
  }
  if (!existsSync(o.profile.path)) {
    return {
      refusal: 'The sandbox profile Serva wrote is not on disk at ' + o.profile.path + '.',
      unproved: [],
    };
  }

  let onDisk: unknown;
  try {
    onDisk = JSON.parse(readFileSync(o.profile.path, 'utf8'));
  } catch (e) {
    return {
      refusal: 'The sandbox profile on disk is not readable JSON: ' + String(e),
      unproved: [],
    };
  }
  if (digestOf(canonicalJson(onDisk as Record<string, unknown>)) !== o.profile.digest) {
    return {
      refusal:
        'The sandbox profile on disk does not match the one Serva generated. It was changed between writing and dispatch.',
      unproved: [],
    };
  }

  const drift = sandboxProfileDrift(o.profile, o.effectiveSettings);
  if (o.effectiveSettings !== undefined && drift !== undefined) {
    return { refusal: 'SANDBOX_PROFILE_DRIFT: ' + drift, unproved: [] };
  }

  return {
    unproved:
      o.effectiveSettings === undefined
        ? [
            'The engine reported no effective sandbox policy, so Serva confirmed the profile it wrote and not the policy the engine applied.',
          ]
        : [],
  };
}

/**
 * Run one Producer attempt inside its worktree, under a measured boundary.
 *
 * Throws when the capability gate refuses — a refusal must not be recoverable by
 * ignoring a return value. Returns normally for an agent-level failure, which is an
 * outcome the rework loop routes on rather than an exception.
 */
export async function dispatchProducer(
  deps: DispatchDeps,
  o: {
    readonly item: EngineeringWorkItem;
    readonly workspace: EngineeringWorkspace;
    readonly taskDefinition: string;
    readonly ownerRequest?: string;
    readonly reviewerAvailable: boolean;
    readonly executorsAvailable: boolean;
    readonly reworkContext?: string;
  },
): Promise<ProducerDispatch> {
  const refusal = engineeringAuthorityRefusal(deps.qualification);
  if (refusal !== undefined) {
    return fail({
      code: 'E_CAPABILITY_NOT_ENABLED',
      message: 'Refusing to dispatch a Producer: ' + refusal,
      remedy:
        'Write authority requires a substrate Serva has measured. Nothing was created and no model call was made.',
      details: { workItemId: o.item.workItemId, agentId: o.item.producerAgentId },
      specRef: '33 PC-5, Phase 4 §9',
    });
  }

  const contract = deps.registry.get(o.item.producerAgentId);

  const profile = writeSandboxProfile(
    buildSandboxProfile({
      worktreePath: o.workspace.path,
      projectRoot: deps.projectRoot,
      networkAllowed: false,
      // Written in the paths the ENGINE sees. Serva's host paths would name nothing in
      // a WSL2 guest, and a policy whose every entry matches nothing is not a policy.
      ...(deps.toExecutionPath === undefined ? {} : { toExecutionPath: deps.toExecutionPath }),
    }),
    deps.projectRoot,
    o.workspace.workspaceId,
  );

  /*
   * The boundary this run will ACTUALLY use, derived from the runtime in hand.
   *
   * Three of these facts are observed independently of the qualification and are the
   * ones that were wrong: the transport, the guest, and the engine executable. A WSL2
   * qualification paired with a native-Windows `claude.exe` differs in all three, which
   * is precisely the case that used to pass.
   *
   * The sandbox mechanism and its version are CARRIED from the qualification rather
   * than re-observed — re-probing the guest on every dispatch would be a second
   * measurement, not a second opinion, and the fingerprint over the qualification
   * already covers them. Said plainly here so nobody reads this check as proving more
   * than it does.
   */
  const location = deps.runtime.engineLocation();
  if (location === undefined) {
    return fail({
      code: 'E_CAPABILITY_NOT_ENABLED',
      message:
        "The runtime's engine does not declare where it runs, so Serva cannot confirm it is the environment that was qualified",
      remedy:
        'Write authority is granted to a named execution environment, never to an unnamed one.',
      details: { workItemId: o.item.workItemId },
      specRef: 'Phase 4 §2',
    });
  }
  const actualBoundary = executionBoundary({
    boundaryId: deps.qualification.boundary.boundaryId,
    purpose: BoundaryPurpose.PRODUCER,
    transport: location.transport,
    ...(location.guest === undefined ? {} : { guest: location.guest }),
    engineLocation: location.executable,
    engineVersion: deps.engineVersion,
    sandboxMechanism: deps.qualification.boundary.sandboxMechanism,
    ...(deps.qualification.boundary.sandboxVersion === undefined
      ? {}
      : { sandboxVersion: deps.qualification.boundary.sandboxVersion }),
    profileDigest: profile.policyDigest,
    // Carried from the qualification: a simulation cannot be turned into a measurement
    // by the act of dispatching against it, and pretending otherwise here would hide
    // the one fact the gate needs.
    simulated: deps.qualification.boundary.simulated,
  });

  // The nine-condition gate, boundary first. Throws with the reason; no downgrade path.
  const producerPolicy = resolveProducerPolicy({
    contract,
    workspace: o.workspace,
    qualification: deps.qualification,
    enabledProducers: deps.enabledProducers,
    projectRoot: deps.projectRoot,
    reviewerAvailable: o.reviewerAvailable,
    executorsAvailable: o.executorsAvailable,
    actualBoundary,
    ...(deps.toExecutionPath === undefined ? {} : { toExecutionPath: deps.toExecutionPath }),
    ...(deps.allowSimulatedBoundary === undefined
      ? {}
      : { allowSimulatedBoundary: deps.allowSimulatedBoundary }),
  });

  /*
   * The qualification profile REPLACES the grant, and only after the gate above has
   * already passed on its own terms.
   *
   * Order is the whole safety property. `resolveProducerPolicy` is what enforces the
   * nine conditions — HARD substrate, matching boundary, isolated worktree, independent
   * reviewer, working executors — and it is run unconditionally, so a qualification run
   * cannot be used to slip past any of them. What the swap changes is one thing: which
   * commands the permission layer pre-approves, so that the OS sandbox rather than the
   * permission layer is the thing being measured.
   */
  const policy =
    deps.qualificationCommands === undefined
      ? producerPolicy
      : resolveOsSandboxQualificationPolicy({
          workspace: o.workspace,
          projectRoot: deps.projectRoot,
          probeCommands: deps.qualificationCommands,
          ...(deps.toExecutionPath === undefined ? {} : { toExecutionPath: deps.toExecutionPath }),
        });

  try {
    /*
     * THE FIVE STATUSES, AND HARD REQUIRES ALL OF THEM.
     *
     * Each one closes a way the previous attempt could look right while being wrong:
     * GENERATED says Serva built a profile, VALIDATED that the engine would accept it
     * rather than silently discard it, LOADED that the bytes on disk are still Serva's,
     * EFFECTIVE that the invocation was actually given the file, and MEASURED that an
     * adversarial run reached the operating system and the operating system refused what
     * it should. Everything before MEASURED is an assertion about a settings file.
     *
     * The measurement is looked up BY POLICY DIGEST, so changing the policy invalidates
     * it automatically instead of relying on someone remembering to re-measure.
     */
    const measurement = deps.store.getCanon<SandboxMeasurement>(
      SANDBOX_MEASUREMENT_TYPE,
      profile.policyDigest,
    )?.body;

    const simulated = actualBoundary.simulated && deps.allowSimulatedBoundary === true;
    /*
     * The qualification run is the one dispatch that cannot require a measurement,
     * because it is the run that PRODUCES one. Requiring it here would mean a sandbox
     * could never be measured for the first time — and the exemption is narrow: it
     * applies only when `qualificationCommands` is set, which already means this dispatch
     * has had its grant replaced by the OS_SANDBOX_QUALIFICATION profile and is a
     * measurement rather than engineering work.
     *
     * It is not a hole in the boundary. The qualification runs under the REAL policy, in
     * a disposable worktree; what it lacks is prior evidence about that policy, which is
     * precisely the thing it exists to obtain.
     */
    const isQualification = deps.qualificationCommands !== undefined;
    if (!simulated && !isQualification) {
      const unmeasured = measurementRefusal(measurement, {
        policyDigest: profile.policyDigest,
        boundaryFingerprint: actualBoundary.fingerprint,
        engineVersion: deps.engineVersion,
      });
      if (unmeasured !== undefined) {
        return fail({
          code: 'E_CAPABILITY_NOT_ENABLED',
          message: 'SANDBOX_NOT_MEASURED: ' + unmeasured,
          remedy:
            'A Producer runs under a sandbox Serva has measured on this machine, for this policy. Run the OS sandbox qualification. No model call was made.',
          details: {
            workItemId: o.item.workItemId,
            policyDigest: profile.policyDigest,
            boundaryFingerprint: actualBoundary.fingerprint,
          },
          specRef: 'Phase 4 §4',
        });
      }
    }

    const check = verifySandboxProfileInForce({
      profile,
      capabilities: deps.engineCapabilities,
      engineVersion: deps.engineVersion,
    });

    /*
     * Record which statuses were actually reached, so the run carries the answer rather
     * than the reader having to reconstruct it. A profile that stops short of MEASURED
     * is reported as such even when the dispatch is allowed to proceed on a simulated
     * boundary, because "we did not measure this" is exactly the fact that went missing
     * last time.
     */
    const statuses = sandboxProfileStatuses({
      profile,
      engineVersion: deps.engineVersion,
      boundaryFingerprint: actualBoundary.fingerprint,
      loaded: check.refusal === undefined,
      passedToInvocation: profile.path !== undefined,
      // A qualification is honest about being unmeasured; it does not claim MEASURED on
      // the strength of the measurement it is in the middle of taking.

      ...(measurement === undefined ? {} : { measurement }),
    });
    const statusLine =
      'sandbox profile status: ' +
      statuses.reached.join(' > ') +
      (statuses.missing.length === 0
        ? ' (complete)'
        : ' | NOT reached: ' + statuses.missing.join(', '));

    if (check.refusal !== undefined) {
      return fail({
        code: 'E_CAPABILITY_NOT_ENABLED',
        message: 'SANDBOX_PROFILE_NOT_IN_FORCE: ' + check.refusal,
        remedy:
          'Serva does not dispatch a Producer on the strength of a settings file it could not confirm. No model call was made.',
        details: {
          workItemId: o.item.workItemId,
          workspaceId: o.workspace.workspaceId,
          profileDigest: profile.digest,
        },
        specRef: 'Phase 4 §4',
      });
    }

    const run = await deps.runtime.run({
      ...(deps.budget === undefined ? {} : { budget: deps.budget }),
      agentId: contract.id,
      workItemId: o.item.workItemId,
      taskDefinition: o.taskDefinition,
      scopeBoundary:
        'Edit only files under: ' +
        o.item.allowedScope.join(', ') +
        '. Everything else in this worktree is out of scope; report it as an observation rather than changing it.',
      ...(o.ownerRequest === undefined ? {} : { ownerRequest: o.ownerRequest }),
      resultSchema: PRODUCER_RESULT_SCHEMA,
      resultValidator: ProducerResultSchema,
      canon: [
        {
          source: 'work-item',
          kind: 'REQUIREMENTS',
          version: '1',
          content:
            o.item.requirements.map((r) => '- ' + r).join('\n') +
            '\n\nAcceptance criteria:\n' +
            o.item.acceptanceCriteria.map((a) => '- ' + a).join('\n'),
          relevance: 1,
        },
        ...(o.item.decisions.length === 0
          ? []
          : [
              {
                source: 'decisions',
                kind: 'DECISION' as const,
                version: '1',
                content: o.item.decisions.map((d) => '- ' + d).join('\n'),
                relevance: 0.8,
              },
            ]),
        ...(o.reworkContext === undefined
          ? []
          : [
              {
                source: 'rework',
                kind: 'EVIDENCE' as const,
                version: '1',
                content: o.reworkContext,
                relevance: 1,
              },
            ]),
      ],
      // ONE runtime. The grant is computed by Serva and proved against the contract
      // inside the runtime before anything is bound.
      capability: {
        policy,
        cwd: o.workspace.path,
        basis:
          'engineering producer on a ' +
          deps.qualification.enforcementClass +
          ' boundary ' +
          describeBoundary(actualBoundary) +
          ' (fingerprint ' +
          actualBoundary.fingerprint +
          '), worktree ' +
          o.workspace.workspaceId,
        ...(profile.path === undefined ? {} : { settingsPath: profile.path }),
        sandboxProfileDigest: profile.digest,
      },
    });

    const tx = deps.store.begin();
    audit(tx, {
      action: AuditAction.PRODUCER_DISPATCHED,
      subject: run.runId,
      outcome: run.outcome === RunOutcome.COMPLETED ? 'OK' : 'FAILED',
      detail: {
        workItemId: o.item.workItemId,
        agentId: contract.id,
        workspaceId: o.workspace.workspaceId,
        sandboxProfileDigest: profile.digest,
        substrateClass: deps.qualification.enforcementClass,
        executionBoundary: describeBoundary(actualBoundary),
        boundaryFingerprint: actualBoundary.fingerprint,
      },
    });
    tx.commit();

    /*
     * BIND THE BOUNDARY TO THE RUN THAT RAN INSIDE IT.
     *
     * SPEC: finding SERVA-SELF-ACCEPTANCE-AUTHORITY/SC-SSA-REV-Q1 (MEDIUM), 1.0.1 review.
     *
     * The audit entry above already names the class, but an audit line is a narrative record,
     * not something a resolver reads to decide authority. Acceptance was reading `last-valid`
     * instead — "what did this machine most recently measure" — to answer "what did THIS run
     * run under". They come apart as soon as anything measures again, and they did: running
     * `serva engineering doctor` against a preserved live store overwrote `last-valid` hours
     * after the run being judged.
     *
     * Written after the dispatch rather than before it, so what is recorded is the boundary a
     * run that actually happened ran inside.
     */
    recordRunQualification(deps.store, run.runId, deps.qualification);

    return {
      runId: run.runId,
      outcome: run.outcome,
      ...(resultOf<ProducerResult>(run, ProducerResultSchema) === undefined
        ? {}
        : { result: resultOf<ProducerResult>(run, ProducerResultSchema)! }),
      sandboxProfile: profile,
      diagnostics: [statusLine, ...run.diagnostics],
      unprovedBoundary: check.unproved,
    };
  } finally {
    // The profile is per-run and lives under `.serva`; leaving it behind would let a
    // later run inherit a boundary nobody chose for it.
    removeSandboxProfile(profile);
  }
}

/* ------------------------------------------------------------------ reviewer */

export interface ReviewerDispatch {
  readonly runId: string;
  readonly outcome: RunOutcome;
  readonly review?: PersistedReview;
  readonly problems: readonly string[];
}

/**
 * Dispatch the independent reviewer and persist a verdict only if it validates.
 *
 * The reviewer gets: the work item, the acceptance criteria, the exact ChangeSet, the
 * measured evidence, and the diff. It does NOT get the Producer's reasoning — a
 * reviewer that can read the argument reviews the argument rather than the artifact,
 * and the independence the gate depends on is gone.
 */
export async function dispatchReviewer(
  deps: DispatchDeps,
  o: {
    readonly item: EngineeringWorkItem;
    readonly workspace: EngineeringWorkspace;
    readonly changeSet: ChangeSet;
    readonly evidence: readonly EngineeringEvidence[];
    readonly diff: string;
    readonly producerRunRef?: string;
    readonly criterionId?: 'EC-REVIEW' | 'EC-QA';
  },
): Promise<ReviewerDispatch> {
  const criterionId = o.criterionId ?? 'EC-REVIEW';
  const contract = deps.registry.get(o.item.reviewerAgentId);

  if (contract.id === o.item.producerAgentId) {
    return fail({
      code: 'E_VALIDATION',
      message:
        'The reviewer and the producer are the same agent: an agent never certifies its own work',
      remedy: 'An agent never certifies its own work (SC-POL-006).',
      details: { agentId: contract.id },
      specRef: 'SC-POL-006',
    });
  }

  const policy = resolveReviewerPolicy(
    o.workspace,
    deps.projectRoot,
    deps.toExecutionPath === undefined ? {} : { toExecutionPath: deps.toExecutionPath },
  );

  const run = await deps.runtime.run({
    agentId: contract.id,
    workItemId: o.item.workItemId,
    taskDefinition:
      'Review ChangeSet ' +
      o.changeSet.changeSetId +
      ' against the requirements and acceptance criteria below. Decide whether the change does what was asked, stays in scope, and is correct. ' +
      'Answer for criterion ' +
      criterionId +
      ', and echo the ChangeSet id you reviewed. ' +
      'You have read-only access to the worktree; you cannot and must not change anything.',
    scopeBoundary:
      'Review only ChangeSet ' +
      o.changeSet.changeSetId +
      '. Do not review the repository at large, and do not propose work outside the declared scope.',
    resultSchema: REVIEWER_RESULT_SCHEMA,
    resultValidator: ReviewerVerdictSchema,
    canon: [
      {
        source: 'work-item',
        kind: 'REQUIREMENTS',
        version: '1',
        content:
          o.item.requirements.map((r) => '- ' + r).join('\n') +
          '\n\nAcceptance criteria:\n' +
          o.item.acceptanceCriteria.map((a) => '- ' + a).join('\n') +
          '\n\nDeclared scope: ' +
          o.item.allowedScope.join(', '),
        relevance: 1,
      },
      {
        source: 'changeset',
        kind: 'CHANGESET',
        version: o.changeSet.digest,
        content:
          'ChangeSet ' +
          o.changeSet.changeSetId +
          ' (base ' +
          o.changeSet.baseCommit +
          ')\n' +
          o.changeSet.entries.map((e) => '  ' + e.status + ' ' + e.path).join('\n'),
        relevance: 1,
      },
      {
        // Measurements, not claims. The reviewer judges what a runtime component
        // observed, and is told plainly which is which.
        source: 'evidence',
        kind: 'EVIDENCE',
        version: '1',
        content:
          o.evidence.length === 0
            ? 'No deterministic evidence was captured for this ChangeSet.'
            : o.evidence
                .map(
                  (e) =>
                    '[' +
                    e.outcome +
                    '] ' +
                    (e.runtimeComponentId ?? 'JUDGED') +
                    ' (' +
                    e.basis +
                    '): ' +
                    e.detail,
                )
                .join('\n'),
        relevance: 1,
      },
    ],
    workspace: [
      {
        source: 'diff',
        version: o.changeSet.diffDigest,
        content: o.diff,
        relevance: 1,
      },
    ],
    capability: {
      policy,
      cwd: o.workspace.path,
      basis: 'independent reviewer, read-only, separate run and separate session',
    },
  });

  if (run.outcome !== RunOutcome.COMPLETED || run.envelope === undefined) {
    return {
      runId: run.runId,
      outcome: run.outcome,
      problems: [
        'The reviewer run ended ' + run.outcome + '. NO EVIDENCE = NOT VERIFIED.',
        ...run.diagnostics,
      ],
    };
  }

  const tx = deps.store.begin();
  let review: PersistedReview;
  try {
    review = recordReview(tx, {
      store: deps.store,
      id: deps.ids.next('SC-REV'),
      runRef: run.runId,
      expectedReviewerAgentId: contract.id,
      producerAgentId: o.item.producerAgentId,
      ...(o.producerRunRef === undefined ? {} : { producerRunRef: o.producerRunRef }),
      changeSetId: o.changeSet.changeSetId,
      workItemId: o.item.workItemId,
      verdict: (run.envelope as { result?: unknown }).result,
      recordedAt: deps.clock.now(),
    });
    audit(tx, {
      action: AuditAction.REVIEW_RECORDED,
      subject: review.id,
      outcome: 'OK',
      detail: {
        changeSetId: review.changeSetId,
        reviewerAgentId: review.reviewerAgentId,
        runRef: review.runRef,
        outcome: review.outcome,
      },
    });
    tx.commit();
  } catch (e) {
    tx.rollback();
    throw e;
  }

  return { runId: run.runId, outcome: run.outcome, review, problems: [] };
}

/** The validated role payload from a completed run, or undefined. */
function resultOf<T>(
  run: AgentRunResult,
  schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } },
): T | undefined {
  if (run.envelope === undefined) return undefined;
  const parsed = schema.safeParse((run.envelope as { result?: unknown }).result);
  return parsed.success ? parsed.data : undefined;
}
