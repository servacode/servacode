import type { OrchestratorDeps } from '../orchestration/orchestrator.js';
import { BillingMode } from '../vocab/index.js';
import { ContractRegistry } from '../agents/registry.js';
import { AgentRuntime } from '../agents/runtime.js';
import { capabilityLevelFor, CapabilityLevel } from '../agents/toolPolicy.js';
import { ClaudeCliEngineAdapter } from '../engine/claude/adapter.js';
import { Orchestrator } from '../orchestration/orchestrator.js';
import { EngineHealthState, type EngineAdapter, type EngineStatus } from '../engine/types.js';
import type { ServaRuntime } from './runtime.js';

/**
 * Wiring for the AI layer. SPEC: 19, 33 §5.
 *
 * Everything provider-specific is constructed here and nowhere else, so the rest of
 * the application depends on `EngineAdapter` rather than on Claude.
 */

/**
 * The Phase 3 enabled agent set.
 *
 * Chosen for one property: **none of them can change anything.** Each is an
 * ADVISE/RECOMMEND/DECIDE-on-process role whose contract grants no filesystem write,
 * no command execution and no network. They are enough to demonstrate the full loop —
 * a request is classified, a plan is proposed, and Serva validates and queues it —
 * without a single agent that could modify the repository.
 *
 * The other 50 contracts LOAD. They are registered, inspectable and validated; they
 * simply cannot be dispatched, and asking for one fails with a stated reason rather
 * than a quiet downgrade.
 */
export const PHASE3_ENABLED_AGENTS: ReadonlySet<string> = new Set([
  'SC-AGENT-003', // Request Classifier  - ANALYST/ADVISE, reads state, proposes a class
  'SC-AGENT-001', // Orchestrator        - GOVERNOR/DECIDE on process, proposes a plan
  'SC-AGENT-002', // Planner             - GOVERNOR/RECOMMEND, decomposes scope
  'SC-AGENT-011', // Policy Interpreter  - ANALYST/RECOMMEND, no tools at all
  'SC-AGENT-030', // Discovery Analyst   - ANALYST/RECOMMEND, problem-space findings
]);

/**
 * WHO THE PLANNER MAY ASSIGN WORK TO.
 *
 * SPEC: Phase 6 final acceptance sequence §2; 19 CX-4.
 *
 * The live cross-phase run found this. An owner asked for a defect to be fixed, the classifier
 * correctly recommended Backend, QA and Code Review, and the Orchestrator escalated:
 *
 *   No canonical agents exist for recommended departments SC-DEPT-030 (Backend),
 *   SC-DEPT-051 (QA), SC-DEPT-050 (Code Review).
 *
 * Those departments have agents — SC-AGENT-150, the QA verifiers, SC-AGENT-200. What the
 * planner was SHOWN was `PHASE3_ENABLED_AGENTS`, five intelligence agents frozen at the phase
 * that introduced them. It was asked to assign engineering work and handed a catalogue with no
 * engineer in it, so it escalated — correctly, for a gap Serva created by withholding the list.
 *
 * That is the identical failure the comment beside the DEPARTMENT catalogue already describes,
 * one stage later: an answer that must use canonical identifiers, without the identifiers in
 * the bundle.
 *
 * ASSIGNABLE IS NOT EXECUTABLE, and this is the reason the fix is safe. Naming an agent in a
 * plan grants nothing: a Producer still runs only when `enabledProducers` includes it AND the
 * substrate measured HARD AND the boundary is currently reachable. This set governs what the
 * planner may WRITE DOWN; three separate gates govern what may actually run.
 */
export const PHASE6_ENABLED_AGENTS: ReadonlySet<string> = new Set([
  ...PHASE3_ENABLED_AGENTS,
  /* The engineering departments a request about existing code will reach. */
  'SC-AGENT-150', // Backend Engineer     - SC-DEPT-030
  'SC-AGENT-160', // Frontend Engineer    - SC-DEPT-031
  'SC-AGENT-180', // Database Engineer    - SC-DEPT-033
  'SC-AGENT-200', // Code Reviewer        - SC-DEPT-050
  'SC-AGENT-210', // QA                   - SC-DEPT-051
  'SC-AGENT-220', // Security Tester      - SC-DEPT-052
]);

export interface AiLayer {
  readonly engine: EngineAdapter;
  readonly registry: ContractRegistry;
  readonly runtime: AgentRuntime;
  readonly orchestrator: Orchestrator;
  readonly enabledAgents: ReadonlySet<string>;
}

