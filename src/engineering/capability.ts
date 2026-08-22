import { resolve } from 'node:path';
import { fail } from '../core/errors.js';
import { EnforcementClass } from '../vocab/index.js';
import {
  ALWAYS_DENY_TOOLS,
  PHASE3_READ_TOOLS,
  SERVA_INTERNAL_DIR,
  absoluteRule,
  parseToolSurface,
  relativeRule,
} from '../agents/toolPolicy.js';
import { engineeringAuthorityRefusal, type SubstrateQualification } from '../substrate/types.js';
import {
  BoundaryPurpose,
  boundaryMismatch,
  describeBoundary,
  type ExecutionBoundary,
} from '../substrate/boundary.js';
import type { AgentContract } from '../agents/schema.js';
import type { ToolPolicy } from '../engine/types.js';
import type { EngineeringWorkspace } from './workspace.js';

/**
 * Producer capability. SPEC: Phase 4 §9–§10, 19 §5, 33 PC-5.
 *
 * The gate every dangerous capability passes through, and the NINE things that must
 * all be true before an agent may write a byte:
 *
 *   0. the boundary that earned HARD is the boundary this run will use
 *   1. the substrate is qualified HARD
 *   2. the agent's contract loads
 *   3. the agent is in the enabled set for this task
 *   4. the contract actually declares the capability being requested
 *   5. an isolated worktree exists
 *   6. the worktree is not the primary checkout
 *   7. an independent reviewer is available
 *   8. the required evidence executors are available
 *
 * Condition 0 was missing, and its absence was the defect that mattered most. Serva
 * qualified a WSL2 guest and then dispatched a Producer onto native Windows, and every
 * other condition passed, because `enforcementClass === HARD` is a claim with no
 * subject. A measurement is a measurement OF something; authority from it is authority
 * to run THAT thing. It is checked first because it is the one whose failure means the
 * other eight were answering the wrong question.
 *
 * Any one of them false gives `CAPABILITY_NOT_ENABLED` with the reason. **There is no
 * silent downgrade**: an agent that asked to write and was quietly given read-only
 * would report on work it never did, which is worse than a refusal that says so.
 */

/** The engineering tools a Producer may receive, and nothing beyond them. */
export const PRODUCER_TOOLS: readonly string[] = Object.freeze([
  ...PHASE3_READ_TOOLS,
  'Edit',
  'Write',
  'Bash',
]);

/**
 * Denied to a Producer whatever its contract says.
 *
 * `Agent` and `Task` are here because a Producer that could spawn a subagent would be
 * running an ungoverned run inside a governed one — the company structure would move
 * inside the engine, which is exactly what Phase 3 §19 refused.
 */
export const PRODUCER_FORBIDDEN_TOOLS: readonly string[] = Object.freeze([
  'Agent',
  'Task',
  'WebFetch',
  'WebSearch',
  'Monitor',
  'CronCreate',
  'CronDelete',
  'SendMessage',
  'Artifact',
  'NotebookEdit',
]);

/**
 * Git verbs a Producer may never run, enforced as Bash deny rules.
 *
 * Serva owns Git (Phase 4 §22). A Producer edits source artifacts; it does not
 * administer history, and it certainly does not publish.
 */
export const PRODUCER_DENIED_COMMANDS: readonly string[] = Object.freeze([
  'Bash(git push*)',
  'Bash(git remote*)',
  'Bash(git config*)',
  'Bash(git merge*)',
  'Bash(git rebase*)',
  'Bash(git reset*)',
  'Bash(git clean*)',
  'Bash(git filter-branch*)',
  'Bash(git submodule*)',
  'Bash(git worktree*)',
  'Bash(gh *)',
  'Bash(curl*)',
  'Bash(wget*)',
  'Bash(ssh*)',
  'Bash(scp*)',
  'Bash(npm publish*)',
  'Bash(sudo*)',
]);

