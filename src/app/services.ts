import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ARTIFACT_TYPES, repository } from '../intelligence/repository.js';
import { OwnerDecisionRequestSchema } from '../intelligence/artifacts/governance.js';
import { ProposalSchema, ProposalState } from '../intelligence/artifacts/governance.js';
import { RiskSchema } from '../intelligence/artifacts/governance.js';
import { IncidentSchema, IncidentState } from '../intelligence/artifacts/incident.js';
import { DefectSchema, SecurityFindingSchema } from '../intelligence/artifacts/quality.js';
import { readOrchestratorRecord } from '../intelligence/execution/orchestrator.js';
import { outstandingObligations } from '../intelligence/execution/obligations.js';
import { assessReleaseReadiness } from '../intelligence/releaseReadiness.js';
import { buildAdvantageBoard, staleAdvantage } from '../intelligence/views/advantageBoard.js';
import { resolveApplicability } from '../intelligence/applicability.js';
import { lifecycleCoverage } from '../coverage/index.js';
import { SERVA_DIR } from '../store/paths.js';
import { MachineQualificationState } from '../portability/machine.js';
import { SERVA_VERSION } from '../portability/version.js';
import type { ServaRuntime } from './runtime.js';
import type { MachineQualification } from '../portability/machine.js';
import type { ReleaseReadiness } from '../intelligence/releaseReadiness.js';

/**
 * ONE COMPANY UNDERNEATH.
 *
 * SPEC: §2, §4, §6, §49.
 *
 * The extension is a CLIENT. It does not open the Store a second way, does not decide what
 * a gate means, and does not compute a status of its own — everything below is what the
 * CLI calls too, so a state transition made from a panel and the same transition made from
 * a terminal are the same transition.
 *
 * That is not tidiness. Two implementations of "is this project blocked" WILL disagree, and
 * the one people believe will be the one with the nicer typography.
 *
 * THE STATUS IS DERIVED, ALWAYS. There is deliberately no way to set it. A UI that could
 * say ACTIVE would eventually say ACTIVE because it had loaded, and an owner would read a
 * green bar as a governed company when it meant a panel had rendered.
 */

export const ProjectHealth = {
  /** Governed, running, nothing waiting. */
  ACTIVE: 'ACTIVE',
  /** Stopped on something only the owner can answer. */
  OWNER_ACTION: 'OWNER_ACTION',
  /** A gate refused, or a department could not proceed. */
  BLOCKED: 'BLOCKED',
  /** Engineering is running under the boundary. */
  ENGINEERING: 'ENGINEERING',
  /** The machine has not earned HARD, so write-capable work cannot run. */
  UNQUALIFIED: 'UNQUALIFIED',
  /** The workspace changed outside Serva. */
  DIVERGENCE: 'DIVERGENCE',
  /** Something ended in an unknown state. Never retried silently. */
  RECOVERY_REQUIRED: 'RECOVERY_REQUIRED',
  /** A project exists and nothing has run yet. */
  NOT_STARTED: 'NOT_STARTED',
} as const;
export type ProjectHealth = (typeof ProjectHealth)[keyof typeof ProjectHealth];

export interface StageView {
  readonly stageId: string;
  readonly name: string;
  readonly phase: string;
  readonly gate?: string;
  readonly state: 'COMPLETE' | 'RAN' | 'IN_PROGRESS' | 'PENDING' | 'NOT_APPLICABLE';
  readonly verdict?: string;
  readonly departments: readonly string[];
}

export interface OwnerActionView {
  readonly id: string;
  readonly question: string;
  readonly whyServaCannotDecide: string;
  readonly recommendation: string;
  readonly recommendationRationale: string;
  readonly responseMode: string;
  readonly valueKind?: string;
  readonly options: readonly { readonly option: string; readonly impact: string }[];
  readonly blocksWork: boolean;
}

export interface ProjectSnapshot {
  readonly servaVersion: string;
  readonly root: string;
  readonly projectName: string;
  readonly profileId?: string;
  readonly workItemId?: string;
  readonly health: ProjectHealth;
  readonly headline: string;
  readonly nextAction: string;
  readonly stages: readonly StageView[];
  readonly ownerActions: readonly OwnerActionView[];
  readonly blockers: readonly string[];
  readonly staleFacts: readonly string[];
  readonly openProposals: number;
  readonly openIncidents: number;
  readonly openDefects: number;
  readonly openSecurityFindings: number;
  readonly outstandingObligations: number;
  readonly release: ReleaseReadiness;
  readonly machine: {
    readonly state: MachineQualificationState;
    readonly reason: string;
    readonly engineeringPermitted: boolean;
  };
}

