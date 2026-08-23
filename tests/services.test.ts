import { afterEach, describe, expect, it } from 'vitest';
import { ServaRuntime } from '../src/app/runtime.js';
import {
  ACTIONS,
  ActionConsequence,
  actionCatalogue,
  invokeAction,
  requireAction,
} from '../src/app/actions.js';
import { ProjectHealth, isServaProject, projectSnapshot } from '../src/app/services.js';
import {
  ConditionState,
  ReleaseReadinessStatus,
  assessReleaseReadiness,
} from '../src/intelligence/releaseReadiness.js';
import { ARTIFACT_TYPES, repository } from '../src/intelligence/repository.js';
import { OwnerDecisionRequestSchema } from '../src/intelligence/artifacts/governance.js';
import { RequirementSchema } from '../src/intelligence/artifacts/requirements.js';
import { ReleaseSchema, ReleaseState } from '../src/intelligence/artifacts/release.js';
import { DefectSchema } from '../src/intelligence/artifacts/quality.js';
import { MachineQualificationState, unqualified } from '../src/portability/machine.js';
import { cleanup, tempRoot } from './helpers.js';

/**
 * ONE COMPANY UNDERNEATH, AND ONE DOOR INTO IT.
 *
 * Two failures these guard against, and both are the kind that only show up in a product
 * rather than in a library.
 *
 * The first is two implementations of "is this project blocked" — one in the CLI, one in a
 * panel — which WILL disagree, and the one people believe will be the one with the nicer
 * typography. So status is derived, in one function, with no setter anywhere.
 *
 * The second is a webview. It is a browser, its messages are strings, and a project file
 * can put HTML on a screen. Every consequential thing it can ask for goes through a fixed
 * table with a parsed payload and an explicit confirmation.
 */

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) cleanup(r);
});

function project(): ServaRuntime {
  const root = tempRoot();
  roots.push(root);
  return ServaRuntime.init('RahalGo', 'Stop losing phone orders in the morning rush', { root });
}

function seedOwnerDecision(rt: ServaRuntime, o: { blocksWork: boolean }): string {
  const at = rt.clock.now();
  const id = rt.ids.next('SC-ODR');
  const tx = rt.store.begin();
  repository(rt.store, ARTIFACT_TYPES.OWNER_DECISION_REQUEST, OwnerDecisionRequestSchema).put(tx, {
    id,
    createdAt: at,
    question: 'Should merchants set their own cancellation policy?',
    whyServaCannotDecide: 'it is a commercial policy, not a technical choice',
    purpose: 'BUSINESS_RULE',
    options: [
      { option: 'One platform-wide policy', impact: 'simpler to explain', disposition: 'INFORM' },
      { option: 'Per-merchant policy', impact: 'more flexible', disposition: 'INFORM' },
    ],
    recommendation: 'One platform-wide policy',
    recommendationRationale: 'nothing yet suggests merchants differ',
    blocksWork: o.blocksWork,
    blockedRefs: [],
    state: 'OPEN',
    meta: { provenance: { marking: 'SYSTEM', component: 'test' }, attribution: { at } },
  } as never);
  tx.commit();
  return id;
}

/* ============================================================== the derived status */

