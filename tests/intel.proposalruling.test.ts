import { afterEach, describe, expect, it } from 'vitest';
import { ContractRegistry } from '../src/agents/registry.js';
import { AgentRuntime } from '../src/agents/runtime.js';
import { FakeEngineAdapter } from '../src/engine/fake.js';
import { Store } from '../src/store/store.js';
import { FixedClock } from '../src/core/clock.js';
import { SequentialIdSource } from '../src/core/ids.js';
import { ARTIFACT_TYPES, repository } from '../src/intelligence/repository.js';
import { ProductDecisionSchema } from '../src/intelligence/artifacts/product.js';
import {
  OptionDisposition,
  ProposalSchema,
  ProposalState,
} from '../src/intelligence/artifacts/governance.js';
import { accept, assess, propose } from '../src/intelligence/proposals.js';
import { proposalRulingDepartment, ruleOnProposal } from '../src/intelligence/proposalRuling.js';
import { runDepartment } from '../src/intelligence/execution/runner.js';
import { DepartmentOutcome } from '../src/intelligence/execution/types.js';
import { resolveApplicability } from '../src/intelligence/applicability.js';
import { contractOutputTypes } from '../src/intelligence/execution/authority.js';
import { cleanup, tempRoot } from './helpers.js';
import type { DepartmentContext } from '../src/intelligence/execution/types.js';

/**
 * THE AUTHORITY EVENT MUST BE ABLE TO HAPPEN.
 *
 * `acceptanceRefusal` requires a canonical decision carrying a typed disposition on the
 * exact proposal, by an owning authority, in a completed governed run. That was a correct
 * rule about something the company could not do: `ProductDecision` was not in the output
 * authority table, no department declared it, and the only way to produce a ruling was to
 * write one straight into the Store — which is the bypass the ScopedCanonWriter exists to
 * make impossible.
 *
 * These tests run the path. Nothing below writes a decision by hand.
 */

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) cleanup(r);
});

const WORK_ITEM = 'SC-WI-002000';
const PRODUCT_MANAGER = 'SC-AGENT-020';

interface Harness {
  readonly root: string;
  readonly store: Store;
  readonly clock: FixedClock;
  readonly ids: SequentialIdSource;
  readonly engine: FakeEngineAdapter;
  readonly deps: ReturnType<typeof runnerDeps>;
}

function runnerDeps(o: {
  store: Store;
  clock: FixedClock;
  ids: SequentialIdSource;
  engine: FakeEngineAdapter;
  enabled?: readonly string[];
}) {
  const registry = ContractRegistry.shared();
  const enabledAgents = new Set(o.enabled ?? [PRODUCT_MANAGER, 'SC-AGENT-120']);
  return {
    store: o.store,
    clock: o.clock,
    ids: o.ids,
    registry,
    runtime: new AgentRuntime({
      store: o.store,
      ids: o.ids,
      clock: o.clock,
      registry,
      engine: o.engine,
      enabledAgents,
      projectRoot: '/nowhere',
    }),
    projectRoot: '/nowhere',
    enabledAgents,
  };
}

function setup(enabled?: readonly string[]): Harness {
  const root = tempRoot();
  roots.push(root);
  const clock = new FixedClock();
  const ids = new SequentialIdSource();
  const store = Store.initialize(root, { clock, ids, actor: 'RULING_TEST' });
  const engine = new FakeEngineAdapter({ clock });
  return {
    root,
    store,
    clock,
    ids,
    engine,
    deps: runnerDeps({ store, clock, ids, engine, ...(enabled === undefined ? {} : { enabled }) }),
  };
}

const ASSESSMENT = {
  userOrBusinessValue: 'repeat custom from the regulars',
  evidenceBasis: 'the owner says half the orders are the same twenty people',
  implementationComplexity: 'MEDIUM' as const,
  costImpact: 'about a fortnight',
  risk: 'dilutes a first release that has not shipped yet',
  operationalBurden: 'staff have to explain it at the counter',
  scopeEffect: 'adds a feature nobody has asked for',
};

/** A proposal over PRODUCT_SCOPE — canon SC-AGENT-020 owns — raised by somebody else. */
function assessedProposal(h: Harness, origin = 'SC-AGENT-120') {
  const deps = { store: h.store, clock: h.clock, ids: h.ids };
  const p = propose(deps, {
    title: 'Loyalty points',
    origin,
    affectsCanon: ARTIFACT_TYPES.PRODUCT_SCOPE,
    description: 'Reward repeat phone orders with a tenth-order discount',
  });
  assess(deps, { proposalId: p.id, assessment: ASSESSMENT });
  return p;
}

