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
  findingIdPrefix,
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
  'Core Store/integrity': [
    'src/store/',
    'src/events/',
    'src/core/',
    /* The parse boundary: what a record is allowed to be before it is trusted. */
    'src/domain/schemas.ts',
    /* Validity is derived, never stored — and acceptance reads it. */
    'src/validity/derive.ts',
    /* Loads the generated catalogues off disk at startup. */
    'src/catalogue/index.ts',
  ],
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
  /*
   * `src/cli/main.ts` is here because the entry point now DECIDES WHICH BUILD RUNS.
   *
   * SPEC: the 1.0.1 packaging audit, §17.2.
   *
   * It reads `~/.serva-code/current` and `spawnSync`s the entry point of whatever that names.
   * That is the most security-relevant line in the CLI — a path taken from a file on disk and
   * handed to a process launcher — and the area's prefixes were `src/portability/` and
   * `src/cli/commands/`, neither of which matches `src/cli/main.ts`. The review would have
   * covered the installer that WRITES the pointer while never reading the code that OBEYS it.
   */
  'install/update/rollback': ['src/portability/', 'src/cli/commands/', 'src/cli/main.ts'],
  'organizational learning': ['src/learning/', 'src/intelligence/'],
  'release/handover': ['src/portability/', 'src/lifecycle/'],
  'Serva self-acceptance authority': ['src/acceptance/'],

  /*
   * THE ENGINEERING MODULES THE 'HARD boundary' AREA NEVER NAMED.
   *
   * SPEC: the 1.0.1 security scope triage.
   *
   * 'Engineering HARD boundary' lists five files by name, which was right for what it meant
   * — the sandbox decision — and left the rest of `src/engineering/` uncovered. That rest
   * includes the module that spawns Git, the one that scans for committed credentials, and
   * the one that decides a change may be accepted.
   */
  'engineering Git and commit integrity': [
    'src/engineering/git.ts',
    'src/engineering/integration.ts',
    'src/engineering/changeset.ts',
  ],
  'engineering secrets and execution evidence': [
    'src/engineering/secrets.ts',
    'src/engineering/execution.ts',
  ],
  'engineering acceptance authority': [
    'src/engineering/gate.ts',
    'src/engineering/review.ts',
    'src/engineering/factory.ts',
    'src/engineering/executors.ts',
    'src/engineering/recipe.ts',
  ],

  /*
   * The application layer the extension actually calls. `actions.ts` states the invariant
   * itself — "EVERY CONSEQUENTIAL ACTION IS A VALIDATED COMMAND. UI STATE IS NEVER AUTHORITY"
   * — and no review area contained it.
   */
  'application action authority': [
    'src/app/actions.ts',
    'src/app/services.ts',
    'src/app/ai.ts',
    'src/app/doctor.ts',
    'src/app/engineering.ts',
    'src/app/reconciliation.ts',
  ],
});

/**
 * WHAT WAS LOOKED AT AND DELIBERATELY NOT REVIEWED, WITH THE REASON.
 *
 * SPEC: the 1.0.1 security scope triage.
 *
 * The scope map going stale was not caught by anything, because "not in any area" and
 * "reviewed and found irrelevant" were indistinguishable — both were simply absence.
 *
 * So absence is no longer allowed to mean anything. Every source module is either inside a
 * review area or named here with why it is not, and a structural test asserts the two sets
 * cover the tree exactly. A module added later is in neither, and fails — which is the point:
 * somebody has to decide, once, in the open.
 *
 * These three were classified by reading them, not by their names.
 */