describe('project status is derived, and there is no way to set it', () => {
  it('a fresh project is NOT_STARTED, not ACTIVE', () => {
    const rt = project();
    const snapshot = projectSnapshot(rt);
    /* A green bar that means "a panel loaded" is the failure this prevents. */
    expect(snapshot.health).toBe(ProjectHealth.NOT_STARTED);
    expect(snapshot.headline).toContain('has not run yet');
  });

  it('a blocking owner decision makes the project OWNER_ACTION and names the question', () => {
    const rt = project();
    seedOwnerDecision(rt, { blocksWork: true });
    const snapshot = projectSnapshot(rt, { workItemId: 'SC-WI-000001' });
    expect(snapshot.health).toBe(ProjectHealth.OWNER_ACTION);
    expect(snapshot.ownerActions).toHaveLength(1);
    expect(snapshot.nextAction).toContain('cancellation policy');
    /* The recommendation travels with the question: an owner should not have to hunt. */
    expect(snapshot.ownerActions[0]?.recommendation).toBe('One platform-wide policy');
    expect(snapshot.ownerActions[0]?.whyServaCannotDecide).toContain('commercial policy');
  });

  it('a non-blocking question does not stop the company', () => {
    const rt = project();
    seedOwnerDecision(rt, { blocksWork: false });
    const snapshot = projectSnapshot(rt, { workItemId: 'SC-WI-000001' });
    expect(snapshot.health).not.toBe(ProjectHealth.OWNER_ACTION);
    expect(snapshot.ownerActions).toHaveLength(1);
  });

  it('divergence and recovery outrank everything else', () => {
    const rt = project();
    seedOwnerDecision(rt, { blocksWork: true });
    expect(projectSnapshot(rt, { divergence: true }).health).toBe(ProjectHealth.DIVERGENCE);
    expect(projectSnapshot(rt, { divergence: true, recoveryRequired: true }).health).toBe(
      ProjectHealth.RECOVERY_REQUIRED,
    );
  });

  it('an unqualified machine never reports engineering as permitted', () => {
    const rt = project();
    const snapshot = projectSnapshot(rt, {
      qualification: unqualified({
        machineId: 'M',
        identity: { platform: 'win32', release: '10', architecture: 'x64', nodeVersion: 'v20' },
        reason: 'restored from a backup taken on another computer',
        restoredFromBackup: true,
      }),
    });
    expect(snapshot.machine.state).toBe(MachineQualificationState.UNQUALIFIED);
    expect(snapshot.machine.engineeringPermitted).toBe(false);
    expect(snapshot.machine.reason).toContain('another computer');
  });

  it('with no qualification at all, engineering is still not permitted', () => {
    const snapshot = projectSnapshot(project());
    /* Absent is not permissive. Fail-closed applies to the field nobody set. */
    expect(snapshot.machine.engineeringPermitted).toBe(false);
  });

  it('recognises a Serva project by its store marker', () => {
    const rt = project();
    expect(isServaProject(rt.root)).toBe(true);
    const empty = tempRoot();
    roots.push(empty);
    expect(isServaProject(empty)).toBe(false);
  });
});

/* ============================================================= release readiness */

