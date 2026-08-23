import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ContractRegistry } from '../src/agents/registry.js';
import { AgentRuntime } from '../src/agents/runtime.js';
import { FakeEngineAdapter } from '../src/engine/fake.js';
import { Store } from '../src/store/store.js';
import { runDepartment } from '../src/intelligence/execution/runner.js';
import { DepartmentOutcome } from '../src/intelligence/execution/types.js';
import {
  authorityRefusal,
  contractOutputTypes,
  validateDepartmentAuthority,
} from '../src/intelligence/execution/authority.js';
import { resolveApplicability } from '../src/intelligence/applicability.js';
import { jsonSchemaFor } from '../src/intelligence/execution/jsonSchema.js';
import { ARTIFACT_TYPES, repository } from '../src/intelligence/repository.js';
import { UPSTREAM_DEPARTMENTS } from '../src/intelligence/app.js';
import { ProjectGoalSchema } from '../src/intelligence/artifacts/framing.js';
import { AdrSchema } from '../src/intelligence/artifacts/architecture.js';
import { TestCaseSchema } from '../src/intelligence/artifacts/testing.js';
import { cleanup, freshStore, tempRoot } from './helpers.js';
import { FixedClock } from '../src/core/clock.js';
import { SequentialIdSource } from '../src/core/ids.js';
import type { DepartmentConfig, DepartmentContext } from '../src/intelligence/execution/types.js';

/**
 * CANONICAL OUTPUT AUTHORITY.
 *
 * SPEC: 06, 32 §9. The invariant is a chain:
 *
 *   committed artifact types  ⊆  DepartmentConfig.produces  ⊆  AgentContract outputs
 *
 * and the point of these tests is that the last link is enforced BEFORE the mutation. A
 * check that runs after the write has already let the write happen; all it can do then is
 * try to undo it, which is a different and weaker promise.
 */

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) cleanup(r);
});

const registry = ContractRegistry.shared();

const OutputSchema = z.object({ note: z.string().min(1) }).strict();

function envelope(result: unknown): Record<string, unknown> {
  return {
    status: 'COMPLETED',
    result,
    selfReview: {
      contractConformance: 'stayed within the contract',
      scopeConformance: 'within the declared scope',
      knownGaps: [],
      confidence: 'MEDIUM',
      assumptionsMade: [],
    },
    observations: [],
    escalations: [],
    evidenceClaims: [],
    unresolved: [],
  };
}

function setup() {
  const { store, root, deps } = freshStore();
  roots.push(root);
  return { store, deps, engine: new FakeEngineAdapter({ clock: deps.clock }) };
}

function runnerDeps(f: ReturnType<typeof setup>, enabled: readonly string[]) {
  return {
    store: f.store,
    clock: f.deps.clock,
    ids: f.deps.ids,
    registry,
    runtime: new AgentRuntime({
      store: f.store,
      ids: f.deps.ids,
      clock: f.deps.clock,
      registry,
      engine: f.engine,
      enabledAgents: new Set(enabled),
      projectRoot: '/nowhere',
    }),
    projectRoot: '/nowhere',
    enabledAgents: new Set(enabled),
  };
}

function context(f: ReturnType<typeof setup>): DepartmentContext {
  const plan = resolveApplicability('PRF-NEW-PRODUCT');
  return {
    workItemId: 'SC-WI-000970',
    store: f.store,
    clock: f.deps.clock,
    ids: f.deps.ids,
    plan,
    stage: plan.stages[0] as never,
  };
}

