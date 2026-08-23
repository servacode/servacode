import { fail } from '../../core/errors.js';
import { ARTIFACT_TYPES } from '../repository.js';
import { RESERVED_PURPOSES } from '../artifacts/governance.js';
import type { ArtifactType } from '../repository.js';
import type { AgentContract } from '../../agents/schema.js';
import type { ContractRegistry } from '../../agents/registry.js';
import type { CanonEnvelope, Transaction } from '../../store/store.js';

/**
 * CANONICAL OUTPUT AUTHORITY, ENFORCED AT THE WRITE BOUNDARY.
 *
 * SPEC: 06, 32 §9.
 *
 * A department declares what it produces; its canonical AgentContract declares what that
 * agent is permitted to produce; and what actually reaches the Store must be inside both.
 * The chain is:
 *
 *   committed artifact types  ⊆  DepartmentConfig.produces  ⊆  AgentContract outputs
 *
 * All three links are checked, and the last one is checked BEFORE the mutation rather than
 * after it. Auditing afterwards means the violating write has already happened and the
 * best available response is to try to undo it — which works until the day it does not,
 * and which cannot help at all if the persist function committed on its own.
 *
 * So a department never receives a Transaction. It receives a `ScopedCanonWriter` that
 * knows its authorised types before the first write, refuses anything else at the call,
 * and has no `commit` on it. Overreach is not a violation that gets caught; it is an
 * operation that does not exist.
 *
 * The failure this prevents is not hypothetical. The Admin Operability department ran
 * SC-AGENT-140 alone and wrote SC-AGENT-141's canon as well; the Test Design department
 * ran SC-AGENT-210 alone and wrote SC-AGENT-211's. Both looked correct — one department,
 * one run, all the artifacts a reader expects — and both silently merged two authorities
 * that the catalogue keeps apart on purpose.
 */

/**
 * Contract output prose to canonical artifact type.
 *
 * `32` states outputs as a human list — `"AdminOperabilityReview[], ConfigurationRegister"`
 * — because contracts are written to be read. This is the one place that reading is turned
 * into a decision, so it is a table rather than a heuristic: a fuzzy match here would
 * quietly widen an authority, which is the exact thing the table exists to stop.
 */