export const NON_SECURITY_SOURCES: Readonly<Record<string, string>> = Object.freeze({
  'src/index.ts':
    're-exports only. No statements, no I/O, no authority — the symbols it publishes are ' +
    'reviewed where they are implemented.',
  'src/vocab/index.ts':
    'canonical value sets fixed by 31_RESULT_AND_VERDICT_TAXONOMY. Constants and one total ' +
    'helper over them; no I/O and no decision that could be influenced by input.',
  'src/coverage/index.ts':
    'derives lifecycle and gate coverage from the generated catalogues. Pure computation, no ' +
    'I/O, and it reports rather than authorises — nothing downstream is gated on it.',
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
  /**
   * Files another unit OWNS that this one must read to judge its own.
   *
   * SPEC: Phase 6 scoped review contract.
   *
   * `organizational learning — core` was asked whether client data can cross between
   * projects, and the wall that decides it — `leakageRefusal` — lives in the artifacts
   * sub-scope. The reviewer refused to certify a boundary it had not been shown, which is
   * exactly right, and the partition was what made that happen.
   *
   * Context, not ownership: these files are still reviewed by the unit that owns them, and
   * `partitionGap` still proves every file has an owner. A boundary that spans two files
   * cannot be judged from one of them.
   */
  readonly context?: readonly string[];
}

export const AREA_SUBSCOPES: Readonly<Record<string, Readonly<Record<string, SubScope>>>> =
  Object.freeze({
    /*
     * TWENTY-THREE FILES IN ONE SITTING, AND THE REVIEWER READ TWENTY-TWO.
     *
     * SPEC: the 1.0.1 security scope triage.
     *
     * `bootstrap` maps to two unrelated trees — the CLI command surface and the execution
     * substrate — and at 23 files it was the largest unpartitioned unit in the run. The
     * reviewer returned ACCEPTED having silently not read `src/substrate/types.ts`, and the
     * aggregate correctly refused to mint a proof: a partial view of an area is not coverage
     * of it, whatever verdict the part that was read earned.
     *
     * Splitting is the mechanism this file already documents for exactly this. Nothing leaves
     * the review — between them these two cover every path the area maps to — and each
     * reviewer now gets one coherent subject small enough to actually read.
     *
     * Note what is NOT done here: `src/substrate/` is not dropped from `bootstrap` on the
     * grounds that `qualification transport semantics` reviews it COMPLETE. It does, and
     * `types.ts` was in fact read there at this same commit — but narrowing an area because
     * another area happens to overlap it is how scope quietly shrinks. The two areas ask
     * different questions of the same files, and both are supposed to.
     */
    bootstrap: Object.freeze({
      'bootstrap — the command surface': { prefixes: ['src/cli/commands/'] },
      'bootstrap — substrate prerequisites': { prefixes: ['src/substrate/'] },
    }),

    /*
     * Split for the same reason, before it fails rather than after.
     *
     * With `bootstrap` partitioned this became the largest unit in the run at 25 files —
     * MORE than the 23 that was just silently truncated. It happened to come back COMPLETE
     * this time, and treating that as evidence it will next time is exactly the reasoning
     * this whole audit exists to distrust. A full review is forty-five minutes; the cost of
     * being wrong is paying that again.
     *
     * The seam is the real one: how a version is installed and which one runs, versus the
     * commands an owner types. Both halves keep asking the installation question.
     */
    'install/update/rollback': Object.freeze({
      'install/update/rollback — the installation model': {
        prefixes: ['src/portability/', 'src/cli/main.ts'],
      },
      'install/update/rollback — the command surface': {
        prefixes: ['src/cli/commands/'],
        /*
         * A CALL SITE WITHOUT ITS GUARD IS NOT REVIEWABLE.
         *
         * SPEC: the 1.0.1 security scope triage, second pass.
         *
         * This carried `main.ts` alone as context, so the reviewer saw
         * `spawnSync(process.execPath, [decision.handOffTo, …])` and could not see
         * `resolveActive`, which is what validates the pointer before that path exists. It
         * returned NOT_VERIFIED and said why: "whether it can resolve to attacker-influenced
         * code depends on resolveActive/defaultInstallRoot, which are not in the supplied
         * files. Cannot be confirmed or refuted from this source."
         *
         * It was right to refuse. Splitting the area put the delegation's call site in one
         * unit and its validation in the sibling, and a reviewer shown a process launcher and
         * denied the guard that constrains it cannot honestly certify either way. That is the
         * `bootstrap` omission wearing different clothes: a partition that leaves a unit
         * unable to answer its own question.
         *
         * `activeVersion.ts` decides WHETHER to hand off and to what; `install.ts` owns the
         * layout the pointer names. Both are read by the sibling unit as its subject — here
         * they are context, so nothing is reviewed twice as though it were two findings.
         */
        context: [
          'src/cli/main.ts',
          'src/portability/activeVersion.ts',
          'src/portability/install.ts',
        ],
      },
    }),

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
        /* The wall this area's whole question turns on. Owned by the artifacts unit. */
        context: ['src/intelligence/artifacts/learning.ts'],
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
  /** Files owned elsewhere that this unit must read to judge its own. */
  readonly context: readonly string[];
}

/**
 * FILES AN AREA MUST READ TO JUDGE ITS OWN, WHETHER OR NOT IT IS PARTITIONED.
 *
 * SPEC: finding APPLICATION-ACTION-AUTHORITY/AAA-1 (MEDIUM), 1.0.1 security review.
 *
 * A unit shown a CALL SITE must also be shown the GUARD on it, or it can only report that the
 * defence is unverifiable — and an unverifiable defence reads exactly like a missing one. That
 * rule already existed for sub-scopes, which could declare `context`; an unpartitioned area had
 * no way to declare any, so the same reviewer question came back as a finding rather than an
 * answer. Declaring it per AREA covers both shapes.
 *
 * Context is READ, never OWNED: it is excluded from the partition, so nothing here can make a
 * file count as covered. The only thing it changes is what the reviewer is allowed to look at.
 */
export const AREA_CONTEXT: Record<string, readonly string[]> = Object.freeze({
  /*
   * `owner.answer` hands `answeredBy` to `answerOwnerDecision`, and the impersonation rule —
   * an agent id may never answer an owner decision — is enforced there, one module away.
   */
  'application action authority': ['src/intelligence/app.ts'],
  /*
   * This unit judges whether a persisted scope-review record can be trusted as evidence, and
   * the answer turns on a property of the STORE: canon versions are immutable, every record
   * carries a digest, and a body edited out of band is detected. Without that module the unit
   * can only say the mitigation 'is not visible in these files' — and abstain, which is what
   * it did at b4cf7392.
   */
  'Serva self-acceptance authority': ['src/store/store.ts'],
});

export function reviewUnitsFor(area: string): readonly ReviewUnit[] {
  const declared = AREA_CONTEXT[area] ?? [];
  const split = AREA_SUBSCOPES[area];
  if (split === undefined) {
    return [
      { area, unit: area, prefixes: AREA_SOURCES[area] ?? [], except: [], context: declared },
    ];
  }
  return Object.entries(split).map(([unit, sub]) => ({
    area,
    unit,
    prefixes: sub.prefixes,
    except: sub.except ?? [],
    context: [...declared, ...(sub.context ?? [])],
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
  /** The files this unit OWNS and was given. Coverage is decided against these. */
  readonly files: readonly string[];
  /** Owned files that did not fit the budget. Never silently dropped. */
  readonly omitted: readonly string[];
  /** Context the unit was given: read to judge its own files, never judged itself. */
  readonly context: readonly string[];
  /** Context that did not fit. Reported, because a guard nobody saw is a guard nobody saw. */
  readonly contextOmitted: readonly string[];
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
  /** Files owned elsewhere that this unit must read anyway. Bypasses `except`. */
  context: readonly string[] = [],
  /** Context has its OWN budget: reading more must never cost a unit its coverage. */
  contextBudgetChars = 60_000,
): AreaSource {
  const prefixes = prefixOverride ?? AREA_SOURCES[area] ?? [];
  const owns = (f: string): boolean =>
    prefixes.some((prefix) => f.startsWith(prefix)) &&
    !except.some((prefix) => f.startsWith(prefix));

  const ownedFiles = allFiles.filter(owns);
  const contextFiles = allFiles.filter(
    (f) => !owns(f) && context.some((prefix) => f.startsWith(prefix)),
  );

  const parts: string[] = [];

  /*
   * TWO BUDGETS, BECAUSE THEY ANSWER DIFFERENT QUESTIONS.
   *
   * The owned budget answers "could this unit read its SUBJECTS?" — which is what coverage
   * means and what a PARTIAL is about. Context is read so the unit can judge those subjects;
   * it is nobody's coverage.
   *
   * One shared budget made them compete, in both directions and both wrong. A large subject
   * could push out the guard a unit needed to judge it, and — as happened the moment
   * `src/store/store.ts` was declared context here — adding a file to READ turned a COMPLETE
   * unit PARTIAL, which asserts the unit failed to review something it does not own.
   *
   * Owned files are gathered first regardless, so context can never cost coverage.
   */
  const take = (files: readonly string[], budget: number) => {
    const included: string[] = [];
    const dropped: string[] = [];
    let left = budget;
    for (const f of files) {
      let text: string;
      try {
        text = readFile(f);
      } catch {
        dropped.push(f);
        continue;
      }
      if (text.length > left) {
        dropped.push(f);
        continue;
      }
      left -= text.length;
      included.push(f);
      parts.push('=== ' + f + ' ===\n' + text);
    }
    return { included, dropped };
  };

  const subjects = take(ownedFiles, budgetChars);
  const read = take(contextFiles, contextBudgetChars);

  return {
    area,
    content: parts.join('\n\n'),
    files: subjects.included,
    omitted: subjects.dropped,
    context: read.included,
    contextOmitted: read.dropped,
  };
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
  'An unsupported finding wastes the same attention a real one needs. ' +
  'Report AT MOST 8 findings, the most serious first, and keep each statement under 200 words. ' +
  'A review that reports everything reports nothing, and an answer too large to return is a ' +
  'review nobody receives.';

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
  /** Read to judge the above, and reported apart from it: context is nobody's coverage. */
  readonly context: readonly string[];
  readonly contextOmitted: readonly string[];
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
  /**
   * Review only these units, for a targeted re-check of a scope that blocked.
   *
   * A PRE-CHECK affordance, never an acceptance one: `aggregateSecurityReview` still demands
   * every required area, so a partial run can inform a decision and can never satisfy
   * SECURITY-INDEPENDENT. It exists so a defect that survived a fix costs one model call to
   * find rather than twenty-two.
   */
  readonly onlyUnits?: readonly string[];
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
 * Does this diagnostic describe the provider failing, rather than the code being judged?
 *
 * Deliberately narrow. Anything not recognised here is treated as an answer and not retried,
 * because the expensive mistake is asking a reviewer again until it stops objecting.
 */
function isTransient(diagnostics: readonly string[]): boolean {
  return diagnostics.some((d) => /ENGINE_ERROR|TIMEOUT|retry|rate.?limit|overload/i.test(d));
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
  const allUnits = REQUIRED_SCOPE.flatMap((area) => reviewUnitsFor(area));
  const units =
    input.onlyUnits === undefined
      ? allUnits
      : allUnits.filter((u) => input.onlyUnits?.includes(u.unit));
  const unitsByArea = new Map<string, number>();
  for (const u of units) unitsByArea.set(u.area, (unitsByArea.get(u.area) ?? 0) + 1);
  const completedByArea = new Map<string, number>();

  for (const { area, unit, prefixes, except, context } of units) {
    const source = reviewAreaFiles(
      area,
      input.allFiles,
      input.readFile,
      260_000,
      prefixes,
      except,
      context,
    );

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
        contextRead: [...source.context],
        contextOmitted: [...source.contextOmitted],
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
        context: source.context,
        contextOmitted: source.contextOmitted,
        refusal,
      });
      continue;
    }

    /*
     * ONE RETRY FOR A TRANSIENT FAILURE, AND NONE FOR AN ANSWER.
     *
     * SPEC: Phase 6 final acceptance sequence §7.
     *
     * Five of twenty-two areas were lost in the first full run: one wall-clock timeout, two
     * ENGINE_ERRORs six seconds apart (the provider reporting "success" alongside exit code 1),
     * and one answer too large for the structured schema. None was a product defect and every
     * one cost an entire scoped review — a review whose coverage depended on the provider's
     * mood that minute.
     *
     * A retry is offered ONLY for a failure that says nothing about the code: FAILED with an
     * engine or timeout diagnostic. An EVIDENCE_VIOLATION or a refusal is an ANSWER, and
     * asking the same reviewer again until it says something else is not verification.
     */
    const dispatch = (): Promise<AgentRunResult> =>
      input.runtime.run({
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
          /*
           * Context is named APART from the subject, and says what it is for. Merged into one
           * list it reads as more area to judge, and a reviewer raising a finding against a
           * file another unit owns files it where nobody will act on it.
           */
          (source.context.length === 0
            ? ''
            : '\n\nGiven to you to READ, so you can judge the files above. They belong to' +
              ' another area and are not yours to judge (' +
              String(source.context.length) +
              '): ' +
              source.context.join(', ')) +
          (source.contextOmitted.length === 0
            ? ''
            : '\n\nContext that did NOT fit, and you have not seen (' +
              String(source.contextOmitted.length) +
              '): ' +
              source.contextOmitted.join(', ') +
              '\nSay so if a judgement depends on one of these.') +
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
         * and the first real run lost areas to `terminated: TIMEOUT` at 900s. A review cut off
         * mid-thought is not a fast review; it is an unreviewed area wearing a run id.
         */
        budget: { maxWallTimeMs: 1_500_000, maxTurns: 6 },
      });

    let run = await dispatch();
    if (run.outcome === 'FAILED' && isTransient(run.diagnostics)) {
      run = await dispatch();
    }

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
        contextRead: [...source.context],
        contextOmitted: [...source.contextOmitted],
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
        context: source.context,
        contextOmitted: source.contextOmitted,
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
      id: findingIdPrefix(unit) + '/' + f.id,
      area,
    }));
    findings.push(...areaFindings);

    /* The AREA is covered only once every one of its units has completed. */
    const done = (completedByArea.get(area) ?? 0) + 1;
    completedByArea.set(area, done);
    if (done === unitsByArea.get(area)) covered.push(area);

    /*
     * REQUIRED CONTEXT THAT DID NOT ARRIVE MAKES THE JUDGEMENT UNUSABLE, NOT MERELY NOTED.
     *
     * SPEC: the omission at 7595c20a, and the acceptance bar set after it.
     *
     * Context is declared because the unit CANNOT decide its own files without it — that is
     * the only reason a file is ever declared. A reviewer that never received it judged a
     * question it was not equipped to answer, and its ACCEPTED means it did not notice the
     * absence rather than that nothing was wrong. Exactly what happened here: the store's
     * tamper-evidence guarantee did not fit, and the unit accepted without it.
     *
     * Recorded as NOT_VERIFIED with a refusal, and NOT as PARTIAL coverage. The two say
     * different things and must never be folded together: PARTIAL means a SUBJECT went
     * unreviewed; this means every subject was reviewed without a guard the unit was promised.
     */
    const contextRefusal =
      source.contextOmitted.length === 0
        ? undefined
        : 'declared context did not reach the reviewer (' +
          source.contextOmitted.join(', ') +
          '), so this judgement was made without it';

    const verdict = contextRefusal === undefined ? parsed.data.verdict : ReviewVerdict.NOT_VERIFIED;

    persist(input, unit, {
      reviewerRunId: run.runId,
      reviewerAgentId: agentId,
      /*
       * SUBJECT omissions decide coverage, and only they. Coverage answers "did this unit
       * review the files it owns?", which a context file was never part of.
       */
      coverage: source.omitted.length === 0 ? ScopeCoverage.COMPLETE : ScopeCoverage.PARTIAL,
      filesReviewed: [...source.files],
      filesOmitted: [...source.omitted],
      contextRead: [...source.context],
      contextOmitted: [...source.contextOmitted],
      findings: areaFindings.map((f) => ({ ...f, resolved: false })),
      verdict,
      terminalOutcome: String(run.outcome),
      ...(contextRefusal === undefined ? {} : { refusal: contextRefusal }),
    });

    if (contextRefusal !== undefined) refusals.push(unit + ': ' + contextRefusal);

    const outcome: AreaReviewOutcome = {
      area: unit,
      runId: run.runId,
      outcome: String(run.outcome),
      findings: areaFindings,
      verdict,
      filesReviewed: source.files,
      omitted: source.omitted,
      context: source.context,
      contextOmitted: source.contextOmitted,
      ...(contextRefusal === undefined ? {} : { refusal: contextRefusal }),
    };
    areas.push(outcome);
    input.onArea?.(outcome);
  }

  /*
   * A PARTIAL RUN INFORMS; IT NEVER CONCLUDES.
   *
   * `aggregateSecurityReview` would refuse a partial review anyway — a missing area is a
   * missing area — but a `review` object coming back from a run that examined one unit is
   * misleading on its face, and misleading shapes are how the wrong thing eventually gets
   * used. A targeted re-check returns its findings and no verdict.
   */
  if (input.onlyUnits !== undefined) {
    return {
      areas,
      refusals: [
        ...refusals,
        'this was a targeted re-check of ' +
          String(input.onlyUnits.length) +
          ' unit(s), not a review of all ' +
          String(REQUIRED_SCOPE.length) +
          ' required areas',
      ],
    };
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