export interface ProducerGateInput {
  readonly contract: AgentContract;
  readonly qualification: SubstrateQualification;
  readonly enabledProducers: ReadonlySet<string>;
  readonly workspace?: EngineeringWorkspace;
  readonly projectRoot: string;
  readonly reviewerAvailable: boolean;
  readonly executorsAvailable: boolean;
  readonly taskMagnitude?: string;
  /**
   * The boundary this run will ACTUALLY use, observed from the engine in hand.
   *
   * Required, not optional. An optional check is a check somebody forgets, and this is
   * the one that stopped a WSL2 qualification from authorizing a native-Windows
   * Producer. Making it part of the type means no caller can reach write authority
   * without having answered it.
   */
  readonly actualBoundary: ExecutionBoundary;
  /**
   * TEST ONLY. Permit a SIMULATED boundary to authorize a write.
   *
   * Orchestration has to be testable without a qualified machine, and a simulated
   * boundary is how. It is an explicit opt-in rather than a default because the
   * difference between "a boundary declared its outcomes" and "a boundary was measured"
   * is the entire subject of this phase. No file under `src/` sets it, and a test
   * asserts that.
   */
  readonly allowSimulatedBoundary?: boolean;
}

/**
 * Conditions 2–4: the half of the gate that depends only on the agent.
 *
 * Separated because the owner-facing status has to answer "could this agent be
 * dispatched if a worktree existed" BEFORE any worktree exists, and the obvious
 * substitute gets it exactly backwards. Phase 3's `capabilityLevelFor` answers a
 * different question — what READ-ONLY level a contract can be granted — and treats a
 * declared `fs.write` as disqualifying. Every Producer declares `fs.write`, so asking
 * it here reports every Producer as permanently unavailable on a perfectly qualified
 * substrate.
 */
export function producerContractRefusal(
  contract: AgentContract,
  enabledProducers: ReadonlySet<string>,
): string | undefined {
  if (!enabledProducers.has(contract.id)) {
    return (
      contract.id + ' (' + contract.name + ') is not in the enabled Producer set for this phase.'
    );
  }

  if (contract.archetype !== 'PRODUCER') {
    return (
      contract.id +
      ' is a ' +
      contract.archetype +
      ', and write authority belongs to a PRODUCER role (32 §3).'
    );
  }

  const surface = parseToolSurface(contract);
  if (!surface.fsWrite) {
    return (
      contract.id +
      ' does not declare filesystem write in its contract, so granting it would exceed the contract rather than implement it.'
    );
  }
  if (surface.net) {
    return (
      contract.id +
      ' declares network scope ' +
      contract.networkScope +
      ', and Phase 4 grants no network to a Producer: per-host mediation is not available on this transport.'
    );
  }
  return undefined;
}

/** Returns the reason a Producer may not be dispatched, or undefined. */
export function producerRefusal(input: ProducerGateInput): string | undefined {
  /*
   * Condition 0, before anything else.
   *
   * Deliberately ahead of the enforcement-class check: a HARD class for the wrong
   * boundary is more dangerous than no class at all, because it reads as permission.
   */
  const mismatch = boundaryMismatch(input.qualification.boundary, input.actualBoundary);
  if (mismatch !== undefined) return mismatch;

  if (input.actualBoundary.purpose !== BoundaryPurpose.PRODUCER) {
    return (
      'The boundary offered for this run is a ' +
      input.actualBoundary.purpose +
      ' boundary. A Producer must run under a boundary qualified for Producers: the deterministic recipe boundary contains different things, by a different mechanism, and was measured for a different purpose.'
    );
  }

  if (input.actualBoundary.simulated && input.allowSimulatedBoundary !== true) {
    return 'The execution boundary is SIMULATED. A simulation declares its outcomes rather than measuring them, so it does not authorize a run that writes.';
  }

  const substrate = engineeringAuthorityRefusal(input.qualification);
  if (substrate !== undefined) return substrate;

  const contractual = producerContractRefusal(input.contract, input.enabledProducers);
  if (contractual !== undefined) return contractual;

  if (input.workspace === undefined) {
    return 'No isolated worktree exists for this attempt; a Producer never edits the primary checkout.';
  }
  if (resolve(input.workspace.path) === resolve(input.projectRoot)) {
    return 'The workspace resolves to the primary checkout, which a Producer may never modify.';
  }
  if (!input.reviewerAvailable) {
    return 'No independent reviewer is available, and an agent never certifies its own work (SC-POL-006).';
  }
  if (!input.executorsAvailable) {
    return 'The deterministic evidence executors are unavailable; a change nobody can measure cannot be accepted.';
  }
  return undefined;
}