describe('every registered department is inside its canonical contract', () => {
  it('the whole catalogue validates', () => {
    expect(() => validateDepartmentAuthority(UPSTREAM_DEPARTMENTS, registry)).not.toThrow();
  });

  it('every department declares what it produces', () => {
    for (const d of UPSTREAM_DEPARTMENTS) {
      expect(d.produces, d.id + ' declares no outputs').toBeDefined();
    }
  });

  it('each declared type is authorised by the agent that will run', () => {
    for (const d of UPSTREAM_DEPARTMENTS) {
      const permitted = contractOutputTypes(registry.get(d.agentId)).types;
      const excepted = new Set((d.producesBeyondContract ?? []).map((e) => e.type));
      for (const type of d.produces) {
        const ok = permitted.includes(type) || excepted.has(type);
        expect(ok, d.id + ' (' + d.agentId + ') claims ' + type).toBe(true);
      }
    }
  });

  it('every beyond-contract exception states a reason', () => {
    /*
     * The exception list is the record of R4 gaps. It is enumerated here so that adding
     * one is a visible diff somebody has to read, rather than a quiet widening.
     */
    const exceptions = UPSTREAM_DEPARTMENTS.flatMap((d) =>
      (d.producesBeyondContract ?? []).map((e) => d.id + ':' + e.type),
    ).sort();
    /*
     * `intel.openQuestion` is deliberately absent: it became UNIVERSAL when routing made
     * it governance rather than departmental output, and the validator refused the
     * now-redundant exception the moment it did.
     */
    expect(exceptions).toEqual([
      'DEPT-INTAKE:intel.clientInput',
      'DEPT-INTAKE:intel.constraint',
      'DEPT-INTAKE:intel.projectGoal',
      'DEPT-PRODUCT-VALIDATION:intel.feature',
      'DEPT-RISK:intel.risk',
    ]);
    for (const d of UPSTREAM_DEPARTMENTS) {
      for (const e of d.producesBeyondContract ?? []) {
        expect(e.why.length, d.id + ':' + e.type + ' has no reason').toBeGreaterThan(20);
      }
    }
  });

  it('the two authorities the audit found merged are now separate runs', () => {
    const byAgent = new Map(UPSTREAM_DEPARTMENTS.map((d) => [d.agentId, d]));

    /* 140 classifies; 141 designs. Different agents, different write scopes. */
    expect(byAgent.get('SC-AGENT-140')?.produces).not.toContain(ARTIFACT_TYPES.ADMIN_IA);
    expect(byAgent.get('SC-AGENT-140')?.produces).not.toContain(ARTIFACT_TYPES.OPERATIONAL_CONTROL);
    expect(byAgent.get('SC-AGENT-141')?.produces).toContain(ARTIFACT_TYPES.ADMIN_IA);

    /* 210 strategises; 211 writes cases. */
    expect(byAgent.get('SC-AGENT-210')?.produces).toEqual([ARTIFACT_TYPES.TEST_STRATEGY]);
    expect(byAgent.get('SC-AGENT-211')?.produces).toEqual([ARTIFACT_TYPES.TEST_CASE]);

    /* And the one the validator found on its own: 071 evaluates, 070 decides. */
    expect(byAgent.get('SC-AGENT-071')?.produces).not.toContain(ARTIFACT_TYPES.ADR);
    expect(
      UPSTREAM_DEPARTMENTS.filter((d) => d.agentId === 'SC-AGENT-070').flatMap((d) => d.produces),
    ).toContain(ARTIFACT_TYPES.ADR);
  });

  it('SC-AGENT-211 is never shown the implementation', () => {
    const cases = UPSTREAM_DEPARTMENTS.find((d) => d.agentId === 'SC-AGENT-211');
    expect(cases).toBeDefined();
    const f = setup();
    const spec = cases?.buildContext(context(f));
    const excluded = (spec?.excluded ?? []).map((e) => e.subject).join(' ');
    expect(excluded).toMatch(/implementation/i);
    /* §29: what it DOES get is specification-derived truth. */
    expect(cases?.requires).toContain(ARTIFACT_TYPES.TEST_STRATEGY);
  });
});

describe('a misconfigured department is refused before it runs', () => {
  it('a department claiming another agent’s artifact fails validation by name', () => {
    const rogue = {
      id: 'DEPT-ROGUE',
      agentId: 'SC-AGENT-052',
      produces: [ARTIFACT_TYPES.DESIGN_TOKEN_SET],
    };
    const refusal = authorityRefusal(rogue, registry);
    expect(refusal).toContain('DEPT-ROGUE');
    expect(refusal).toContain('SC-AGENT-052');
    expect(refusal).toContain(ARTIFACT_TYPES.DESIGN_TOKEN_SET);
    expect(() => validateDepartmentAuthority([rogue], registry)).toThrow(/misconfigured/);
  });

  it('a department declaring nothing is refused', () => {
    expect(authorityRefusal({ id: 'DEPT-SILENT', agentId: 'SC-AGENT-052' }, registry)).toContain(
      'declares no outputs',
    );
  });

  it('an unknown artifact type is refused', () => {
    expect(
      authorityRefusal(
        { id: 'DEPT-TYPO', agentId: 'SC-AGENT-052', produces: ['intel.notAThing'] },
        registry,
      ),
    ).toContain('unknown artifact type');
  });

  it('an exception with no stated reason is refused', () => {
    expect(
      authorityRefusal(
        {
          id: 'DEPT-EXCUSE',
          agentId: 'SC-AGENT-052',
          produces: [ARTIFACT_TYPES.FEATURE],
          producesBeyondContract: [{ type: ARTIFACT_TYPES.FEATURE, why: 'because' }],
        },
        registry,
      ),
    ).toContain('without saying why');
  });
});