describe('release readiness is derived, and NOT_VERIFIED blocks', () => {
  it('an empty project is NOT_VERIFIED rather than blocked or ready', () => {
    const readiness = assessReleaseReadiness({ store: project().store, clock: project().clock });
    expect(readiness.status).toBe(ReleaseReadinessStatus.NOT_VERIFIED);
    expect(readiness.summary).toContain('NO EVIDENCE = NOT VERIFIED');
    /* And it says so as a list, not as one blocking message at a time. */
    expect(readiness.unverified.length).toBeGreaterThan(3);
  });

  it('a proven failure BLOCKS, and reads differently from an absence', () => {
    const rt = project();
    const at = rt.clock.now();
    const tx = rt.store.begin();
    repository(rt.store, ARTIFACT_TYPES.DEFECT, DefectSchema).put(tx, {
      id: rt.ids.next('SC-DEF'),
      createdAt: at,
      title: 'Checkout drops the second item',
      detail: 'adding two items keeps one',
      severity: 'CRITICAL',
      affects: [],
      reproduction: 'add two items, open the basket',
      state: 'OPEN',
      foundByAgentId: 'SC-AGENT-214',
      meta: { provenance: { marking: 'SYSTEM', component: 'test' }, attribution: { at } },
    } as never);
    tx.commit();

    const readiness = assessReleaseReadiness({ store: rt.store, clock: rt.clock });
    expect(readiness.status).toBe(ReleaseReadinessStatus.BLOCKED);
    expect(readiness.blockers.join(' ')).toContain('Checkout drops the second item');
  });

  it('owner authority is a condition no agent output can satisfy', () => {
    const rt = project();
    const at = rt.clock.now();
    const tx = rt.store.begin();
    repository(rt.store, ARTIFACT_TYPES.RELEASE, ReleaseSchema).put(tx, {
      id: rt.ids.next('SC-REL'),
      createdAt: at,
      releaseVersion: '1.0.0',
      name: 'First release',
      state: ReleaseState.CANDIDATE,
      changeSetRefs: [],
      requirementRefs: [],
      notes: ['first release'],
      knownLimitations: [],
      artifactManifest: [],
      meta: {
        provenance: { marking: 'DERIVED', from: ['changes'], rationale: 'candidate' },
        attribution: { agentId: 'SC-AGENT-250', at },
      },
    } as never);
    tx.commit();

    const readiness = assessReleaseReadiness({ store: rt.store, clock: rt.clock });
    const authority = readiness.conditions.find((c) => c.id === 'RR-OWNER-AUTHORITY');
    /* A candidate exists; nobody authorised it. That is NOT_MET, not merely unverified. */
    expect(authority?.state).toBe(ConditionState.NOT_MET);
    expect(authority?.detail).toContain('no owner decision authorises it');
    expect(readiness.status).toBe(ReleaseReadinessStatus.BLOCKED);
  });

  it('a project with no NFR reports performance NOT_APPLICABLE rather than failing it', () => {
    const readiness = assessReleaseReadiness({ store: project().store, clock: project().clock });
    const performance = readiness.conditions.find((c) => c.id === 'RR-PERFORMANCE');
    expect(performance?.state).toBe(ConditionState.NOT_APPLICABLE);
  });

  it('every condition carries evidence or says plainly that there is none', () => {
    const rt = project();
    const at = rt.clock.now();
    const tx = rt.store.begin();
    repository(rt.store, ARTIFACT_TYPES.REQUIREMENT, RequirementSchema).put(tx, {
      id: rt.ids.next('SC-REQ'),
      createdAt: at,
      statement: 'The system shall take an order by phone',
      kind: 'FUNCTIONAL',
      priority: 'MUST',
      rationale: 'the shop takes orders by phone',
      tracesTo: [],
      meta: { provenance: { marking: 'OWNER_STATED', statedAt: at }, attribution: { at } },
    } as never);
    tx.commit();

    const readiness = assessReleaseReadiness({ store: rt.store, clock: rt.clock });
    const requirements = readiness.conditions.find((c) => c.id === 'RR-REQUIREMENTS');
    expect(requirements?.state).toBe(ConditionState.MET);
    expect(requirements?.evidence.length).toBeGreaterThan(0);
  });
});

/* ================================================================= action registry */

