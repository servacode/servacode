import { resolve } from 'node:path';
import { fail } from '../core/errors.js';
import { EnforcementClass } from '../vocab/index.js';
import {
  ALWAYS_DENY_TOOLS,
  PHASE3_READ_TOOLS,
  SERVA_INTERNAL_DIR,
  parseToolSurface,
  relativeRule,
} from '../agents/toolPolicy.js';
import { engineeringAuthorityRefusal, type SubstrateQualification } from '../substrate/types.js';
import type { AgentContract } from '../agents/schema.js';
import type { ToolPolicy } from '../engine/types.js';
import type { EngineeringWorkspace } from './workspace.js';

/**
 * Producer capability. SPEC: Phase 4 §9–§10, 19 §5, 33 PC-5.
 *
 * The gate every dangerous capability passes through, and the eight things that must
 * all be true before an agent may write a byte:
 *
 *   1. the substrate is qualified HARD
 *   2. the agent's contract loads
 *   3. the agent is in the enabled set for this task
 *   4. the contract actually declares the capability being requested
 *   5. an isolated worktree exists
 *   6. the worktree is not the primary checkout
 *   7. an independent reviewer is available
 *   8. the required evidence executors are available
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
  /** Recipes the Producer may invoke through Bash. Empty is valid and common. */
  readonly allowedCommands?: readonly string[];
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

  const approve = [
    ...PHASE3_READ_TOOLS.map((t) => relativeRule(t, '**')),
    relativeRule('Edit', '**'),
    relativeRule('Write', '**'),
    ...(opts.allowedCommands ?? []),
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
 * The reviewer's policy. Read-only, always, whatever the substrate can do.
 *
 * A reviewer that could edit the artifact under review would be a producer with an
 * opinion, and the independence the gate depends on would be gone (SC-POL-006).
 */
export function resolveReviewerPolicy(
  workspace: EngineeringWorkspace,
  projectRoot: string,
): ToolPolicy {
  return {
    available: [...PHASE3_READ_TOOLS],
    approve: PHASE3_READ_TOOLS.map((t) => relativeRule(t, '**')),
    deny: [
      ...ALWAYS_DENY_TOOLS,
      'Edit',
      'Write',
      'Bash',
      ...PRODUCER_DENIED_COMMANDS,
      ...PHASE3_READ_TOOLS.map((t) => relativeRule(t, SERVA_INTERNAL_DIR + '/**')),
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
      'no write tool is available, so there is nothing to widen',
    ],
  };
}

export { EnforcementClass };
