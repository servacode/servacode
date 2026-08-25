import { z } from 'zod';
import { REQUIRED_SCOPE, ReviewVerdict, Severity } from './securityReview.js';
import type { SecurityReview } from './securityReview.js';
import type { AgentRunResult, AgentRuntime } from '../agents/runtime.js';
import { ALWAYS_DENY_TOOLS, NEVER_AVAILABLE } from '../agents/toolPolicy.js';
import type { ToolPolicy } from '../engine/types.js';

/**
 * THE INDEPENDENT SECURITY REVIEW, PERFORMED RATHER THAN WRITTEN DOWN.
 *
 * SPEC: Phase 6 final acceptance sequence §7.
 *
 * `securityReview.ts` could already refuse a bad review. Nothing could produce a good one —
 * the verifier was reachable only from its own tests, so the single way to obtain a green
 * Security Acceptance was to author the JSON by hand. A verifier whose only supported input
 * is a hand-written file verifies the author's typing.
 *
 * This dispatches the review as a real governed run of SC-AGENT-220, a VERIFIER whose contract
 * declares `filesystemScope: write = NONE` and `networkScope: NONE`. The independence §7
 * demands is therefore structural rather than asserted: the reviewer cannot modify what it
 * reviews, because the contract that binds it does not grant it the authority to.
 *
 * The run's output is a judgement and nothing more. Everything a judgement must not be
 * trusted about — which commit it describes, which run made it, whether its verdict agrees
 * with its own findings — is re-derived by `resolveSecurityReview` afterwards, against the
 * repository and the store. This module produces evidence; it does not accept it.
 */

/** The finding shape the reviewer returns, mirroring `SecurityFindingSchema`. */
export const ReviewFindingSchema = z
  .object({
    id: z.string().min(1),
    severity: z.enum([
      Severity.CRITICAL,
      Severity.HIGH,
      Severity.MEDIUM,
      Severity.LOW,
      Severity.INFO,
    ]),
    area: z.string().min(1),
    statement: z.string().min(1),
    evidence: z.array(z.string().min(1)).min(1),
  })
  .strict();

export const ReviewResultSchema = z
  .object({
    scope: z.array(z.string().min(1)).min(1),
    findings: z.array(ReviewFindingSchema),
    verdict: z.enum([ReviewVerdict.ACCEPTED, ReviewVerdict.BLOCKED, ReviewVerdict.NOT_VERIFIED]),
    summary: z.string().min(1),
  })
  .strict();
export type ReviewResult = z.output<typeof ReviewResultSchema>;

/** The same shape, as JSON Schema, for the provider. */
export const REVIEW_RESULT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['scope', 'findings', 'verdict', 'summary'],
  properties: {
    scope: {
      type: 'array',
      minItems: 1,
      items: { type: 'string' },
      description: 'Every area you actually examined, named as given to you.',
    },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'severity', 'area', 'statement', 'evidence'],
        properties: {
          id: { type: 'string' },
          severity: { enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'] },
          area: { type: 'string' },
          statement: { type: 'string' },
          evidence: {
            type: 'array',
            minItems: 1,
            items: { type: 'string' },
            description:
              'file:line references you actually read. A finding with nothing behind it cannot be acted on.',
          },
        },
      },
    },
    verdict: { enum: ['ACCEPTED', 'BLOCKED', 'NOT_VERIFIED'] },
    summary: { type: 'string' },
  },
};

/**
 * The grant this review runs under: read the source, and nothing else.
 *
 * SPEC: 19 §5, SC-POL-026; Phase 6 final acceptance sequence §7.
 *
 * `SC-AGENT-220`'s contract declares `exec(declared security test commands)`, so
 * `resolveToolPolicy` refuses it outright — execute is enforceable only on the isolation
 * substrate, and a policy resolver that guessed otherwise would be granting authority nothing
 * can hold. That refusal is correct and stays.
 *
 * But this review does not execute anything. It reads source it is handed and returns a
 * judgement, so the honest fix is to state that narrowly rather than to relax the resolver: an
 * explicit grant, strictly smaller than the contract, carrying no Bash, no write and no
 * network. `assertGrantWithinContract` then proves it does not exceed what the contract allows
 * — a grant implements a contract, it never extends one — and CAPABILITY_BOUND records what
 * was actually bound rather than what would have been derived.
 *
 * The empty `approve` list is deliberate and is not an oversight: under `dontAsk` an available
 * tool with no approving rule is refused, and the reviewer needs no tool at all. Its evidence
 * arrives as context. This is the same shape as the Producer's missing `Bash(...)` rule, which
 * is the invariant that makes a measured result trustworthy in the first place.
 */
function readOnlyGrant(): ToolPolicy {
  return {
    available: [],
    approve: [],
    deny: [...NEVER_GRANTED],
    filesystem: { read: [], write: [], readDenied: [] },
    network: 'NONE',
    maxToolCalls: 0,
    rationale: [
      'independent security review: judgement only, on source supplied as context',
      'no tool is available, which 19 IV-5 makes a valid grant meaning no tools at all',
      'strictly narrower than the contract: no execution, no filesystem write, no network',
    ],
  };
}