export interface ProducerPolicyOptions {
  readonly contract: AgentContract;
  readonly workspace: EngineeringWorkspace;
  readonly qualification: SubstrateQualification;
  readonly enabledProducers: ReadonlySet<string>;
  readonly projectRoot: string;
  readonly reviewerAvailable: boolean;
  readonly executorsAvailable: boolean;
  /** The boundary this run will actually use. See ProducerGateInput. */
  readonly actualBoundary: ExecutionBoundary;
  /** TEST ONLY. See ProducerGateInput. */
  readonly allowSimulatedBoundary?: boolean;
  /**
   * A host path as the ENGINE will name it.
   *
   * Needed because the grant is computed on the host and enforced in the execution
   * environment. Without it the absolute rules would carry Windows paths, which the
   * engine never sees and which do not survive the `//` anchor.
   */
  readonly toExecutionPath?: (hostPath: string) => string;
}

/**
 * Resolve the write-capable policy for one Producer attempt.
 *
 * The grant is expressed relative to the WORKTREE, not the project: the working
 * directory of an engineering run is its own worktree, so `Edit(**)` means "inside
 * this worktree" and nothing wider. The OS-level sandbox enforces the same boundary
 * independently, and the two are complementary rather than redundant — the permission
 * rules govern the model's own calls, and the sandbox governs everything its commands
 * spawn.
 */
export function resolveProducerPolicy(opts: ProducerPolicyOptions): ToolPolicy {
  const refusal = producerRefusal({
    contract: opts.contract,
    qualification: opts.qualification,
    enabledProducers: opts.enabledProducers,
    workspace: opts.workspace,
    projectRoot: opts.projectRoot,
    reviewerAvailable: opts.reviewerAvailable,
    executorsAvailable: opts.executorsAvailable,
    actualBoundary: opts.actualBoundary,
    ...(opts.allowSimulatedBoundary === undefined
      ? {}
      : { allowSimulatedBoundary: opts.allowSimulatedBoundary }),
  });
  if (refusal !== undefined) {
    return fail({
      code: 'E_CAPABILITY_NOT_ENABLED',
      message: 'Producer ' + opts.contract.id + ' cannot be dispatched: ' + refusal,
      remedy:
        'Write and execute authority requires a HARD substrate, a matching contract, an isolated worktree, an independent reviewer and working evidence executors. Serva does not downgrade the grant to make the dispatch succeed.',
      details: {
        agentId: opts.contract.id,
        enforcementClass: opts.qualification.enforcementClass,
        blockedBy: opts.qualification.blockedBy,
      },
      specRef: 'Phase 4 §9, 33 PC-5',
    });
  }

  const map = opts.toExecutionPath ?? ((p: string): string => p);
  const worktree = map(resolve(opts.workspace.path));
  const servaDir = map(resolve(opts.projectRoot, SERVA_INTERNAL_DIR));

  /*
   * BOTH forms, for every granted tool.
   *
   * The relative rule governs a relative request; the absolute rule governs the same
   * file named by its full path in the execution environment. A grant that covered only
   * one of them is a grant the model can miss by phrasing its call differently.
   */
  const approve = [
    ...PHASE3_READ_TOOLS.map((t) => relativeRule(t, '**')),
    relativeRule('Edit', '**'),
    relativeRule('Write', '**'),
    ...PHASE3_READ_TOOLS.map((t) => absoluteRule(t, worktree + '/**')),
    absoluteRule('Edit', worktree + '/**'),
    absoluteRule('Write', worktree + '/**'),
  ];

  const deny = [
    ...ALWAYS_DENY_TOOLS.filter((t) => !PRODUCER_TOOLS.includes(t)),
    ...PRODUCER_FORBIDDEN_TOOLS,
    ...PRODUCER_DENIED_COMMANDS,
    // The store is denied even though it is outside the worktree, because a deny rule
    // costs nothing and a defence that relies on one boundary has one boundary.
    ...PHASE3_READ_TOOLS.map((t) => relativeRule(t, SERVA_INTERNAL_DIR + '/**')),
    relativeRule('Edit', SERVA_INTERNAL_DIR + '/**'),
    relativeRule('Write', SERVA_INTERNAL_DIR + '/**'),
    // ...and the same denials in absolute form, because deny must cover every way the
    // path can be written, not just the way the allow rule happened to be phrased.
    ...PHASE3_READ_TOOLS.map((t) => absoluteRule(t, servaDir + '/**')),
    absoluteRule('Edit', servaDir + '/**'),
    absoluteRule('Write', servaDir + '/**'),
    ...PHASE3_READ_TOOLS.map((t) => absoluteRule(t, worktree + '/' + SERVA_INTERNAL_DIR + '/**')),
  ];

  return {
    available: [...PRODUCER_TOOLS],
    approve,
    deny,
    filesystem: {
      read: [resolve(opts.workspace.path)],
      write: [resolve(opts.workspace.path)],
      readDenied: [resolve(opts.projectRoot, SERVA_INTERNAL_DIR)],
    },
    network: 'NONE',
    maxToolCalls: 200,
    rationale: [
      'substrate: ' + opts.qualification.enforcementClass + ' (qualified)',
      'execution boundary: ' + describeBoundary(opts.actualBoundary),
      'boundary fingerprint: ' + opts.actualBoundary.fingerprint,
      'contract tool surface: ' + opts.contract.tools,
      'worktree: ' + opts.workspace.path,
      'the primary checkout is not writable by this run',
      'git history operations and all publishing verbs are denied',
      'network: NONE',
      'OS-level sandbox enforces the same write scope for child processes; the tool rules alone would not',
    ],
  };
}