/** A structured ruling, as the Product Manager would return one. */
function rulingEnvelope(disposition: string, over: Record<string, unknown> = {}) {
  return {
    status: 'COMPLETED',
    result: {
      disposition,
      rationale:
        'the first release has not shipped and a loyalty scheme is a second product on top of an unproven one',
      consequenceIfAccepted:
        'the release grows by a fortnight and the counter staff learn a scheme',
      consequenceIfRejected: 'the shop ships what it asked for and can add this later on evidence',
      ...over,
    },
    selfReview: {
      contractConformance: 'ruled on the proposal and nothing else',
      scopeConformance: 'did not revise the product scope',
      knownGaps: [],
      confidence: 'HIGH',
      assumptionsMade: [],
    },
    observations: [],
    escalations: [],
    evidenceClaims: [],
    unresolved: [],
  };
}

describe('1. the authority mapping the ruling depends on', () => {
  it('SC-AGENT-020 is canonically authorised to produce a ProductDecision', () => {
    const contract = ContractRegistry.shared().get(PRODUCT_MANAGER);
    /* The contract has always said so. Until now the table did not resolve the name. */
    expect(contract.outputs).toContain('ProductDecision');
    const permitted = contractOutputTypes(contract);
    expect(permitted.types).toContain(ARTIFACT_TYPES.PRODUCT_DECISION);
    expect(permitted.unresolved).not.toContain('ProductDecision');
  });

  it('the ordinary Product Validation run is NOT widened by it', async () => {
    const { productValidationDepartment } =
      await import('../src/intelligence/departments/product.js');
    /*
     * A ruling is a specific authority action, not a licence for the product-validation
     * stage to start writing decisions as a side effect of scoping a release.
     */
    expect(productValidationDepartment.produces).not.toContain(ARTIFACT_TYPES.PRODUCT_DECISION);
  });
});

describe('2. a governed run produces the ruling', () => {
  it('APPROVE: the authority rules, Serva persists, accept() takes it', async () => {
    const h = setup();
    const p = assessedProposal(h);
    h.engine.script(PRODUCT_MANAGER, {
      structuredOutput: rulingEnvelope(OptionDisposition.APPROVE),
    });

    const ruling = await ruleOnProposal(h.deps, {
      proposalId: p.id,
      workItemId: WORK_ITEM,
    });

    expect(ruling.outcome, ruling.reason ?? '').toBe(DepartmentOutcome.COMPLETED);
    expect(ruling.agentId).toBe(PRODUCT_MANAGER);
    expect(ruling.decisionId).toBeDefined();

    /* The decision is canon, written through the scoped writer by the owning authority. */
    const decision = repository(
      h.store,
      ARTIFACT_TYPES.PRODUCT_DECISION,
      ProductDecisionSchema,
    ).get(ruling.decisionId as string);
    expect(decision?.proposalRef?.id).toBe(p.id);
    expect(decision?.proposalDisposition).toBe(OptionDisposition.APPROVE);
    expect(decision?.meta.attribution.agentId).toBe(PRODUCT_MANAGER);
    expect(decision?.meta.attribution.runId).toBeDefined();

    /* And that is what acceptance reads. Nothing was asserted to it. */
    const accepted = accept(
      { store: h.store, clock: h.clock, ids: h.ids },
      { proposalId: p.id, authorityDecisionId: ruling.decisionId as string },
    );
    expect(accepted.state).toBe(ProposalState.ACCEPTED);
  }, 60_000);

  it('REJECT: the same path refuses acceptance, and the proposal stays ASSESSED', async () => {
    const h = setup();
    const p = assessedProposal(h);
    h.engine.script(PRODUCT_MANAGER, {
      structuredOutput: rulingEnvelope(OptionDisposition.REJECT),
    });

    const ruling = await ruleOnProposal(h.deps, { proposalId: p.id, workItemId: WORK_ITEM });
    expect(ruling.outcome).toBe(DepartmentOutcome.COMPLETED);

    expect(() =>
      accept(
        { store: h.store, clock: h.clock, ids: h.ids },
        { proposalId: p.id, authorityDecisionId: ruling.decisionId as string },
      ),
    ).toThrow(/recorded REJECT/);

    const after = repository(h.store, ARTIFACT_TYPES.PROPOSAL, ProposalSchema).get(p.id);
    expect(after?.state).toBe(ProposalState.ASSESSED);
  }, 60_000);

  it('DEFER: a real answer, and still not an acceptance', async () => {
    const h = setup();
    const p = assessedProposal(h);
    h.engine.script(PRODUCT_MANAGER, {
      structuredOutput: rulingEnvelope(OptionDisposition.DEFER, {
        reevaluationTrigger: 'after the first hundred repeat orders are measured',
      }),
    });

    const ruling = await ruleOnProposal(h.deps, { proposalId: p.id, workItemId: WORK_ITEM });
    const decision = repository(
      h.store,
      ARTIFACT_TYPES.PRODUCT_DECISION,
      ProductDecisionSchema,
    ).get(ruling.decisionId as string);
    expect(decision?.proposalDisposition).toBe(OptionDisposition.DEFER);
    expect(decision?.reevaluationTrigger).toContain('repeat orders');

    expect(() =>
      accept(
        { store: h.store, clock: h.clock, ids: h.ids },
        { proposalId: p.id, authorityDecisionId: ruling.decisionId as string },
      ),
    ).toThrow(/recorded DEFER/);
  }, 60_000);

  it('the caller cannot supply the disposition — there is no parameter to supply it in', async () => {
    const h = setup();
    const p = assessedProposal(h);
    h.engine.script(PRODUCT_MANAGER, {
      structuredOutput: rulingEnvelope(OptionDisposition.REJECT),
    });

    /*
     * The call below asks for an approval as loudly as TypeScript will let it. The agent
     * says REJECT and REJECT is what is recorded: the disposition comes from validated
     * structured output and from nowhere else.
     */
    const ruling = await ruleOnProposal(h.deps, {
      proposalId: p.id,
      workItemId: WORK_ITEM,
      ...({ disposition: OptionDisposition.APPROVE, accept: true } as Record<string, unknown>),
    } as never);
    const decision = repository(
      h.store,
      ARTIFACT_TYPES.PRODUCT_DECISION,
      ProductDecisionSchema,
    ).get(ruling.decisionId as string);
    expect(decision?.proposalDisposition).toBe(OptionDisposition.REJECT);
  }, 60_000);
});