describe('every consequential action is a validated command', () => {
  it('an unknown action is refused as a result, not thrown', async () => {
    const rt = project();
    const result = await invokeAction({ rt }, { id: 'project.deleteEverything' });
    expect(result.ok).toBe(false);
    expect(result.refusal).toContain('no action named');
    /* Dispatch is by exact id against a fixed table. */
    expect(ACTIONS.has('project.deleteEverything')).toBe(false);
  });

  it('a malformed payload is refused before the handler sees it', async () => {
    const rt = project();
    const result = await invokeAction(
      { rt },
      { id: 'owner.answer', input: { decisionId: 42 }, confirmed: true },
    );
    expect(result.ok).toBe(false);
    expect(result.refusal).toContain('does not match');
  });

  it('an unexpected extra field is refused rather than ignored', async () => {
    const rt = project();
    const decisionId = seedOwnerDecision(rt, { blocksWork: true });
    const result = await invokeAction(
      { rt },
      {
        id: 'owner.answer',
        input: {
          decisionId,
          chosenOption: 'One platform-wide policy',
          answeredBy: 'owner',
          /* A field nobody declared is a field nobody validated. */
          bypassGates: true,
        },
        confirmed: true,
      },
    );
    expect(result.ok).toBe(false);
    expect(result.refusal).toContain('does not match');
  });

  it('a consequential action without confirmation is refused, and says what is at stake', async () => {
    const rt = project();
    const decisionId = seedOwnerDecision(rt, { blocksWork: true });
    const result = await invokeAction(
      { rt },
      {
        id: 'owner.answer',
        input: { decisionId, chosenOption: 'One platform-wide policy', answeredBy: 'owner' },
      },
    );
    expect(result.ok).toBe(false);
    expect(result.refusal).toContain('project truth');
  });

  it('with confirmation, the governed function does the work and the Store changes', async () => {
    const rt = project();
    const decisionId = seedOwnerDecision(rt, { blocksWork: true });
    const result = await invokeAction(
      { rt },
      {
        id: 'owner.answer',
        input: { decisionId, chosenOption: 'One platform-wide policy', answeredBy: 'owner' },
        confirmed: true,
      },
    );
    expect(result.ok, result.refusal ?? '').toBe(true);

    const stored = repository(
      rt.store,
      ARTIFACT_TYPES.OWNER_DECISION_REQUEST,
      OwnerDecisionRequestSchema,
    ).get(decisionId);
    expect(stored?.state).toBe('ANSWERED');
    expect(stored?.answeredBy).toBe('owner');
    /* And the derived status moves on its own, because nothing set it. */
    expect(projectSnapshot(rt).ownerActions).toHaveLength(0);
  });

  it('an agent cannot answer an owner decision through the action layer either', async () => {
    const rt = project();
    const decisionId = seedOwnerDecision(rt, { blocksWork: true });
    const result = await invokeAction(
      { rt },
      {
        id: 'owner.answer',
        input: {
          decisionId,
          chosenOption: 'One platform-wide policy',
          answeredBy: 'SC-AGENT-020',
        },
        confirmed: true,
      },
    );
    expect(result.ok).toBe(false);
    /* The refusal comes from the governed function, with its reason intact. */
    expect(result.refusal).toContain('answered by a person');
  });

  it('free text cannot answer a question that offered options', async () => {
    const rt = project();
    const decisionId = seedOwnerDecision(rt, { blocksWork: true });
    const result = await invokeAction(
      { rt },
      {
        id: 'owner.answer',
        input: { decisionId, chosenOption: 'whatever you think best', answeredBy: 'owner' },
        confirmed: true,
      },
    );
    expect(result.ok).toBe(false);
  });

  it('read actions need no confirmation, and never change anything', async () => {
    const rt = project();
    for (const id of ['project.snapshot', 'release.readiness', 'coverage.report']) {
      const result = await invokeAction({ rt }, { id });
      expect(result.ok, id + ': ' + String(result.refusal)).toBe(true);
    }
  });

  it('the catalogue declares consequence, and every non-read action carries a prompt', () => {
    for (const entry of actionCatalogue()) {
      if (entry.consequence === ActionConsequence.READ) continue;
      expect(entry.confirmPrompt, entry.id + ' has no confirmation prompt').toBeDefined();
      expect(String(entry.confirmPrompt).length).toBeGreaterThan(30);
    }
  });

  it('there is no action that sets a status, a gate verdict or readiness', () => {
    /*
     * The absence IS the property. An action that could set one would make every
     * derivation in the product decorative, and a UI would eventually call it.
     */
    for (const id of ACTIONS.keys()) {
      expect(id).not.toMatch(/set|mark|force|override|declare|approveGate|waive/i);
    }
  });

  it('requireAction names what exists rather than failing silently', () => {
    expect(() => requireAction('nope')).toThrow(/Unknown Serva action/);
    expect(requireAction('project.snapshot').consequence).toBe(ActionConsequence.READ);
  });

  it('coverage is reachable through the same door as everything else', async () => {
    const result = await invokeAction({ rt: project() }, { id: 'coverage.report' });
    expect(result.ok).toBe(true);
    expect(result.summary).toBe('stages 26/26, gates 19/19');
  });
});