/**
 * THE OS-SANDBOX QUALIFICATION PROFILE.
 *
 * Serva has two independent defences for a Producer, and until now it had only ever
 * measured the first:
 *
 *   1. the TOOL PERMISSION layer, which decides whether a call runs at all, and
 *   2. the OS SANDBOX, which decides what a call that DID run is able to touch.
 *
 * Every escape probe in the previous cross-check was auto-denied at layer 1 — correct
 * behaviour, and completely uninformative about layer 2. Nine denials were recorded and
 * not one of them was evidence that the sandbox works, because no command ever reached
 * it. "Denied" and "contained" are different findings and had been collapsed into one.
 *
 * So this profile deliberately PRE-APPROVES the probe commands, including ones the
 * production grant refuses outright, in order to hand them to the operating system and
 * see what the operating system does. That is the only way to obtain the measurement.
 *
 * Which is exactly why it is a separate function with its own name, its own rationale,
 * and a `qualificationOnly` marker in that rationale that the production path asserts is
 * absent. It approves what a Producer must never be allowed to attempt; if it ever
 * became the default grant, Serva would have built the hole it is trying to prove is
 * closed.
 *
 * It is NEVER reachable from `resolveProducerPolicy`, is not derived from a contract,
 * and is used by one caller: the activation qualification harness.
 */
export const OS_SANDBOX_QUALIFICATION = 'OS_SANDBOX_QUALIFICATION';

/** The marker every qualification policy carries and no production policy may. */
export const QUALIFICATION_ONLY_MARKER =
  'QUALIFICATION ONLY: this grant pre-approves commands a Producer may never run. It is not a Producer grant.';

export interface OsSandboxQualificationOptions {
  readonly workspace: EngineeringWorkspace;
  readonly projectRoot: string;
  /** The probe commands, as permission rules. Nothing else is approved. */
  readonly probeCommands: readonly string[];
  readonly toExecutionPath?: (hostPath: string) => string;
}

