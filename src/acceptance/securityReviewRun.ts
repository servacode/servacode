import { z } from 'zod';
import { REQUIRED_SCOPE, ReviewVerdict, Severity } from './securityReview.js';
import type { SecurityFinding, SecurityReview } from './securityReview.js';
import type { AgentRunResult, AgentRuntime } from '../agents/runtime.js';
import { ALWAYS_DENY_TOOLS, NEVER_AVAILABLE } from '../agents/toolPolicy.js';
import type { ToolPolicy } from '../engine/types.js';
import type { Store } from '../store/store.js';
import {
  ScopeCoverage,
  recordScopeReview,
  scopeIdOf,
  type ScopeReviewInput,
} from './scopeReview.js';

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

/**
 * WHICH SOURCE EACH SCOPED AREA IS ABOUT.
 *
 * SPEC: Phase 6 final acceptance sequence §7.
 *
 * The first version of this handed one reviewer the whole codebase and asked about all
 * seventeen areas at once. 2.36MB of TypeScript does not fit an 80K context, so the bundle was
 * truncated to the first 40 files — and the reviewer refused, correctly: it will not certify
 * what it was not shown. `INSUFFICIENT_CONTEXT` was the honest answer and the right one.
 *
 * A real security review is scoped by area, so this is too. Each area names the paths it is
 * actually about, gets its own governed run, and stays inside a budget that lets the reviewer
 * read rather than skim. A review of seventeen areas at once is not seventeen reviews.
 *
 * The patterns are PREFIXES against repository-relative POSIX paths. An area matching nothing
 * is a defect in this table rather than a clean result, and `reviewAreaFiles` reports it as
 * such instead of quietly returning an empty bundle.
 */
export const AREA_SOURCES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'Core Store/integrity': ['src/store/', 'src/events/', 'src/core/'],
  'Owner authority': ['src/app/conversation.ts', 'src/gates/', 'src/policy/', 'src/app/owner'],
  'AI Runtime': ['src/agents/', 'src/engine/', 'src/orchestration/'],
  'Engineering HARD boundary': [
    'src/engineering/capability.ts',
    'src/engineering/dispatch.ts',
    'src/engineering/sandboxProfile.ts',
    'src/engineering/osQualification.ts',
    'src/engineering/workspace.ts',
  ],
  'qualification transport semantics': ['src/substrate/', 'src/engineering/engine.ts'],
  'Research trust': ['src/intelligence/research/', 'src/context/'],
  'VS Code/webview authority': ['src/extension/', 'extension/src/', 'src/vscode/'],
  'New Project flow': ['src/app/create.ts', 'src/app/runtime.ts', 'src/app/implement.ts'],
  'Conversation governance': ['src/app/conversation.ts', 'src/orchestration/', 'src/workflow/'],
  Reconciliation: ['src/engineering/reconcile.ts', 'src/lifecycle/'],
  'backup/restore': ['src/portability/'],
  migration: ['src/portability/', 'src/store/'],
  bootstrap: ['src/cli/commands/', 'src/substrate/'],
  'install/update/rollback': ['src/portability/', 'src/cli/commands/'],
  'organizational learning': ['src/learning/', 'src/intelligence/'],
  'release/handover': ['src/portability/', 'src/lifecycle/'],
  'Serva self-acceptance authority': ['src/acceptance/'],
});

/**
 * AREAS THAT ARE TOO LARGE TO REVIEW IN ONE SITTING, SPLIT DETERMINISTICALLY.
 *
 * SPEC: Phase 6 final acceptance sequence §7.
 *
 * `organizational learning` maps to the whole intelligence tree — seventy files — and the
 * reviewer returned NOT_VERIFIED with forty-one of them omitted. It was right to: a partial
 * view is not coverage, and rounding it up would be the worst possible answer.
 *
 * The fix is not one enormous budget. A reviewer given seventy files at once skims all of
 * them; the point of scoping is that each run can actually read what it is judging. So an
 * oversized area is partitioned into named sub-scopes that between them cover every path the
 * area maps to, each reviewed in its own governed run.
 *
 * The area is covered only when EVERY sub-scope is, which is what keeps the split honest —
 * splitting a thing you cannot finish does not make it finished, it just makes the gap easier
 * to see. `REQUIRED_SCOPE` is unchanged: this is how an area is reviewed, not which areas are.
 */