const OUTPUT_NAMES: Readonly<Record<string, ArtifactType>> = Object.freeze({
  Idea: ARTIFACT_TYPES.IDEA,
  ClientInput: ARTIFACT_TYPES.CLIENT_INPUT,
  ProjectGoal: ARTIFACT_TYPES.PROJECT_GOAL,
  Constraint: ARTIFACT_TYPES.CONSTRAINT,
  Assumption: ARTIFACT_TYPES.ASSUMPTION,
  OpenQuestion: ARTIFACT_TYPES.OPEN_QUESTION,
  UserSegment: ARTIFACT_TYPES.USER_SEGMENT,
  JobToBeDone: ARTIFACT_TYPES.JOB_TO_BE_DONE,
  CurrentAlternative: ARTIFACT_TYPES.CURRENT_ALTERNATIVE,
  Pain: ARTIFACT_TYPES.PAIN,
  DiscoveryFindings: ARTIFACT_TYPES.DISCOVERY_FINDINGS,
  ValidationRecommendation: ARTIFACT_TYPES.VALIDATION_RECOMMENDATION,
  ProductScope: ARTIFACT_TYPES.PRODUCT_SCOPE,
  Feature: ARTIFACT_TYPES.FEATURE,
  Actor: ARTIFACT_TYPES.ACTOR,
  Role: ARTIFACT_TYPES.ROLE,
  BusinessRule: ARTIFACT_TYPES.BUSINESS_RULE,
  BusinessProcess: ARTIFACT_TYPES.PROCESS_MODEL,
  StateMachine: ARTIFACT_TYPES.STATE_MACHINE,
  GlossaryTerm: ARTIFACT_TYPES.GLOSSARY,
  FinancialLogic: ARTIFACT_TYPES.FINANCIAL_LOGIC,
  Requirement: ARTIFACT_TYPES.REQUIREMENT,
  AcceptanceCriterion: ARTIFACT_TYPES.ACCEPTANCE_CRITERION,
  NFR: ARTIFACT_TYPES.NFR,
  RequirementBaseline: ARTIFACT_TYPES.REQUIREMENT_BASELINE,
  ResearchRequest: ARTIFACT_TYPES.RESEARCH_REQUEST,
  SourceCapture: ARTIFACT_TYPES.SOURCE_CAPTURE,
  ResearchFinding: ARTIFACT_TYPES.RESEARCH_FINDING,
  ClaimVerification: ARTIFACT_TYPES.CLAIM_VERIFICATION,
  CompetitorProfile: ARTIFACT_TYPES.COMPETITOR_PROFILE,
  TableStakes: ARTIFACT_TYPES.TABLE_STAKES,
  MarketGap: ARTIFACT_TYPES.MARKET_GAP,
  Differentiator: ARTIFACT_TYPES.DIFFERENTIATOR,
  CompetitivePosition: ARTIFACT_TYPES.COMPETITIVE_POSITION,
  ArchitectureModel: ARTIFACT_TYPES.ARCHITECTURE_MODEL,
  Module: ARTIFACT_TYPES.MODULE_CONTRACT,
  SsotMap: ARTIFACT_TYPES.SSOT_REGISTER,
  ComplexityJustification: ARTIFACT_TYPES.COMPLEXITY_JUSTIFICATION,
  NfrMapping: ARTIFACT_TYPES.NFR_MAPPING,
  TechnologyEvaluation: ARTIFACT_TYPES.TECHNOLOGY_EVALUATION,
  ADR: ARTIFACT_TYPES.ADR,
  DataModel: ARTIFACT_TYPES.DATA_MODEL,
  DataOwnership: ARTIFACT_TYPES.ENTITY_OWNERSHIP,
  RetentionPolicy: ARTIFACT_TYPES.RETENTION_POLICY,
  ThreatModel: ARTIFACT_TYPES.THREAT_MODEL,
  AuthorizationModel: ARTIFACT_TYPES.AUTHORIZATION_MODEL,
  PrivacyDesign: ARTIFACT_TYPES.PRIVACY_DESIGN,
  ResidualRisk: ARTIFACT_TYPES.RESIDUAL_RISK,
  InfrastructureDesign: ARTIFACT_TYPES.ENVIRONMENT_MODEL,
  EnvironmentSpec: ARTIFACT_TYPES.ENVIRONMENT_MODEL,
  CostModel: ARTIFACT_TYPES.COST_MODEL,
  CostAssessment: ARTIFACT_TYPES.COST_ASSESSMENT,
  Flow: ARTIFACT_TYPES.FLOW,
  Screen: ARTIFACT_TYPES.SCREEN_COMPOSITION,
  StateCoverage: ARTIFACT_TYPES.STATE_COVERAGE,
  AccessibilitySpec: ARTIFACT_TYPES.ACCESSIBILITY_SPEC,
  DesignTokenSet: ARTIFACT_TYPES.DESIGN_TOKEN_SET,
  ComponentSpec: ARTIFACT_TYPES.COMPONENT_SPEC,
  LayoutSystem: ARTIFACT_TYPES.LAYOUT_SYSTEM,
  RTLRules: ARTIFACT_TYPES.RTL_RULES,
  MotionSpec: ARTIFACT_TYPES.MOTION_SPEC,
  DesignDecision: ARTIFACT_TYPES.DESIGN_DECISION,
  /*
   * SC-AGENT-020's contract has always said `ProductDecision[]`, and this table did not
   * map it — so the Product Manager's own decision family resolved to nothing, and the
   * one artifact that records what the product authority DECIDED could not be written by
   * the authority that decides it. The typed proposal ruling had a shape and no path.
   */
  ProductDecision: ARTIFACT_TYPES.PRODUCT_DECISION,
  DesignException: ARTIFACT_TYPES.DESIGN_EXCEPTION,
  ScreenComposition: ARTIFACT_TYPES.SCREEN_COMPOSITION,
  AdminOperabilityReview: ARTIFACT_TYPES.ADMIN_OPERABILITY_REVIEW,
  ConfigurationRegister: ARTIFACT_TYPES.CONFIGURATION_REGISTER,
  ProtectedRule: ARTIFACT_TYPES.PROTECTED_RULE,
  AdminAuditRequirement: ARTIFACT_TYPES.ADMIN_AUDIT_REQUIREMENT,
  AdminIA: ARTIFACT_TYPES.ADMIN_IA,
  OperationalControl: ARTIFACT_TYPES.OPERATIONAL_CONTROL,
  TestStrategy: ARTIFACT_TYPES.TEST_STRATEGY,
  TestCase: ARTIFACT_TYPES.TEST_CASE,
  Risk: ARTIFACT_TYPES.RISK,
  Proposal: ARTIFACT_TYPES.PROPOSAL,
  ImpactAnalysis: ARTIFACT_TYPES.IMPACT_ANALYSIS,
  ChangeRequest: ARTIFACT_TYPES.CHANGE_REQUEST,
  OwnerDecisionRequest: ARTIFACT_TYPES.OWNER_DECISION_REQUEST,
  LessonLearned: ARTIFACT_TYPES.LESSON_LEARNED,
  ReusablePattern: ARTIFACT_TYPES.REUSABLE_PATTERN,
  FailedApproach: ARTIFACT_TYPES.FAILED_APPROACH,
  ApplicabilityAssessment: ARTIFACT_TYPES.APPLICABILITY_ASSESSMENT,
  ProcessModel: ARTIFACT_TYPES.PROCESS_MODEL,
  Glossary: ARTIFACT_TYPES.GLOSSARY,
  ModuleContract: ARTIFACT_TYPES.MODULE_CONTRACT,
  SSOTRegister: ARTIFACT_TYPES.SSOT_REGISTER,
  NFRMapping: ARTIFACT_TYPES.NFR_MAPPING,
  EntityOwnership: ARTIFACT_TYPES.ENTITY_OWNERSHIP,
  DataClassification: ARTIFACT_TYPES.DATA_CLASSIFICATION,
  MigrationStrategy: ARTIFACT_TYPES.MIGRATION_STRATEGY,
  TrustBoundary: ARTIFACT_TYPES.TRUST_BOUNDARY,
  AbuseCase: ARTIFACT_TYPES.ABUSE_CASE,
  AuthDesign: ARTIFACT_TYPES.AUTH_DESIGN,
  SecretsDesign: ARTIFACT_TYPES.SECRETS_DESIGN,
  SecurityNFR: ARTIFACT_TYPES.SECURITY_NFR,
  EnvironmentModel: ARTIFACT_TYPES.ENVIRONMENT_MODEL,
  DeploymentStrategy: ARTIFACT_TYPES.DEPLOYMENT_STRATEGY,
  ConfigurationDelivery: ARTIFACT_TYPES.CONFIGURATION_DELIVERY,
  ObservabilitySpec: ARTIFACT_TYPES.OBSERVABILITY_SPEC,
  BackupSpec: ARTIFACT_TYPES.BACKUP_SPEC,
  RollbackSpec: ARTIFACT_TYPES.ROLLBACK_SPEC,
  UserJourney: ARTIFACT_TYPES.USER_JOURNEY,
  InformationArchitecture: ARTIFACT_TYPES.INFORMATION_ARCHITECTURE,
  NavigationModel: ARTIFACT_TYPES.NAVIGATION_MODEL,
  /* 32 states 063's verdict in its own words; the family that records it is this one. */
  SourceVerificationVerdict: ARTIFACT_TYPES.CLAIM_VERIFICATION,
  /* 131's contract states its outputs in prose rather than in type names. */
  'screen compositions': ARTIFACT_TYPES.SCREEN_COMPOSITION,
  'layout specifications': ARTIFACT_TYPES.LAYOUT_SYSTEM,
  CandidateItem: ARTIFACT_TYPES.CANDIDATE_ITEM,

  /* ------------------------------------------------ downstream quality (Phase 6) */
  QAVerdict: ARTIFACT_TYPES.QA_VERDICT,
  Defect: ARTIFACT_TYPES.DEFECT,
  AccessibilityVerdict: ARTIFACT_TYPES.ACCESSIBILITY_VERDICT,
  SecurityVerdict: ARTIFACT_TYPES.SECURITY_VERDICT,
  SecurityFinding: ARTIFACT_TYPES.SECURITY_FINDING,
  PerformanceVerdict: ARTIFACT_TYPES.PERFORMANCE_VERDICT,
  /*
   * SC-AGENT-240's contract states its output as prose — "AcceptanceVerdict with
   * qualifications" — and the qualification is part of the artifact rather than a second
   * output. Mapped literally rather than by loosening the parser, which would quietly
   * widen every authority that happens to have a trailing clause.
   */
  'AcceptanceVerdict with qualifications': ARTIFACT_TYPES.ACCEPTANCE_VERDICT,

  /* -------------------------------------------- release and operations (Phase 6) */
  Release: ARTIFACT_TYPES.RELEASE,
  ReleaseRecommendation: ARTIFACT_TYPES.RELEASE_RECOMMENDATION,
  HandoverPackage: ARTIFACT_TYPES.HANDOVER_PACKAGE,
  Runbook: ARTIFACT_TYPES.RUNBOOK,
  OperationalReadinessVerdict: ARTIFACT_TYPES.OPERATIONAL_READINESS_VERDICT,

  /* ------------------------------------------------------ incidents (Phase 6) */
  Incident: ARTIFACT_TYPES.INCIDENT,
  /*
   * SC-AGENT-271 states its second output as "corrective action Proposal[]". The parser
   * strips the array marker and then the trailing qualifier — which exists for phrasings
   * like "CompetitorProfile[] raw" — and here the qualifier IS the type name, leaving
   * "corrective action". Mapped literally rather than by loosening the strip, which would
   * quietly change how every other contract's outputs resolve.
   */
  'corrective action': ARTIFACT_TYPES.PROPOSAL,
  PostIncidentReview: ARTIFACT_TYPES.POST_INCIDENT_REVIEW,
});