/**
 * Denied whatever else is granted.
 *
 * Derived from the canonical lists rather than restated, because a second hand-maintained copy
 * drifts from the first and the drift is silent — `assertGrantWithinContract` refused this
 * grant for omitting `Monitor`, which a literal list had simply never heard of.
 */
const NEVER_GRANTED: readonly string[] = Object.freeze([
  ...ALWAYS_DENY_TOOLS,
  ...NEVER_AVAILABLE,
  'Bash',
  'PowerShell',
  'Edit',
  'Write',
]);

export interface SecurityReviewRunInput {
  readonly runtime: AgentRuntime;
  readonly workItemId: string;
  readonly repository: { readonly commit: string; readonly tree: string };
  /** Where the reviewer run will be recorded, written into the review for re-resolution. */
  readonly storePath: string;
  /** Actors that produced the reviewed work. Recorded so independence can be checked. */
  readonly implementationProducers: readonly string[];
  readonly reviewedAt: string;
  readonly agentId?: string;
  /** Read-only context the reviewer judges. Measurements and source, never conclusions. */
  readonly canon?: readonly {
    source: string;
    kind: string;
    version: string;
    content: string;
    relevance: number;
  }[];
}

export interface SecurityReviewRunOutcome {
  readonly run: AgentRunResult;
  /** Absent when the run did not produce a usable judgement. Never fabricated. */
  readonly review?: SecurityReview;
  readonly refusals: readonly string[];
}

export const DEFAULT_SECURITY_REVIEWER = 'SC-AGENT-220';

const TASK =
  'Perform an independent security review of this implementation at the exact commit given to you. ' +
  'For every area in the scope list, decide whether the boundary it names actually holds in the code you can read, ' +
  'and record what you looked at. Report findings with severities, and give a verdict that follows from them: ' +
  'ACCEPTED only if you found no CRITICAL and no HIGH finding, BLOCKED if you did, ' +
  'NOT_VERIFIED if you could not complete the review. ' +
  'Do not modify anything — you hold no write authority, and a reviewer that changes what it reviews has reviewed nothing. ' +
  'Do not report a finding you cannot point at. An unsupported finding wastes the same attention a real one needs.';

/**
 * Dispatch the review and shape its judgement into a `SecurityReview`.
 *
 * The reviewer supplies only what a reviewer is entitled to supply: scope, findings, verdict.
 * Commit, tree, run id, agent id and store path are stamped from measured facts the caller
 * already holds — a reviewer that could name its own commit could review one thing and
 * certify another.
 */
export async function runSecurityReview(
  input: SecurityReviewRunInput,
): Promise<SecurityReviewRunOutcome> {
  const agentId = input.agentId ?? DEFAULT_SECURITY_REVIEWER;

  const run = await input.runtime.run({
    agentId,
    workItemId: input.workItemId,
    taskDefinition:
      TASK +
      '\n\nCommit under review: ' +
      input.repository.commit +
      '\n\nScope — report on each of these by name:\n' +
      REQUIRED_SCOPE.map((s) => '- ' + s).join('\n'),
    scopeBoundary:
      'Review the implementation at commit ' +
      input.repository.commit +
      ' only. Read-only: do not write, do not execute, do not reach the network. ' +
      'Do not review work outside the declared scope, and do not propose changes.',
    resultSchema: REVIEW_RESULT_SCHEMA,
    resultValidator: ReviewResultSchema,
    capability: {
      policy: readOnlyGrant(),
      cwd: input.storePath,
      basis:
        'independent security review of ' +
        input.repository.commit.slice(0, 12) +
        ': read-only judgement, no execution, no write, no network',
    },
    ...(input.canon === undefined ? {} : { canon: input.canon }),
  });

  const refusals: string[] = [];
  if (run.outcome !== 'COMPLETED') {
    refusals.push('the reviewer run ended ' + String(run.outcome) + ', so it judged nothing');
    return { run, refusals };
  }

  const parsed = ReviewResultSchema.safeParse(run.envelope?.result);
  if (!parsed.success) {
    /*
     * The runtime validates before reaching COMPLETED, so this is unreachable in practice.
     * It is still checked, because "unreachable" is a claim about today's code and this
     * module must not synthesize a review out of a shape it did not recognize.
     */
    refusals.push('the reviewer returned a result this module could not read');
    return { run, refusals };
  }
  const result = parsed.data;

  const review: SecurityReview = {
    implementationCommit: input.repository.commit,
    treeDigest: input.repository.tree,
    reviewerRunId: run.runId,
    reviewerAgentId: agentId,
    reviewerAuthority: 'VERIFY',
    independence: {
      implementationProducers: [...input.implementationProducers],
      statement:
        agentId +
        ' is a VERIFIER whose contract declares write = NONE and network = NONE, dispatched separately from the ' +
        'agents that produced the reviewed work and holding no authority to modify it.',
    },
    scope: result.scope,
    findings: result.findings,
    verdict: result.verdict,
    reviewedAt: input.reviewedAt,
    storePath: input.storePath,
  };

  return { run, review, refusals };
}