export interface SubScope {
  readonly prefixes: readonly string[];
  /**
   * Paths this sub-scope leaves to another one.
   *
   * `src/intelligence/` is a prefix of every directory beneath it, so the unit that reviews
   * the tree's own files has to say which subtrees belong elsewhere. Without this the
   * partition overlaps, one unit inherits the whole area again, and the split achieves
   * nothing — which is exactly what the first version did.
   */
  readonly except?: readonly string[];
}

export const AREA_SUBSCOPES: Readonly<Record<string, Readonly<Record<string, SubScope>>>> =
  Object.freeze({
    'organizational learning': Object.freeze({
      'organizational learning — artifacts': { prefixes: ['src/intelligence/artifacts/'] },
      'organizational learning — departments A': {
        prefixes: ['src/intelligence/departments/'],
        except: [
          'src/intelligence/departments/quality',
          'src/intelligence/departments/release',
          'src/intelligence/departments/research',
          'src/intelligence/departments/dataSecurity',
        ],
      },
      'organizational learning — departments B': {
        prefixes: [
          'src/intelligence/departments/quality',
          'src/intelligence/departments/release',
          'src/intelligence/departments/research',
          'src/intelligence/departments/dataSecurity',
        ],
      },
      'organizational learning — execution and research': {
        prefixes: ['src/intelligence/execution/', 'src/intelligence/research/'],
      },
      'organizational learning — gates, checks and views': {
        prefixes: [
          'src/intelligence/gates/',
          'src/intelligence/checks/',
          'src/intelligence/views/',
        ],
      },
      'organizational learning — core': {
        prefixes: ['src/intelligence/', 'src/learning/'],
        except: [
          'src/intelligence/artifacts/',
          'src/intelligence/departments/',
          'src/intelligence/execution/',
          'src/intelligence/research/',
          'src/intelligence/gates/',
          'src/intelligence/checks/',
          'src/intelligence/views/',
        ],
      },
    }),
  });

/**
 * The units one required area is actually reviewed in.
 *
 * A single unit named for the area itself, unless it is partitioned above. Every unit carries
 * the area it belongs to, so coverage is always decided against `REQUIRED_SCOPE`.
 */
export interface ReviewUnit {
  readonly area: string;
  readonly unit: string;
  readonly prefixes: readonly string[];
  readonly except: readonly string[];
}

export function reviewUnitsFor(area: string): readonly ReviewUnit[] {
  const split = AREA_SUBSCOPES[area];
  if (split === undefined) {
    return [{ area, unit: area, prefixes: AREA_SOURCES[area] ?? [], except: [] }];
  }
  return Object.entries(split).map(([unit, sub]) => ({
    area,
    unit,
    prefixes: sub.prefixes,
    except: sub.except ?? [],
  }));
}

/**
 * Every file an area maps to, and every file its sub-scopes cover.
 *
 * Used to prove a partition leaves nothing behind: a split that quietly dropped a directory
 * would turn an honest NOT_VERIFIED into a false ACCEPTED, which is the one outcome worse than
 * the problem it was meant to solve.
 */
export function partitionGap(area: string, allFiles: readonly string[]): readonly string[] {
  const whole = AREA_SOURCES[area] ?? [];
  const inArea = allFiles.filter((f) => whole.some((prefix) => f.startsWith(prefix)));
  const units = reviewUnitsFor(area);
  const covered = new Set(
    inArea.filter((f) =>
      units.some(
        (u) =>
          u.prefixes.some((prefix) => f.startsWith(prefix)) &&
          !u.except.some((prefix) => f.startsWith(prefix)),
      ),
    ),
  );
  return inArea.filter((f) => !covered.has(f));
}

export interface AreaSource {
  readonly area: string;
  readonly content: string;
  readonly files: readonly string[];
  /** Files the area matched but that did not fit its budget. Never silently dropped. */
  readonly omitted: readonly string[];
}

/**
 * Gather the source one area is about, within a budget the reviewer can actually read.
 *
 * `readFile` is injected so this stays testable without a filesystem, and so the caller owns
 * where "the repository at this commit" actually is.
 */