/**
 * Artifacts ANY governed department may write, whatever its contract says.
 *
 * Two of them, both structural rather than editorial. An owner decision is Serva's own
 * escalation mechanism — every department must be able to stop and ask, or the authority
 * boundary has a hole in it — and an assumption is the promotion `provenanceRefusal`
 * demands before a load-bearing inference may be stored at all. Neither is content a
 * department chooses to produce; both are the governance working.
 */
const UNIVERSAL: readonly ArtifactType[] = Object.freeze([
  ARTIFACT_TYPES.OWNER_DECISION_REQUEST,
  ARTIFACT_TYPES.ASSUMPTION,
  /*
   * An OpenQuestion is the record of something a run could not settle, and of who owes the
   * answer. Like an owner decision it is governance rather than departmental output: a
   * department that could not record one could not hand its question to anybody, and the
   * question would exist only in a log.
   */
  ARTIFACT_TYPES.OPEN_QUESTION,
  /*
   * A ResearchRequest is a DECLARATION of intent to retrieve, not retrieval. Recording one
   * grants nothing: the gateway still checks the canonical contract before a single byte
   * leaves, and a department with no network scope that records a request has recorded a
   * request somebody else will have to fulfil.
   */
  ARTIFACT_TYPES.RESEARCH_REQUEST,
]);

