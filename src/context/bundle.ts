import { TrustLevel } from '../vocab/index.js';
import { canonicalJson, digestOf } from '../core/hash.js';
import { computeBundleDigest } from './store.js';
import { fail } from '../core/errors.js';
import type { ContextBundle, ContextElement, ContextExclusion } from '../engine/types.js';
import type { AgentContract } from '../agents/schema.js';
import type { Clock } from '../core/clock.js';
import type { IdSource } from '../core/ids.js';
import type { Store } from '../store/store.js';

/**
 * ContextBundle construction. SPEC: 19 §4, 05 §5, SC-POL-027.
 *
 * The governing sentence is 19 §4: **context is built, never inherited.** Every
 * element enters this bundle because something put it there deliberately, carrying
 * where it came from, whether it may be believed, and why it was included. Nothing
 * arrives because it happened to be in the working directory or in a previous
 * conversation.
 *
 * Three rules are enforced structurally rather than by convention:
 *
 *   CX-1/CX-2  No conversation history and no other agent's reasoning. There is no
 *              API here that could add one: `addTyped` takes a stored artifact and
 *              `addUntrusted` takes verbatim text, and neither can name a run.
 *   CX-4/CX-7  Anything dropped is recorded in `exclusions`. Dropping is by whole
 *              element, never mid-artifact.
 *   CX-8       If a REQUIRED element does not fit, `build()` refuses. Dispatching a
 *              run with known-insufficient context is a design error, not a degraded
 *              mode, so the builder has no way to express it.
 */

export interface BundleBuilderDeps {
  readonly ids: IdSource;
  readonly clock: Clock;
  readonly store: Store;
}

interface Candidate {
  readonly element: Omit<ContextElement, 'id' | 'digest'>;
  readonly required: boolean;
}

/** Rough character budget per profile (32 §1.2). Shape, not a token count. */
export const CONTEXT_BUDGET_CHARS: Readonly<Record<string, number>> = Object.freeze({
  'B-SMALL': 24_000,
  'B-STANDARD': 80_000,
  'B-LARGE': 200_000,
  'B-RESEARCH': 120_000,
});

export class ContextBundleBuilder {
  private readonly candidates: Candidate[] = [];
  private readonly exclusions: ContextExclusion[] = [];

  constructor(
    private readonly deps: BundleBuilderDeps,
    private readonly opts: {
      readonly contract: AgentContract;
      readonly taskId: string;
      readonly workItemId: string;
      readonly maxChars: number;
    },
  ) {}

  /**
   * Serva-governed truth: the contract, the task, canon extracts. TRUSTED, because
   * Serva wrote it and Serva can prove where it came from (19 §4.2).
   */
  addTrusted(o: {
    source: string;
    kind: string;
    version: string;
    content: string;
    reasonIncluded: string;
    relevance: number;
    required?: boolean;
  }): this {
    this.candidates.push({
      required: o.required ?? false,
      element: {
        source: o.source,
        kind: o.kind,
        trust: TrustLevel.TRUSTED,
        version: o.version,
        content: o.content,
        reasonIncluded: o.reasonIncluded,
        relevance: o.relevance,
      },
    });
    return this;
  }

  /**
   * Anything whose text was authored outside Serva's governance: repository files,
   * the owner's own request, issue text, dependency docs, tool output from elsewhere.
   *
   * The owner's request is UNTRUSTED and that is deliberate, not an insult. The owner
   * is trusted as an authority; the *text* is untrusted as an instruction channel,
   * because it may quote, paste or forward content from somewhere else (19 §4.2).
   */
  addUntrusted(o: {
    source: string;
    kind: string;
    version: string;
    content: string;
    reasonIncluded: string;
    relevance: number;
    required?: boolean;
  }): this {
    this.candidates.push({
      required: o.required ?? false,
      element: {
        source: o.source,
        kind: o.kind,
        trust: TrustLevel.UNTRUSTED,
        version: o.version,
        content: o.content,
        reasonIncluded: o.reasonIncluded,
        relevance: o.relevance,
      },
    });
    return this;
  }

  /** Record something deliberately withheld for a reason other than budget (CX-4). */
  exclude(e: ContextExclusion): this {
    this.exclusions.push(e);
    return this;
  }

  /**
   * Assemble the bundle.
   *
   * Selection is deterministic: descending relevance, then source, so the same inputs
   * always produce the same bundle and the same digest. Under budget pressure the
   * lowest-relevance optional element is dropped whole and recorded (CX-7).
   */
  build(): ContextBundle {
    const ordered = [...this.candidates].sort(
      (a, b) =>
        b.element.relevance - a.element.relevance ||
        a.element.source.localeCompare(b.element.source),
    );

    const requiredChars = ordered
      .filter((c) => c.required)
      .reduce((n, c) => n + c.element.content.length, 0);

    if (requiredChars > this.opts.maxChars) {
      // CX-8. There is deliberately no "truncate and proceed" branch here.
      return fail({
        code: 'E_CONTEXT_INSUFFICIENT',
        message:
          'Required context for ' +
          this.opts.contract.id +
          ' is ' +
          String(requiredChars) +
          ' characters against a budget of ' +
          String(this.opts.maxChars),
        remedy:
          'Split the task or raise the budget profile. Dispatching with known-insufficient context is a design error, not a degraded mode (19 CX-8).',
        details: {
          agentId: this.opts.contract.id,
          taskId: this.opts.taskId,
          requiredChars,
          maxChars: this.opts.maxChars,
          budgetProfile: this.opts.contract.contextBudget,
        },
        specRef: '19 CX-8',
      });
    }

    const kept: ContextElement[] = [];
    const exclusions = [...this.exclusions];
    let used = 0;

    for (const c of ordered) {
      const size = c.element.content.length;
      if (!c.required && used + size > this.opts.maxChars) {
        exclusions.push({
          subject: c.element.source,
          kind: 'BUDGET',
          reason:
            'dropped whole at relevance ' +
            String(c.element.relevance) +
            '; ' +
            String(size) +
            ' characters would exceed the remaining budget of ' +
            String(this.opts.maxChars - used),
        });
        continue;
      }
      used += size;
      const digest = digestOf(canonicalJson(c.element));
      kept.push({ ...c.element, id: this.deps.ids.next('SC-CTXE'), digest });
    }

    const id = this.deps.ids.next('SC-CTX');

    return {
      id,
      agentId: this.opts.contract.id,
      taskId: this.opts.taskId,
      workItemId: this.opts.workItemId,
      elements: kept,
      exclusions,
      storeVersion: this.deps.store.storeVersion(),
      budget: { maxChars: this.opts.maxChars, usedChars: used },
      builtAt: this.deps.clock.now(),
      // Computed by the SAME function that verifies it on read. Two copies of this
      // formula would drift, and every reconstruction would then report tampering.
      digest: computeBundleDigest({
        agentId: this.opts.contract.id,
        taskId: this.opts.taskId,
        workItemId: this.opts.workItemId,
        elements: kept,
        exclusions,
      }),
    };
  }
}