export function reviewAreaFiles(
  area: string,
  allFiles: readonly string[],
  readFile: (path: string) => string,
  budgetChars = 260_000,
  /** Overrides the area's own prefixes, so one sub-scope can be gathered on its own. */
  prefixOverride?: readonly string[],
  /** Paths belonging to a sibling sub-scope, so a partition does not overlap itself. */
  except: readonly string[] = [],
): AreaSource {
  const prefixes = prefixOverride ?? AREA_SOURCES[area] ?? [];
  const matched = allFiles.filter(
    (f) =>
      prefixes.some((prefix) => f.startsWith(prefix)) &&
      !except.some((prefix) => f.startsWith(prefix)),
  );

  const parts: string[] = [];
  const included: string[] = [];
  const omitted: string[] = [];
  let left = budgetChars;

  for (const f of matched) {
    let text: string;
    try {
      text = readFile(f);
    } catch {
      omitted.push(f);
      continue;
    }
    if (text.length > left) {
      omitted.push(f);
      continue;
    }
    left -= text.length;
    included.push(f);
    parts.push('=== ' + f + ' ===\n' + text);
  }

  return { area, content: parts.join('\n\n'), files: included, omitted };
}

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

const AREA_TASK =
  'Perform an independent security review of ONE AREA of this implementation, at the exact ' +
  'commit given to you. ' +
  'THE SOURCE IS SUPPLIED TO YOU AS CONTEXT — you hold no tools and you are not reading files. ' +
  'Analyse only the text you were given. ' +
  'Decide whether the boundary this area names actually holds in that code, and say what you ' +
  'concluded from which part of it. Report findings with severities, and give a verdict that ' +
  'follows from them: ACCEPTED if you found no CRITICAL and no HIGH finding in this area, ' +
  'BLOCKED if you did, NOT_VERIFIED if the supplied source does not let you decide. ' +
  'Put the area name in `scope`. ' +
  'DESCRIBE YOUR WORK ACCURATELY: say "analysed" or "the supplied source shows", never ' +
  '"I read src/x.ts" or "I ran". A claim to have performed an action you did not perform is ' +
  'contradicted by the runtime and invalidates the whole review — and it would be untrue. ' +
  'This applies to the KIND of any evidence claim you record as much as to its wording: ' +
  'analysing text that was supplied to you is kind OTHER. It is NOT FILE_READ, TOOL_EXECUTION, ' +
  'COMMAND_RUN, FILE_WRITTEN or TEST_RESULT — you completed no tool call, so a claim of any of ' +
  'those kinds is contradicted however carefully its statement is worded. ' +
  'Do not modify anything: you hold no write authority, and a reviewer that changes what it ' +
  'reviews has reviewed nothing. ' +
  'Do not report a finding you cannot point at: cite file:line from the supplied source. ' +
  'An unsupported finding wastes the same attention a real one needs.';

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

export interface AreaReviewOutcome {
  readonly area: string;
  readonly runId: string;
  readonly outcome: string;
  readonly findings: readonly SecurityFinding[];
  readonly verdict: string;
  readonly filesReviewed: readonly string[];
  readonly omitted: readonly string[];
  readonly refusal?: string;
}

export interface ScopedReviewInput extends Omit<SecurityReviewRunInput, 'canon'> {
  /**
   * Where each attempt is persisted, before this function can return or die.
   *
   * SPEC: finding SSA-5. Required rather than optional: a scoped review that cannot record
   * what it found is not a cheaper review, it is an unrecorded one.
   */
  readonly store: Store;
  /** Every source file in the repository, repository-relative POSIX paths. */
  readonly allFiles: readonly string[];
  readonly readFile: (path: string) => string;
  /** Called as each area completes, so a long review reports progress honestly. */
  readonly onArea?: (outcome: AreaReviewOutcome) => void;
}

export interface ScopedReviewOutcome {
  readonly areas: readonly AreaReviewOutcome[];
  readonly review?: SecurityReview;
  readonly refusals: readonly string[];
}

/**
 * Write one attempt down, and never let a write failure lose the review that produced it.
 *
 * SPEC: finding SSA-5. Persistence is best-effort by design: if the store refuses, the caller
 * still gets its in-memory result and the console still shows the findings. Throwing here
 * would turn a storage problem into the exact evidence loss this exists to prevent.
 */
function persist(
  input: ScopedReviewInput,
  area: string,
  fields: Omit<
    ScopeReviewInput,
    'scopeId' | 'scopeName' | 'implementationCommit' | 'treeDigest' | 'reviewedAt'
  >,
): void {
  try {
    recordScopeReview(input.store, {
      ...fields,
      scopeId: scopeIdOf(area),
      scopeName: area,
      implementationCommit: input.repository.commit,
      treeDigest: input.repository.tree,
      reviewedAt: input.reviewedAt,
    });
  } catch {
    /* Recorded nowhere is bad; crashing and recording nowhere is worse. */
  }
}