export interface ContractOutputs {
  /** Output names that resolve to a canonical artifact family. */
  readonly types: readonly ArtifactType[];
  /**
   * Output names that do not.
   *
   * Kept rather than dropped. A contract saying it produces "admin flow specifications"
   * is describing something real that Serva has no artifact family for, and recording
   * that is how the gap stays visible instead of looking like an authority nobody has.
   */
  readonly unresolved: readonly string[];
}

/** What this contract is canonically permitted to produce. */
export function contractOutputTypes(contract: AgentContract): ContractOutputs {
  const types: ArtifactType[] = [...UNIVERSAL];
  const unresolved: string[] = [];

  for (const raw of String(contract.outputs ?? '').split(',')) {
    /*
     * `32` writes outputs for people: "CompetitorProfile[] raw", "ThreatModel (with
     * mandatory privacy section)". The array marker, a parenthetical and a trailing
     * qualifier are all commentary on the same family, so they are stripped — but only
     * those, and only from the end. Anything left that does not match the table is
     * reported as unresolved rather than guessed at.
     */
    const name = raw
      .trim()
      .replace(/\(.*?\)/g, '')
      .replace(/\[\]/g, '')
      .replace(/\s+(raw|proposal)$/i, '')
      .trim();
    if (name === '') continue;
    const type = OUTPUT_NAMES[name];
    if (type === undefined) unresolved.push(name);
    else if (!types.includes(type)) types.push(type);
  }
  return { types, unresolved };
}