describe('3. the write boundary is what makes the ruling un-forgeable', () => {
  it('a department that does not own the family cannot write the decision', async () => {
    const h = setup([PRODUCT_MANAGER, 'SC-AGENT-120']);
    const p = assessedProposal(h, 'SC-AGENT-050');

    /*
     * The UX Designer is a real, enabled agent with a real contract — and no authority
     * over the product decision family. Running the identical configuration as 120 must
     * be refused, and refused BEFORE anything is staged.
     */
    const misconfigured = {
      ...proposalRulingDepartment(PRODUCT_MANAGER, p),
      id: 'DEPT-PROPOSAL-RULING-MISCONFIGURED',
      agentId: 'SC-AGENT-120',
    };
    h.engine.script('SC-AGENT-120', {
      structuredOutput: rulingEnvelope(OptionDisposition.APPROVE),
    });

    const plan = resolveApplicability('PRF-NEW-PRODUCT');
    const ctx: DepartmentContext = {
      workItemId: WORK_ITEM,
      store: h.store,
      clock: h.clock,
      ids: h.ids,
      plan,
      stage: plan.stages.find((s) => s.stageId === 'SC-STAGE-004') as never,
    };
    const result = await runDepartment(h.deps as never, misconfigured as never, ctx);

    expect(result.outcome).toBe(DepartmentOutcome.FAILED);
    expect(result.reason).toContain('not among its canonical outputs');
    expect(h.store.listCanonIds(ARTIFACT_TYPES.PRODUCT_DECISION)).toHaveLength(0);
  }, 60_000);

  it('the proposer cannot rule on its own proposal', async () => {
    const h = setup();
    /* The Product Manager raises it, and the Product Manager owns the canon. */
    const p = assessedProposal(h, PRODUCT_MANAGER);

    await expect(
      ruleOnProposal(h.deps, { proposalId: p.id, workItemId: WORK_ITEM }),
    ).rejects.toThrow(/No enabled authority can rule/);
    expect(h.store.listCanonIds(ARTIFACT_TYPES.PRODUCT_DECISION)).toHaveLength(0);
  }, 60_000);

  it('an unassessed proposal is refused before anything is spent', async () => {
    const h = setup();
    const p = propose(
      { store: h.store, clock: h.clock, ids: h.ids },
      {
        title: 'Loyalty points',
        origin: 'SC-AGENT-120',
        affectsCanon: ARTIFACT_TYPES.PRODUCT_SCOPE,
        description: 'Reward repeat phone orders',
      },
    );

    await expect(
      ruleOnProposal(h.deps, { proposalId: p.id, workItemId: WORK_ITEM }),
    ).rejects.toThrow(/not ASSESSED/);
    /* Nothing ran: no run record, no decision. */
    expect(h.store.listCanonIds(ARTIFACT_TYPES.PRODUCT_DECISION)).toHaveLength(0);
  }, 60_000);
});

describe('4. the ruling is durable', () => {
  it('survives the process that made it, with no chat history', async () => {
    const h = setup();
    const p = assessedProposal(h);
    h.engine.script(PRODUCT_MANAGER, {
      structuredOutput: rulingEnvelope(OptionDisposition.APPROVE),
    });
    const ruling = await ruleOnProposal(h.deps, { proposalId: p.id, workItemId: WORK_ITEM });

    /*
     * A different Store handle and a different clock; nothing about the decision is
     * carried in memory. The id source is carried because SequentialIdSource restarts at
     * 1 and would collide with the transaction ids already on disk — production uses the
     * monotonic TimeOrderedIdSource, which does not.
     */
    const clock = new FixedClock();
    const ids = h.ids;
    const reopened = Store.open(h.root, { clock, ids, actor: 'RESTART' });
    const accepted = accept(
      { store: reopened, clock, ids },
      { proposalId: p.id, authorityDecisionId: ruling.decisionId as string },
    );
    expect(accepted.state).toBe(ProposalState.ACCEPTED);
  }, 60_000);
});