/**
 * REVIEW EACH AREA ON ITS OWN SOURCE, THEN COMBINE.
 *
 * SPEC: Phase 6 final acceptance sequence §7.
 *
 * One reviewer handed the whole codebase refused it — 2.36MB does not fit an 80K context, the
 * bundle truncated to 40 of 189 files, and the run escalated INSUFFICIENT_CONTEXT rather than
 * certify what it had not seen. That was the correct answer, and the fix is to ask a question
 * that can be answered: seventeen scoped reviews, each on the source its area is about.
 *
 * The combined verdict is the STRICTEST of its parts, never an average. One area finding a
 * CRITICAL is a blocked review however clean the other sixteen are — and an area that could
 * not be reviewed at all makes the whole review NOT_VERIFIED rather than silently sixteen
 * seventeenths of one.
 */
export async function runScopedSecurityReview(
  input: ScopedReviewInput,
): Promise<ScopedReviewOutcome> {
  const agentId = input.agentId ?? DEFAULT_SECURITY_REVIEWER;
  const areas: AreaReviewOutcome[] = [];
  const refusals: string[] = [];
  const findings: SecurityFinding[] = [];
  const covered: string[] = [];

  /*
   * Iterating UNITS rather than areas. Most areas are one unit; an oversized one is split into
   * deterministic sub-scopes that between them cover everything the area maps to. Coverage is
   * still decided against REQUIRED_SCOPE — an area counts only when all of its units do.
   */
  const units = REQUIRED_SCOPE.flatMap((area) => reviewUnitsFor(area));
  const unitsByArea = new Map<string, number>();
  for (const u of units) unitsByArea.set(u.area, (unitsByArea.get(u.area) ?? 0) + 1);
  const completedByArea = new Map<string, number>();

  for (const { area, unit, prefixes, except } of units) {
    const source = reviewAreaFiles(area, input.allFiles, input.readFile, 260_000, prefixes, except);

    if (source.files.length === 0) {
      /* An area with no source is a hole in AREA_SOURCES, not a clean result. */
      const refusal = 'no source is mapped for "' + unit + '", so it was not reviewed';
      refusals.push(refusal);
      persist(input, unit, {
        reviewerRunId: 'NOT-RUN-' + scopeIdOf(unit),
        reviewerAgentId: agentId,
        coverage: ScopeCoverage.NOT_REVIEWED,
        filesReviewed: [],
        filesOmitted: [...source.omitted],
        findings: [],
        verdict: ReviewVerdict.NOT_VERIFIED,
        terminalOutcome: 'NOT_RUN',
        refusal,
      });
      areas.push({
        area: unit,
        runId: '',
        outcome: 'NOT_RUN',
        findings: [],
        verdict: ReviewVerdict.NOT_VERIFIED,
        filesReviewed: [],
        omitted: source.omitted,
        refusal,
      });
      continue;
    }

    const run = await input.runtime.run({
      agentId,
      workItemId: input.workItemId,
      taskDefinition:
        AREA_TASK +
        '\n\nArea under review: ' +
        unit +
        '\nCommit under review: ' +
        input.repository.commit +
        '\nFiles you were given (' +
        String(source.files.length) +
        '): ' +
        source.files.join(', ') +
        (source.omitted.length === 0
          ? ''
          : '\n\nNOT included, and therefore NOT reviewed by you (' +
            String(source.omitted.length) +
            '): ' +
            source.omitted.join(', ') +
            '\nDo not report on these, and do not assume anything about them.'),
      scopeBoundary:
        'Review the area "' +
        unit +
        '" at commit ' +
        input.repository.commit +
        ', using only the source you were given. Read-only: do not write, do not execute, do ' +
        'not reach the network. Do not report findings about other areas.',
      resultSchema: REVIEW_RESULT_SCHEMA,
      resultValidator: ReviewResultSchema,
      capability: {
        policy: readOnlyGrant(),
        cwd: input.storePath,
        basis: 'independent security review of ' + unit + ': read-only judgement',
      },
      canon: [
        {
          source: 'implementation',
          kind: 'SOURCE',
          version: input.repository.tree,
          content: source.content,
          relevance: 1,
        },
      ],
      maxContextChars: 400_000,
      /*
       * Reading 200KB of unfamiliar source and judging it takes longer than the 180s default,
       * and every FAILED area in the first real run was `terminated: TIMEOUT`. A review cut off
       * mid-thought is not a fast review; it is an unreviewed area wearing a run id.
       */
      budget: { maxWallTimeMs: 900_000, maxTurns: 6 },
    });

    const parsed =
      run.outcome === 'COMPLETED' ? ReviewResultSchema.safeParse(run.envelope?.result) : undefined;

    if (parsed?.success !== true) {
      const refusal =
        'the review of "' +
        unit +
        '" ended ' +
        String(run.outcome) +
        ', so that area is unreviewed';
      refusals.push(refusal);
      /*
       * A refused attempt is persisted FIRST, and with everything it had. This is the case the
       * finding was about: the run that produced real findings and then died is exactly the one
       * whose evidence must not evaporate.
       */
      persist(input, unit, {
        reviewerRunId: run.runId,
        reviewerAgentId: agentId,
        coverage: ScopeCoverage.NOT_REVIEWED,
        filesReviewed: [...source.files],
        filesOmitted: [...source.omitted],
        findings: [],
        verdict: ReviewVerdict.NOT_VERIFIED,
        terminalOutcome: String(run.outcome),
        refusal,
      });
      const outcome: AreaReviewOutcome = {
        area: unit,
        runId: run.runId,
        outcome: String(run.outcome),
        findings: [],
        verdict: ReviewVerdict.NOT_VERIFIED,
        filesReviewed: source.files,
        omitted: source.omitted,
        refusal,
      };
      areas.push(outcome);
      input.onArea?.(outcome);
      continue;
    }

    /*
     * Finding ids are namespaced by area. Two reviewers independently numbering their findings
     * F-1 would otherwise collide into one, and a lost finding is worse than a duplicate.
     */
    const areaFindings = parsed.data.findings.map((f) => ({
      ...f,
      id: unit.replace(/[^A-Za-z0-9]+/g, '-').toUpperCase() + '/' + f.id,
      area,
    }));
    findings.push(...areaFindings);

    /* The AREA is covered only once every one of its units has completed. */
    const done = (completedByArea.get(area) ?? 0) + 1;
    completedByArea.set(area, done);
    if (done === unitsByArea.get(area)) covered.push(area);

    persist(input, unit, {
      reviewerRunId: run.runId,
      reviewerAgentId: agentId,
      /* Omitted files mean PARTIAL, whatever verdict the reviewer reached on what it saw. */
      coverage: source.omitted.length === 0 ? ScopeCoverage.COMPLETE : ScopeCoverage.PARTIAL,
      filesReviewed: [...source.files],
      filesOmitted: [...source.omitted],
      findings: areaFindings.map((f) => ({ ...f, resolved: false })),
      verdict: parsed.data.verdict,
      terminalOutcome: String(run.outcome),
    });

    const outcome: AreaReviewOutcome = {
      area: unit,
      runId: run.runId,
      outcome: String(run.outcome),
      findings: areaFindings,
      verdict: parsed.data.verdict,
      filesReviewed: source.files,
      omitted: source.omitted,
    };
    areas.push(outcome);
    input.onArea?.(outcome);
  }

  if (refusals.length > 0) return { areas, refusals };

  /*
   * THE STRICTEST PART DECIDES. A review is not an average of its areas: one CRITICAL is a
   * blocked review however clean the rest are.
   */
  const blocking = findings.filter(
    (f) => f.severity === Severity.CRITICAL || f.severity === Severity.HIGH,
  );
  const verdict = blocking.length > 0 ? ReviewVerdict.BLOCKED : ReviewVerdict.ACCEPTED;

  const review: SecurityReview = {
    implementationCommit: input.repository.commit,
    treeDigest: input.repository.tree,
    /* The last run is the one the proof resolves; every area run is listed in the evidence. */
    reviewerRunId: areas[areas.length - 1]?.runId ?? '',
    reviewerAgentId: agentId,
    reviewerAuthority: 'VERIFY',
    independence: {
      implementationProducers: [...input.implementationProducers],
      statement:
        agentId +
        ' is a VERIFIER whose contract declares write = NONE and network = NONE, dispatched ' +
        'separately from the agents that produced the reviewed work and holding no authority ' +
        'to modify it. Each of the ' +
        String(covered.length) +
        ' scoped areas was reviewed in its own governed run.',
    },
    scope: covered,
    findings,
    verdict,
    reviewedAt: input.reviewedAt,
    storePath: input.storePath,
  };

  return { areas, review, refusals: [] };
}