/**
 * A canonical writer that cannot write outside its authority.
 *
 * Deliberately NOT a Transaction. It has no `commit` and no `rollback`, so a department
 * cannot end the transaction the runner owns, and it exposes only the operations a
 * department legitimately needs. The authorised set is fixed at construction, before the
 * persist function has run a single line.
 */
export class ScopedCanonWriter {
  private readonly attempted = new Set<string>();

  constructor(
    private readonly tx: Transaction,
    private readonly agentId: string,
    private readonly departmentId: string,
    private readonly allowed: ReadonlySet<string>,
  ) {}

  /** Types this writer actually wrote, for the ledger and the evidence record. */
  written(): readonly string[] {
    return [...this.attempted];
  }

  canonHeadVersion(type: string, id: string): number {
    return this.tx.canonHeadVersion(type, id);
  }

  getCanon<T>(type: string, id: string): CanonEnvelope<T> | undefined {
    return this.tx.getCanon<T>(type, id);
  }

  putCanon<T>(
    type: string,
    id: string,
    body: T,
    opts?: { supersedes?: string; source?: string },
  ): CanonEnvelope<T> {
    if (!this.allowed.has(type)) {
      /*
       * REFUSED BEFORE THE WRITE IS STAGED. Nothing reaches the transaction, so there is
       * no partial state to unwind and no window in which the artifact briefly existed.
       */
      return fail({
        code: 'E_GATE_AUTHORITY',
        message:
          this.departmentId +
          ' (running as ' +
          this.agentId +
          ') attempted to write ' +
          type +
          ', which is not among its canonical outputs',
        remedy:
          'An artifact belongs to the agent whose contract declares it. If ' +
          this.agentId +
          ' genuinely produces this, the contract in 32 says so and the department should declare it; if another agent produces it, that agent needs its own governed run.',
        details: {
          departmentId: this.departmentId,
          agentId: this.agentId,
          attempted: type,
          allowed: [...this.allowed].sort(),
        },
        specRef: '06',
      });
    }
    /*
     * RESERVED APPROVAL PURPOSES.
     *
     * An owner decision is universal — every department must be able to stop and ask — but
     * the FORM of consent is not. A decision whose purpose is CHANGE_APPROVAL or
     * PROPOSAL_APPROVAL is the artifact that `approveChange` and `accept` later read as
     * authorisation, so a department able to construct one could write its own approval,
     * wait for anybody at all to answer it, and hand the result to the function that
     * authorises the thing it wanted.
     *
     * Checked here rather than in each department for the same reason as everything else
     * on this boundary: the departments that would most benefit from minting one are
     * exactly the ones whose authors would find the check most inconvenient.
     */
    if (type === ARTIFACT_TYPES.OWNER_DECISION_REQUEST) {
      const purpose = (body as { purpose?: string } | undefined)?.purpose;
      if (purpose !== undefined && (RESERVED_PURPOSES as readonly string[]).includes(purpose)) {
        return fail({
          code: 'E_GATE_AUTHORITY',
          message:
            this.departmentId +
            ' (running as ' +
            this.agentId +
            ') attempted to raise a ' +
            purpose +
            ' decision',
          remedy:
            'A department may ask the owner anything within its scope, but it may not mint the FORM of consent that later authorises a change or a proposal. Those are raised by Serva\u2019s own authority functions.',
          details: { departmentId: this.departmentId, agentId: this.agentId, purpose },
          specRef: '§32',
        });
      }
    }

    this.attempted.add(type);
    return this.tx.putCanon<T>(type, id, body, opts);
  }

  appendTrace(...args: Parameters<Transaction['appendTrace']>): void {
    this.tx.appendTrace(...args);
  }
}

/**
 * What a department is allowed to write: its declaration, intersected with its contract.
 *
 * Returns the refusal rather than throwing, so `validateDepartmentAuthority` can report
 * every misconfiguration at once instead of one per run.
 */