/**
 * Build the standard bundle for one agent run.
 *
 * `19` §4 step 1 is the contract, step 2 the task; both are REQUIRED, because an
 * agent without its own role or its own task cannot do anything correct. Canon and
 * workspace excerpts are optional and compete for what is left.
 */
export function buildStandardBundle(
  deps: BundleBuilderDeps,
  o: {
    readonly contract: AgentContract;
    readonly taskId: string;
    readonly workItemId: string;
    readonly taskDefinition: string;
    readonly scopeBoundary: string;
    readonly ownerRequest?: string;
    readonly canon?: readonly {
      source: string;
      kind: string;
      version: string;
      content: string;
      relevance: number;
    }[];
    readonly workspace?: readonly {
      source: string;
      version: string;
      content: string;
      relevance: number;
    }[];
    readonly maxChars?: number;
  },
): ContextBundle {
  const maxChars =
    o.maxChars ??
    CONTEXT_BUDGET_CHARS[o.contract.contextBudget] ??
    CONTEXT_BUDGET_CHARS['B-STANDARD']!;

  const b = new ContextBundleBuilder(deps, {
    contract: o.contract,
    taskId: o.taskId,
    workItemId: o.workItemId,
    maxChars,
  });

  // 1 — role, from the contract rather than from free text (19 §4 step 1).
  b.addTrusted({
    source: 'contract:' + o.contract.id,
    kind: 'AGENT_ROLE',
    version: o.contract.version,
    relevance: 100,
    required: true,
    reasonIncluded: 'the agent must know its own mission, limits and refusal surface',
    content: renderRole(o.contract),
  });

  // 2 — task (19 §4 step 2).
  b.addTrusted({
    source: 'task:' + o.taskId,
    kind: 'TASK',
    version: '1',
    relevance: 99,
    required: true,
    reasonIncluded: 'the work to be done and the boundary it may not cross',
    content:
      'Task: ' +
      o.taskDefinition +
      '\nScope boundary: ' +
      o.scopeBoundary +
      '\nWork item: ' +
      o.workItemId,
  });

  // The owner's own words, carried verbatim and marked as data (19 §4.2).
  if (o.ownerRequest !== undefined) {
    b.addUntrusted({
      source: 'owner-request',
      kind: 'REQUEST_TEXT',
      version: '1',
      relevance: 98,
      required: true,
      reasonIncluded: 'the request being classified or acted on, as written',
      content: o.ownerRequest,
    });
  }

  for (const c of o.canon ?? []) {
    b.addTrusted({
      source: c.source,
      kind: c.kind,
      version: c.version,
      content: c.content,
      relevance: c.relevance,
      reasonIncluded: 'governed project truth relevant to this task',
    });
  }

  for (const w of o.workspace ?? []) {
    b.addUntrusted({
      source: w.source,
      kind: 'WORKSPACE_EXCERPT',
      version: w.version,
      content: w.content,
      relevance: w.relevance,
      reasonIncluded: 'repository content within the read scope of this task',
    });
  }

  // CX-1/CX-2 stated in the bundle itself, so the agent knows what it is NOT seeing.
  b.exclude({
    subject: 'prior conversation history',
    kind: 'POLICY',
    reason:
      'No previous session, message history or other agent reasoning is ever included (19 CX-1, CX-2). Only persisted typed outputs cross between agents.',
  });

  return b.build();
}

function renderRole(c: AgentContract): string {
  const lines = [
    'Agent: ' + c.id + ' - ' + c.name + ' (v' + c.version + ')',
    'Department: ' + c.department + ' (tier ' + String(c.tier) + ')',
    'Archetype: ' + c.archetype + '   Authority: ' + c.authorityLevel,
    'Magnitude ceiling: ' + c.magnitudeCeiling,
    '',
    'Mission: ' + c.mission,
    '',
    'Responsibilities:',
    ...c.responsibilities.map((r) => '  - ' + r),
    '',
    'Not your responsibility:',
    ...c.nonResponsibilities.map((r) => '  - ' + r),
    '',
    'Forbidden:',
    ...c.forbiddenActions.map((r) => '  - ' + r),
    '',
    'You must refuse when:',
    ...c.refusalSurface.map((r) => '  - ' + r),
    '',
    'Escalate when:',
    ...c.escalationConditions.map((r) => '  - ' + r),
    '',
    'Quality criteria your output is judged against:',
    ...c.qualityCriteria.map((r) => '  - ' + r),
  ];
  return lines.join('\n');
}