describe('the write boundary itself refuses, atomically', () => {
  /**
   * The adversarial case the closure asks for.
   *
   * This department is authorised for one artifact and its persist writes two: the
   * authorised one FIRST, then one belonging to another agent. If the enforcement were an
   * audit after persistence, the first write would already be staged and the best
   * available outcome would be an attempted rollback.
   */
  function malicious(): DepartmentConfig<typeof OutputSchema> {
    return {
      id: 'DEPT-MALICIOUS',
      stageId: 'SC-STAGE-011',
      agentId: 'SC-AGENT-050',
      title: 'Deliberately overreaching department',
      produces: [ARTIFACT_TYPES.REQUIREMENT],
      outputSchema: OutputSchema,
      outputJsonSchema: jsonSchemaFor(OutputSchema),
      buildContext: () => ({ canon: [], excluded: [] }),
      task: () => 'do the thing',
      scopeBoundary: () => 'nothing',
      persist(tx, _output, ctx) {
        const at = ctx.clock.now();

        /* 1. Something it IS allowed to write. */
        const reqId = ctx.ids.next('SC-REQ');
        tx.putCanon(ARTIFACT_TYPES.REQUIREMENT, reqId, {
          id: reqId,
          version: 1,
          createdAt: at,
          statement: 'The system shall do the authorised thing',
          meta: { provenance: { marking: 'SYSTEM', component: 'test' }, attribution: { at } },
        });

        /* 2. Something belonging to SC-AGENT-130. */
        const tokenId = ctx.ids.next('SC-DTS');
        tx.putCanon(ARTIFACT_TYPES.DESIGN_TOKEN_SET, tokenId, { id: tokenId, stolen: true });

        return { artifactIds: [reqId, tokenId] };
      },
    } as DepartmentConfig<typeof OutputSchema>;
  }

  it('refuses the unauthorised write and commits NOTHING', async () => {
    const f = setup();
    f.engine.script('SC-AGENT-050', { structuredOutput: envelope({ note: 'overreaching' }) });

    const result = await runDepartment(runnerDeps(f, ['SC-AGENT-050']), malicious(), context(f));

    expect(result.outcome).toBe(DepartmentOutcome.FAILED);
    expect(result.reason).toContain(ARTIFACT_TYPES.DESIGN_TOKEN_SET);

    /* The unauthorised artifact does not exist... */
    expect(f.store.listCanonIds(ARTIFACT_TYPES.DESIGN_TOKEN_SET)).toHaveLength(0);
    /* ...and neither does the authorised one that was staged before it. Atomicity. */
    expect(f.store.listCanonIds(ARTIFACT_TYPES.REQUIREMENT)).toHaveLength(0);
  });

  it('the refusal names the department, the agent and what it may write', async () => {
    const f = setup();
    f.engine.script('SC-AGENT-050', { structuredOutput: envelope({ note: 'overreaching' }) });
    const result = await runDepartment(runnerDeps(f, ['SC-AGENT-050']), malicious(), context(f));
    expect(result.reason).toContain('DEPT-MALICIOUS');
    expect(result.reason).toContain('SC-AGENT-050');
  });

  it('a restart reveals no partial mutation', async () => {
    const root = tempRoot();
    roots.push(root);
    const clock = new FixedClock();
    const ids = new SequentialIdSource();
    const store = Store.initialize(root, { clock, ids, actor: 'AUTHORITY_TEST' });
    const engine = new FakeEngineAdapter({ clock });
    engine.script('SC-AGENT-050', { structuredOutput: envelope({ note: 'overreaching' }) });

    const plan = resolveApplicability('PRF-NEW-PRODUCT');
    await runDepartment(
      {
        store,
        clock,
        ids,
        registry,
        runtime: new AgentRuntime({
          store,
          ids,
          clock,
          registry,
          engine,
          enabledAgents: new Set(['SC-AGENT-050']),
          projectRoot: root,
        }),
        projectRoot: root,
        enabledAgents: new Set(['SC-AGENT-050']),
      },
      malicious(),
      {
        workItemId: 'SC-WI-000971',
        store,
        clock,
        ids,
        plan,
        stage: plan.stages[0] as never,
      },
    );

    /* A process that has seen nothing sees nothing. */
    const reopened = Store.open(root, {
      clock: new FixedClock(),
      ids: new SequentialIdSource(),
      actor: 'AUTHORITY_TEST_2',
    });
    expect(reopened.listCanonIds(ARTIFACT_TYPES.REQUIREMENT)).toHaveLength(0);
    expect(reopened.listCanonIds(ARTIFACT_TYPES.DESIGN_TOKEN_SET)).toHaveLength(0);
    expect(reopened.verifyCanon().problems).toEqual([]);
  });

  it('an authorised department still writes normally', async () => {
    const f = setup();
    f.engine.script('SC-AGENT-050', { structuredOutput: envelope({ note: 'behaving' }) });

    const wellBehaved = {
      ...malicious(),
      id: 'DEPT-BEHAVED',
      persist(
        tx: Parameters<DepartmentConfig<typeof OutputSchema>['persist']>[0],
        _o: unknown,
        ctx: DepartmentContext,
      ) {
        const at = ctx.clock.now();
        const id = ctx.ids.next('SC-GOAL');
        repository(ctx.store, ARTIFACT_TYPES.PROJECT_GOAL, ProjectGoalSchema).put(tx, {
          id,
          createdAt: at,
          statement: 'A goal the department is allowed to write',
          successIndicator: 'it exists',
          priority: 'MUST',
          meta: { provenance: { marking: 'OWNER_STATED', statedAt: at }, attribution: { at } },
        } as never);
        return { artifactIds: [id] };
      },
      produces: [ARTIFACT_TYPES.PROJECT_GOAL],
      producesBeyondContract: [
        {
          type: ARTIFACT_TYPES.PROJECT_GOAL,
          why: 'the intake framing artifacts are claimed by no contract in 32; recorded as SF-12',
        },
      ],
    } as DepartmentConfig<typeof OutputSchema>;

    const result = await runDepartment(runnerDeps(f, ['SC-AGENT-050']), wellBehaved, context(f));
    expect(result.outcome, result.reason ?? '').toBe(DepartmentOutcome.COMPLETED);
    expect(f.store.listCanonIds(ARTIFACT_TYPES.PROJECT_GOAL)).toHaveLength(1);
  });
});