export interface SnapshotOptions {
  readonly workItemId?: string;
  readonly qualification?: MachineQualification;
  /** True when the workspace has changed outside Serva. Supplied by the caller. */
  readonly divergence?: boolean;
  /** True when an operation ended in an unknown state and needs a decision. */
  readonly recoveryRequired?: boolean;
}

/**
 * Everything the owner-facing surfaces read, computed once from the Store.
 *
 * One function rather than a dozen accessors, because a panel that fetched status, then
 * owner actions, then gates would render a picture that never existed at any single moment
 * — and the inconsistencies would show up as a decision that looks answered next to a stage
 * that says it is waiting.
 */
export function projectSnapshot(rt: ServaRuntime, o: SnapshotOptions = {}): ProjectSnapshot {
  const store = rt.store;
  const record =
    o.workItemId === undefined ? undefined : readOrchestratorRecord(store, o.workItemId);

  const decisions = repository(
    store,
    ARTIFACT_TYPES.OWNER_DECISION_REQUEST,
    OwnerDecisionRequestSchema,
  )
    .list()
    .filter((d) => d.state === 'OPEN');
  const ownerActions: OwnerActionView[] = decisions.map((d) => ({
    id: d.id,
    question: d.question,
    whyServaCannotDecide: d.whyServaCannotDecide,
    recommendation: d.recommendation,
    recommendationRationale: d.recommendationRationale,
    responseMode: d.responseMode,
    ...(d.valueKind === undefined ? {} : { valueKind: d.valueKind }),
    options: d.options.map((opt) => ({ option: opt.option, impact: opt.impact })),
    blocksWork: d.blocksWork,
  }));

  const proposals = repository(store, ARTIFACT_TYPES.PROPOSAL, ProposalSchema)
    .list()
    .filter((p) => p.state === ProposalState.PROPOSED || p.state === ProposalState.ASSESSED);
  const incidents = repository(store, ARTIFACT_TYPES.INCIDENT, IncidentSchema)
    .list()
    .filter((i) => i.state !== IncidentState.CLOSED);
  const defects = repository(store, ARTIFACT_TYPES.DEFECT, DefectSchema)
    .list()
    .filter((d) => d.state === 'OPEN');
  const securityFindings = repository(store, ARTIFACT_TYPES.SECURITY_FINDING, SecurityFindingSchema)
    .list()
    .filter((f) => f.state === 'OPEN');
  const risks = repository(store, ARTIFACT_TYPES.RISK, RiskSchema)
    .list()
    .filter((r) => r.state === 'OPEN' && (r.severity === 'CRITICAL' || r.severity === 'HIGH'));

  const board = buildAdvantageBoard(store, rt.clock);
  const staleFacts = staleAdvantage(board).map(
    (r) => r.statement + ' — ' + (r.cause ?? 'the research it rests on has expired'),
  );

  const obligations = o.workItemId === undefined ? [] : outstandingObligations(store, o.workItemId);

  const release = assessReleaseReadiness({ store, clock: rt.clock });

  const machineState = o.qualification?.state ?? MachineQualificationState.UNQUALIFIED;
  const machineReason =
    o.qualification === undefined
      ? 'this machine has not been measured, so write-capable engineering cannot run on it'
      : o.qualification.reason;

  const stages = buildStages(record?.profileId, record);

  /*
   * PRECEDENCE MATTERS. A project can be several of these at once, and the order below is
   * what the owner needs to act on first: something that ended unknown outranks a
   * divergence, which outranks a block, which outranks a question.
   */
  const health: ProjectHealth =
    o.recoveryRequired === true
      ? ProjectHealth.RECOVERY_REQUIRED
      : o.divergence === true
        ? ProjectHealth.DIVERGENCE
        : record?.state === 'BLOCKED'
          ? ProjectHealth.BLOCKED
          : /*
             * A waiting question outranks NOT_STARTED. "Not started" describes Serva;
             * "somebody is waiting for you" describes the owner, and only one of those is
             * something they can act on.
             */
            ownerActions.some((a) => a.blocksWork)
            ? ProjectHealth.OWNER_ACTION
            : record === undefined
              ? ProjectHealth.NOT_STARTED
              : machineState !== MachineQualificationState.HARD
                ? ProjectHealth.UNQUALIFIED
                : ProjectHealth.ACTIVE;

  return {
    servaVersion: SERVA_VERSION,
    root: rt.root,
    projectName: projectName(rt),
    ...(record?.profileId === undefined ? {} : { profileId: record.profileId }),
    ...(o.workItemId === undefined ? {} : { workItemId: o.workItemId }),
    health,
    headline: headlineFor(health, record?.blockedReason, ownerActions.length),
    nextAction: nextActionFor(health, ownerActions, record?.blockedReason, machineReason),
    stages,
    ownerActions,
    blockers: [
      ...(record?.blockedReason === undefined ? [] : [record.blockedReason]),
      ...risks.map((r) => r.severity + ' risk: ' + r.statement),
      ...release.blockers,
    ],
    staleFacts,
    openProposals: proposals.length,
    openIncidents: incidents.length,
    openDefects: defects.length,
    openSecurityFindings: securityFindings.length,
    outstandingObligations: obligations.length,
    release,
    machine: {
      state: machineState,
      reason: machineReason,
      /* Never inferred from a record's own word. HARD is the only permitting state. */
      engineeringPermitted: machineState === MachineQualificationState.HARD,
    },
  };
}