export interface AuthorityConfig {
  readonly id: string;
  readonly agentId: string;
  readonly produces?: readonly string[];
  readonly producesBeyondContract?: readonly {
    readonly type: string;
    readonly why: string;
  }[];
}

export function authorityRefusal(
  config: AuthorityConfig,
  registry: ContractRegistry,
): string | undefined {
  let contract: AgentContract;
  try {
    contract = registry.get(config.agentId);
  } catch {
    return config.id + ' names ' + config.agentId + ', which is not a canonical agent';
  }

  const declared = config.produces;
  if (declared === undefined) {
    return (
      config.id +
      ' declares no outputs. A department that does not say what it produces cannot be constrained, and an unconstrained writer is the defect this check exists to prevent.'
    );
  }

  const permitted = contractOutputTypes(contract);
  const known = new Set<string>(Object.values(ARTIFACT_TYPES));
  const unknown = declared.filter((t) => !known.has(t));
  if (unknown.length > 0) {
    return config.id + ' declares unknown artifact type(s): ' + unknown.join(', ');
  }

  const excepted = new Map((config.producesBeyondContract ?? []).map((e) => [e.type, e.why]));
  for (const [type, why] of excepted) {
    if (!known.has(type)) {
      return config.id + ' declares an unknown artifact type as an exception: ' + type;
    }
    if (why.trim().length < 20) {
      return (
        config.id +
        ' claims ' +
        type +
        ' beyond its contract without saying why. An exception nobody justified is indistinguishable from an oversight.'
      );
    }
    if (permitted.types.includes(type as ArtifactType)) {
      return (
        config.id +
        ' lists ' +
        type +
        ' as beyond-contract, but ' +
        config.agentId +
        ' is canonically authorised to produce it. Declare it in `produces`.'
      );
    }
  }

  const beyond = declared.filter(
    (t) => !permitted.types.includes(t as ArtifactType) && !excepted.has(t),
  );
  if (beyond.length > 0) {
    return (
      config.id +
      ' declares ' +
      beyond.join(', ') +
      ', which ' +
      config.agentId +
      ' is not canonically authorised to produce (its contract says: ' +
      (contract.outputs ?? '(nothing)') +
      ')'
    );
  }
  return undefined;
}

/** The authorised write set for a department, ready for a ScopedCanonWriter. */
export function allowedTypesFor(
  config: AuthorityConfig,
  registry: ContractRegistry,
): ReadonlySet<string> {
  const contractTypes = contractOutputTypes(registry.get(config.agentId)).types;
  const declared = config.produces ?? [];
  /*
   * The intersection, not the union: both the declaration and the contract must permit a
   * type. UNIVERSAL is added on top because those two families are not departmental
   * output at all — they are the governance itself. A department that could not raise an
   * owner decision could not stop and ask, which would put the authority boundary behind
   * a declaration that somebody has to remember to write.
   */
  return new Set([
    ...declared.filter((t) => contractTypes.includes(t as ArtifactType)),
    /* Documented R4 gaps, each with a stated reason and enumerated by a catalogue test. */
    ...(config.producesBeyondContract ?? []).map((e) => e.type),
    ...UNIVERSAL,
  ]);
}

/**
 * Validate every registered department against its contract, before anything runs.
 *
 * Called at orchestrator construction so a misconfiguration is a startup failure naming
 * the department, rather than a refusal discovered halfway through a paid run.
 */
export function validateDepartmentAuthority(
  configs: readonly {
    readonly id: string;
    readonly agentId: string;
    readonly produces?: readonly string[];
  }[],
  registry: ContractRegistry,
): void {
  const refusals = configs
    .map((c) => authorityRefusal(c, registry))
    .filter((r): r is string => r !== undefined);
  if (refusals.length === 0) return;

  fail({
    code: 'E_CONFIG',
    message: 'Department output authority is misconfigured: ' + refusals.join('; '),
    remedy:
      'Every department must declare `produces`, and everything it declares must be inside its agent’s canonical outputs. Where two agents own different artifacts, they need two governed runs rather than one department writing both.',
    details: { refusals },
    specRef: '06',
  });
}

export { OUTPUT_NAMES, UNIVERSAL };