export function resolveOsSandboxQualificationPolicy(
  opts: OsSandboxQualificationOptions,
): ToolPolicy {
  const map = opts.toExecutionPath ?? ((p: string): string => p);
  const worktree = map(resolve(opts.workspace.path));

  return {
    available: [...PRODUCER_TOOLS],
    /*
     * The probe commands are approved BY NAME. Not `Bash(*)`, not `Bash(node:*)` as a
     * blanket — each individual shape the qualification intends to run, so the set of
     * things this profile can do is readable in one glance and cannot grow by accident.
     */
    approve: [
      ...PHASE3_READ_TOOLS.map((t) => relativeRule(t, '**')),
      relativeRule('Edit', '**'),
      relativeRule('Write', '**'),
      ...PHASE3_READ_TOOLS.map((t) => absoluteRule(t, worktree + '/**')),
      absoluteRule('Edit', worktree + '/**'),
      absoluteRule('Write', worktree + '/**'),
      ...opts.probeCommands,
    ],
    /*
     * The command denials of the production grant are NOT applied.
     *
     * `Bash(curl*)` would refuse the network probe at layer 1, and the whole point is to
     * find out whether layer 2 refuses it. Tool-level denials that have nothing to do
     * with the measurement — subagents, web fetch, notebooks — stay denied, because
     * widening those would buy no evidence at all.
     */
    deny: [
      ...ALWAYS_DENY_TOOLS.filter((t) => !PRODUCER_TOOLS.includes(t)),
      ...PRODUCER_FORBIDDEN_TOOLS,
    ],
    filesystem: {
      read: [resolve(opts.workspace.path)],
      write: [resolve(opts.workspace.path)],
      readDenied: [resolve(opts.projectRoot, SERVA_INTERNAL_DIR)],
    },
    network: 'NONE',
    maxToolCalls: 60,
    rationale: [
      QUALIFICATION_ONLY_MARKER,
      'purpose: ' + OS_SANDBOX_QUALIFICATION,
      'the tool permission layer is deliberately opened for the probe commands so that the OS sandbox is the layer under test',
      'probe commands approved: ' + String(opts.probeCommands.length),
      'worktree: ' + opts.workspace.path,
      'a denial recorded under this profile is an OS denial, not a permission denial',
    ],
  };
}

/**
 * The reviewer's policy. Read-only, always, whatever the substrate can do.
 *
 * A reviewer that could edit the artifact under review would be a producer with an
 * opinion, and the independence the gate depends on would be gone (SC-POL-006).
 */
export function resolveReviewerPolicy(
  workspace: EngineeringWorkspace,
  projectRoot: string,
  opts: { readonly toExecutionPath?: (hostPath: string) => string } = {},
): ToolPolicy {
  const map = opts.toExecutionPath ?? ((x: string): string => x);
  const worktree = map(resolve(workspace.path));
  const servaDir = map(resolve(projectRoot, SERVA_INTERNAL_DIR));

  return {
    available: [...PHASE3_READ_TOOLS],
    /*
     * Relative AND absolute, scoped to this worktree and nothing else.
     *
     * A reviewer given only `Read(**)` was refused every read: it names files by their
     * absolute path in the execution environment, which a cwd-relative rule does not
     * match, so under `dontAsk` every call was auto-denied. It then truthfully reported
     * the denial and could not review the change it had been dispatched to review.
     *
     * The absolute grant covers the worktree subtree only — nothing above it, no
     * sibling worktree, no project root.
     */
    approve: [
      ...PHASE3_READ_TOOLS.map((t) => relativeRule(t, '**')),
      ...PHASE3_READ_TOOLS.map((t) => absoluteRule(t, worktree + '/**')),
    ],
    deny: [
      ...ALWAYS_DENY_TOOLS,
      'Edit',
      'Write',
      'Bash',
      ...PRODUCER_DENIED_COMMANDS,
      ...PHASE3_READ_TOOLS.map((t) => relativeRule(t, SERVA_INTERNAL_DIR + '/**')),
      // The same denials in absolute form: deny must cover every way the path can be
      // written, not only the way the allow rule happened to be phrased.
      ...PHASE3_READ_TOOLS.map((t) => absoluteRule(t, servaDir + '/**')),
      ...PHASE3_READ_TOOLS.map((t) => absoluteRule(t, worktree + '/' + SERVA_INTERNAL_DIR + '/**')),
    ],
    filesystem: {
      read: [resolve(workspace.path)],
      write: [],
      readDenied: [resolve(projectRoot, SERVA_INTERNAL_DIR)],
    },
    network: 'NONE',
    maxToolCalls: 60,
    rationale: [
      'reviewer: read-only by construction, not by configuration',
      'worktree under review: ' + workspace.path,
      'granted in the execution environment as: ' + worktree,
      'no write tool is available, so there is nothing to widen',
    ],
  };
}

export { EnforcementClass };