export interface AiLayerOptions {
  /** Injected in tests so no automated run can reach a real engine by accident. */
  readonly engine?: EngineAdapter;
  readonly registry?: ContractRegistry;
  readonly enabledAgents?: ReadonlySet<string>;
  readonly allowedBilling?: readonly BillingMode[];
  /**
   * Containment the CALLER has measured, passed through to plan validation.
   *
   * Never derived here. Building an engineering layer means qualifying a substrate, which is
   * expensive and belongs to the caller that already did it — and an AI layer that quietly
   * measured a boundary for itself would be asserting the very thing it is supposed to be
   * told.
   */
  readonly producerExecution?: OrchestratorDeps['producerExecution'];
}

export function buildAiLayer(rt: ServaRuntime, opts: AiLayerOptions = {}): AiLayer {
  const registry = opts.registry ?? ContractRegistry.shared();
  const enabledAgents = opts.enabledAgents ?? PHASE6_ENABLED_AGENTS;
  const engine =
    opts.engine ??
    new ClaudeCliEngineAdapter({
      clock: rt.clock,
      ...(opts.allowedBilling === undefined ? {} : { allowedBilling: opts.allowedBilling }),
    });

  const runtime = new AgentRuntime({
    store: rt.store,
    ids: rt.ids,
    clock: rt.clock,
    registry,
    engine,
    enabledAgents,
    projectRoot: rt.root,
  });

  const orchestrator = new Orchestrator({
    store: rt.store,
    ids: rt.ids,
    clock: rt.clock,
    runtime,
    registry,
    enabledAgents,
    ...(opts.producerExecution === undefined ? {} : { producerExecution: opts.producerExecution }),
  });

  return { engine, registry, runtime, orchestrator, enabledAgents };
}

export interface AgentSummary {
  readonly id: string;
  readonly name: string;
  readonly department: string;
  readonly archetype: string;
  readonly authority: string;
  readonly capabilityLevel: CapabilityLevel;
  readonly enabled: boolean;
  readonly reasonNotEnabled?: string;
}

export function summarizeAgents(layer: AiLayer): AgentSummary[] {
  return layer.registry.all().map((c) => {
    const level = capabilityLevelFor(c);
    const enabled = layer.enabledAgents.has(c.id) && level !== CapabilityLevel.NOT_ENABLED;
    const reason =
      level === CapabilityLevel.NOT_ENABLED
        ? 'requires write, execute or network capability that is not enforceable on this substrate (33 PC-5)'
        : layer.enabledAgents.has(c.id)
          ? undefined
          : 'outside the Phase 3 enabled set';
    return {
      id: c.id,
      name: c.name,
      department: c.department,
      archetype: c.archetype,
      authority: c.authorityLevel,
      capabilityLevel: level,
      enabled,
      ...(reason === undefined ? {} : { reasonNotEnabled: reason }),
    };
  });
}

/** The owner-facing AI status block (§4 of the Phase 3 brief). Carries no secret. */
export interface AiStatusView {
  readonly system: 'SERVA CODE';
  readonly aiEngine: string;
  readonly provider: string;
  readonly transport: string;
  readonly authentication: string;
  readonly billingMode: BillingMode;
  readonly version: string;
  readonly capabilityLevel: string;
  readonly governedDispatch: 'ALLOWED' | 'REFUSED';
  readonly detail?: string;
  readonly remedy?: string;
  readonly checkedAt: string;
}

export function toStatusView(status: EngineStatus): AiStatusView {
  const capable =
    status.capabilities.supportsStructuredOutput && status.capabilities.supportsToolRestriction
      ? status.capabilities.supportsAmbientConfigIsolation
        ? 'FULL'
        : 'REDUCED (ambient configuration cannot be isolated)'
      : 'INSUFFICIENT';
  return {
    system: 'SERVA CODE',
    aiEngine: status.provider === 'anthropic-claude' ? 'Claude' : status.provider,
    provider: status.provider,
    transport: status.transport,
    authentication: status.authenticated
      ? status.authenticationKind
      : 'NOT AUTHENTICATED (' + status.authenticationKind + ')',
    billingMode: status.billingMode,
    version: status.version,
    capabilityLevel: capable,
    governedDispatch: status.state === EngineHealthState.READY ? 'ALLOWED' : 'REFUSED',
    ...(status.detail === undefined ? {} : { detail: status.detail }),
    ...(status.remedy === undefined ? {} : { remedy: status.remedy }),
    checkedAt: status.checkedAt,
  };
}