describe('the split departments write only their own canon', () => {
  it('ADRs are authored by the architect, and test cases by the case designer', async () => {
    /*
     * Read from a real run rather than from configuration: the E2E scenario exercises all
     * three splits, and the attribution on the artifacts is what actually landed.
     */
    const { store, root, deps } = freshStore();
    roots.push(root);
    const { E2E_SCRIPT, resolvingEngine, seedRetriever } = await import('./fixtures/intelE2E.js');
    const { intelligenceOrchestrator, recordIdea } = await import('../src/intelligence/app.js');
    const { configureResearchSeeds } = await import('../src/intelligence/departments/research.js');

    const engine = new FakeEngineAdapter({ clock: deps.clock });
    for (const [agentId, output] of E2E_SCRIPT)
      engine.script(agentId, { structuredOutput: output });
    configureResearchSeeds({ hosts: ['example.com'], urls: ['https://example.com/rival-a'] });
    const intel = {
      store,
      clock: deps.clock,
      ids: deps.ids,
      engine: resolvingEngine(engine, store),
      projectRoot: root,
      gateway: { store, clock: deps.clock, ids: deps.ids, retriever: seedRetriever() },
    };
    recordIdea(intel, 'bakery order capture');
    await intelligenceOrchestrator(intel, 'SC-WI-000972', 'PRF-NEW-PRODUCT').advance();
    configureResearchSeeds({ hosts: [], urls: [] });

    const adrs = repository(store, ARTIFACT_TYPES.ADR, AdrSchema).list();
    expect(adrs.length).toBeGreaterThan(0);
    for (const a of adrs) expect(a.meta.attribution.agentId).toBe('SC-AGENT-070');

    const cases = repository(store, ARTIFACT_TYPES.TEST_CASE, TestCaseSchema).list();
    expect(cases.length).toBeGreaterThan(0);
    for (const c of cases) {
      expect(c.meta.attribution.agentId).toBe('SC-AGENT-211');
      /* §29: structurally, not by promise. */
      expect(c.implementationInformed).toBe(false);
    }

    const authorsOf = (type: string): Set<string> => {
      const out = new Set<string>();
      for (const id of store.listCanonIds(type)) {
        const env = store.getCanon<{ meta?: { attribution?: { agentId?: string } } }>(type, id);
        const who = env?.body?.meta?.attribution?.agentId;
        if (who !== undefined) out.add(who);
      }
      return out;
    };
    expect([...authorsOf(ARTIFACT_TYPES.ADMIN_IA)]).toEqual(['SC-AGENT-141']);
    expect([...authorsOf(ARTIFACT_TYPES.OPERATIONAL_CONTROL)]).toEqual(['SC-AGENT-141']);
    expect([...authorsOf(ARTIFACT_TYPES.ADMIN_OPERABILITY_REVIEW)]).toEqual(['SC-AGENT-140']);
    expect([...authorsOf(ARTIFACT_TYPES.TEST_STRATEGY)]).toEqual(['SC-AGENT-210']);
  }, 180_000);
});