function projectName(rt: ServaRuntime): string {
  try {
    const project = rt.store.getCanon<{ readonly name?: string }>('project', 'project');
    return project?.body.name ?? rt.root.split(/[\\/]/).pop() ?? 'project';
  } catch {
    return rt.root.split(/[\\/]/).pop() ?? 'project';
  }
}

/** The lifecycle as the owner sees it: stage by stage, with what happened to each. */
function buildStages(
  profileId: string | undefined,
  record: ReturnType<typeof readOrchestratorRecord>,
): readonly StageView[] {
  const coverage = lifecycleCoverage();
  const plan = profileId === undefined ? undefined : resolveApplicability(profileId);
  const planned = new Set(
    plan?.stages.filter((s) => s.disposition === 'IN_PROGRESS').map((s) => s.stageId),
  );
  const completed = new Set(record?.completedStages ?? []);
  const ran = new Set(record?.ranStages ?? []);
  const verdicts = new Map((record?.gateResults ?? []).map((g) => [g.gateId, g.verdict]));

  return coverage.map((c): StageView => {
    const applicable = plan === undefined || planned.has(c.stageId);
    const state: StageView['state'] = !applicable
      ? 'NOT_APPLICABLE'
      : completed.has(c.stageId)
        ? 'COMPLETE'
        : ran.has(c.stageId)
          ? 'RAN'
          : record?.haltedAtStage === c.stageId
            ? 'IN_PROGRESS'
            : 'PENDING';
    const verdict = c.gate === undefined ? undefined : verdicts.get(c.gate);
    return {
      stageId: c.stageId,
      name: c.name,
      phase: c.phase,
      ...(c.gate === undefined ? {} : { gate: c.gate }),
      state,
      ...(verdict === undefined ? {} : { verdict }),
      departments: c.departments,
    };
  });
}

function headlineFor(
  health: ProjectHealth,
  blockedReason: string | undefined,
  openDecisions: number,
): string {
  switch (health) {
    case ProjectHealth.RECOVERY_REQUIRED:
      return 'An operation ended in an unknown state. Serva will not retry it until somebody decides what happened.';
    case ProjectHealth.DIVERGENCE:
      return 'The workspace changed outside Serva. Those changes are ungoverned until they are reviewed.';
    case ProjectHealth.BLOCKED:
      return blockedReason ?? 'The lifecycle is blocked.';
    case ProjectHealth.OWNER_ACTION:
      return openDecisions === 1
        ? 'One decision is waiting for you.'
        : String(openDecisions) + ' decisions are waiting for you.';
    case ProjectHealth.UNQUALIFIED:
      return 'This machine has not been qualified, so write-capable engineering cannot run.';
    case ProjectHealth.NOT_STARTED:
      return 'The project exists and the company has not run yet.';
    default:
      return 'The company is running and nothing is waiting.';
  }
}

function nextActionFor(
  health: ProjectHealth,
  ownerActions: readonly OwnerActionView[],
  blockedReason: string | undefined,
  machineReason: string,
): string {
  switch (health) {
    case ProjectHealth.RECOVERY_REQUIRED:
      return 'Open Recovery and decide whether the interrupted operation took effect.';
    case ProjectHealth.DIVERGENCE:
      return 'Review the divergence and either reconcile it into Serva or discard it.';
    case ProjectHealth.BLOCKED:
      return 'Resolve: ' + (blockedReason ?? 'the recorded blocker') + '.';
    case ProjectHealth.OWNER_ACTION:
      return 'Answer: ' + (ownerActions[0]?.question ?? 'the open decision') + '.';
    case ProjectHealth.UNQUALIFIED:
      return 'Run the machine doctor: ' + machineReason + '.';
    case ProjectHealth.NOT_STARTED:
      return 'Start the company on this project.';
    default:
      return 'Nothing needs you. Serva will continue.';
  }
}

/** Is this directory a Serva project? The one check the extension activates on. */
export function isServaProject(dir: string): boolean {
  return existsSync(join(dir, SERVA_DIR, 'SCHEMA_VERSION'));
}
