import { z } from 'zod';
import { fail } from '../core/errors.js';
import { AuditAction, audit } from '../events/audit.js';
import { provenanceRefusal } from './provenance.js';
import type { Store, Transaction } from '../store/store.js';
import type { IntelligenceMeta } from './provenance.js';

/**
 * PERSISTENCE FOR COMPANY INTELLIGENCE.
 *
 * SPEC: 08 §2 (durability tiers), 08 §3, SC-POL-005.
 *
 * Intelligence is CANON: versioned, append-only, never edited in place. A refresh writes
 * version n+1 and leaves version n exactly as it was, so a decision taken in March still
 * points at the market as it was understood in March. Overwriting would make every past
 * rationale silently refer to today's facts — which reads as consistency and is actually
 * the loss of the audit trail.
 *
 * The repository is generic over the schema on purpose. Seventeen artifact families with
 * seventeen bespoke repositories would be seventeen places for the provenance check to be
 * forgotten; here it is enforced once, at the single write path.
 */

export interface ArtifactRecord {
  readonly id: string;
  readonly version: number;
  readonly meta: IntelligenceMeta;
}

/** Canon type names. One per family member, so listing is cheap and typos are visible. */
export const ARTIFACT_TYPES = {
  IDEA: 'intel.idea',
  CLIENT_INPUT: 'intel.clientInput',
  PROJECT_GOAL: 'intel.projectGoal',
  CONSTRAINT: 'intel.constraint',
  ASSUMPTION: 'intel.assumption',
  OPEN_QUESTION: 'intel.openQuestion',

  USER_SEGMENT: 'intel.userSegment',
  JOB_TO_BE_DONE: 'intel.jobToBeDone',
  CURRENT_ALTERNATIVE: 'intel.currentAlternative',
  PAIN: 'intel.pain',
  DISCOVERY_FINDINGS: 'intel.discoveryFindings',

  PRODUCT_SCOPE: 'intel.productScope',
  FEATURE: 'intel.feature',
  ROADMAP: 'intel.roadmap',
  VALIDATION_RECOMMENDATION: 'intel.validationRecommendation',
  PRODUCT_DECISION: 'intel.productDecision',

  RESEARCH_FINDING: 'intel.researchFinding',
  RESEARCH_UNAVAILABLE: 'intel.researchUnavailable',
  COMPETITOR_PROFILE: 'intel.competitorProfile',
  FEATURE_COMPARISON: 'intel.featureComparison',
  TABLE_STAKES: 'intel.tableStakes',
  MARKET_GAP: 'intel.marketGap',
  DIFFERENTIATOR: 'intel.differentiator',
  COMPETITIVE_POSITION: 'intel.competitivePosition',
  SOURCE_CAPTURE: 'intel.sourceCapture',
  RESEARCH_REQUEST: 'intel.researchRequest',
  CLAIM_VERIFICATION: 'intel.claimVerification',

  ACTOR: 'intel.actor',
  ROLE: 'intel.role',
  BUSINESS_RULE: 'intel.businessRule',
  PROCESS_MODEL: 'intel.processModel',
  STATE_MACHINE: 'intel.stateMachine',
  GLOSSARY: 'intel.glossary',
  FINANCIAL_LOGIC: 'intel.financialLogic',
  RULE_CONTRADICTION: 'intel.ruleContradiction',

  REQUIREMENT: 'intel.requirement',
  ACCEPTANCE_CRITERION: 'intel.acceptanceCriterion',
  NFR: 'intel.nfr',
  REQUIREMENT_BASELINE: 'intel.requirementBaseline',
  TRACEABILITY_LINK: 'intel.traceabilityLink',

  ARCHITECTURE_MODEL: 'intel.architectureModel',
  MODULE_CONTRACT: 'intel.moduleContract',
  SSOT_REGISTER: 'intel.ssotRegister',
  COMPLEXITY_JUSTIFICATION: 'intel.complexityJustification',
  NFR_MAPPING: 'intel.nfrMapping',
  TECHNOLOGY_EVALUATION: 'intel.technologyEvaluation',
  ADR: 'intel.adr',

  DATA_MODEL: 'intel.dataModel',
  DATA_CLASSIFICATION: 'intel.dataClassification',
  RETENTION_POLICY: 'intel.retentionPolicy',
  CONSISTENCY_MODEL: 'intel.consistencyModel',
  MIGRATION_STRATEGY: 'intel.migrationStrategy',
  ENTITY_OWNERSHIP: 'intel.entityOwnership',

  THREAT_MODEL: 'intel.threatModel',
  TRUST_BOUNDARY: 'intel.trustBoundary',
  ABUSE_CASE: 'intel.abuseCase',
  AUTH_DESIGN: 'intel.authDesign',
  AUTHORIZATION_MODEL: 'intel.authorizationModel',
  SECRETS_DESIGN: 'intel.secretsDesign',
  PRIVACY_DESIGN: 'intel.privacyDesign',
  SECURITY_NFR: 'intel.securityNfr',
  RESIDUAL_RISK: 'intel.residualRisk',

  ENVIRONMENT_MODEL: 'intel.environmentModel',
  DEPLOYMENT_STRATEGY: 'intel.deploymentStrategy',
  CONFIGURATION_DELIVERY: 'intel.configurationDelivery',
  OBSERVABILITY_SPEC: 'intel.observabilitySpec',
  BACKUP_SPEC: 'intel.backupSpec',
  ROLLBACK_SPEC: 'intel.rollbackSpec',

  COST_MODEL: 'intel.costModel',
  COST_ASSESSMENT: 'intel.costAssessment',
  LICENSING_ASSESSMENT: 'intel.licensingAssessment',
  LOCK_IN_ASSESSMENT: 'intel.lockInAssessment',
  BUDGET_STATE: 'intel.budgetState',

  USER_JOURNEY: 'intel.userJourney',
  FLOW: 'intel.flow',
  INFORMATION_ARCHITECTURE: 'intel.informationArchitecture',
  NAVIGATION_MODEL: 'intel.navigationModel',
  STATE_COVERAGE: 'intel.stateCoverage',
  CONTENT_STRATEGY: 'intel.contentStrategy',
  USABILITY_CRITERIA: 'intel.usabilityCriteria',

  DESIGN_TOKEN_SET: 'intel.designTokenSet',
  COMPONENT_SPEC: 'intel.componentSpec',
  LAYOUT_SYSTEM: 'intel.layoutSystem',
  RTL_RULES: 'intel.rtlRules',
  ACCESSIBILITY_SPEC: 'intel.accessibilitySpec',
  MOTION_SPEC: 'intel.motionSpec',
  DESIGN_DECISION: 'intel.designDecision',
  DESIGN_EXCEPTION: 'intel.designException',
  SCREEN_COMPOSITION: 'intel.screenComposition',

  ADMIN_OPERABILITY_REVIEW: 'intel.adminOperabilityReview',
  CONFIGURATION_REGISTER: 'intel.configurationRegister',
  PROTECTED_RULE: 'intel.protectedRule',
  ADMIN_AUDIT_REQUIREMENT: 'intel.adminAuditRequirement',
  ADMIN_IA: 'intel.adminIa',
  OPERATIONAL_CONTROL: 'intel.operationalControl',

  TEST_STRATEGY: 'intel.testStrategy',
  TEST_CASE: 'intel.testCase',
  TEST_DATA_STRATEGY: 'intel.testDataStrategy',
  TEST_COVERAGE_REPORT: 'intel.testCoverageReport',

  PROPOSAL: 'intel.proposal',
  RISK: 'intel.risk',
  IMPACT_ANALYSIS: 'intel.impactAnalysis',
  CHANGE_REQUEST: 'intel.changeRequest',
  OWNER_DECISION_REQUEST: 'intel.ownerDecisionRequest',
  READINESS_PACKAGE: 'intel.readinessPackage',

  LESSON_LEARNED: 'intel.lessonLearned',
  REUSABLE_PATTERN: 'intel.reusablePattern',
  FAILED_APPROACH: 'intel.failedApproach',
  APPLICABILITY_ASSESSMENT: 'intel.applicabilityAssessment',
  CANDIDATE_ITEM: 'intel.candidateItem',
} as const;
export type ArtifactType = (typeof ARTIFACT_TYPES)[keyof typeof ARTIFACT_TYPES];

/**
 * A typed view over one artifact family.
 *
 * `put` validates against the schema AND against the provenance invariant. Both matter:
 * the schema catches a malformed artifact, the provenance check catches a well-formed one
 * that launders a guess into a fact.
 */
export class ArtifactRepository<S extends z.ZodTypeAny> {
  constructor(
    private readonly store: Store,
    readonly type: ArtifactType,
    private readonly schema: S,
  ) {}

  /**
   * Write a new version.
   *
   * The version is assigned HERE from what is already stored rather than trusted from the
   * caller. An agent that computes its own version number will eventually compute one that
   * overwrites a record somebody is still relying on.
   */
  put(tx: Transaction, value: z.input<S>): z.output<S> {
    const parsed = this.schema.safeParse(value);
    if (!parsed.success) {
      return fail({
        code: 'E_VALIDATION',
        message: 'Invalid ' + this.type + ': ' + parsed.error.issues[0]?.message,
        remedy:
          'Intelligence artifacts are strict by design — an incomplete artifact is refused rather than stored half-formed.',
        details: { type: this.type, issues: parsed.error.issues.slice(0, 5) },
        specRef: '08 §3',
      });
    }
    const record = parsed.data as z.output<S> & ArtifactRecord;

    const refusal = provenanceRefusal(record.meta.provenance);
    if (refusal !== undefined) {
      return fail({
        code: 'E_VALIDATION',
        message: 'Refusing to store ' + record.id + ': ' + refusal,
        remedy:
          'Every intelligence fact carries where it came from. Promote the inference to an Assumption, or cite the source.',
        details: { type: this.type, id: record.id },
        specRef: '08 §4',
      });
    }

    const existing = this.store.listCanonVersions(this.type, record.id);
    const nextVersion = existing.length === 0 ? 1 : Math.max(...existing) + 1;
    const stored = { ...record, version: nextVersion } as z.output<S>;

    tx.putCanon(this.type, record.id, stored);
    audit(tx, {
      action: AuditAction.ARTIFACT_RECORDED,
      subject: record.id,
      outcome: 'OK',
      detail: { type: this.type, version: nextVersion },
    });
    return stored;
  }

  /** The current version, or a specific one when a decision pinned it. */
  get(id: string, version?: number): z.output<S> | undefined {
    const env =
      version === undefined
        ? this.store.getCanon<unknown>(this.type, id)
        : this.store.getCanon<unknown>(this.type, id, version);
    if (env === undefined) return undefined;
    const parsed = this.schema.safeParse(env.body);
    return parsed.success ? (parsed.data as z.output<S>) : undefined;
  }

  list(): readonly z.output<S>[] {
    const out: z.output<S>[] = [];
    for (const id of this.store.listCanonIds(this.type)) {
      const v = this.get(id);
      if (v !== undefined) out.push(v);
    }
    return out;
  }

  ids(): readonly string[] {
    return this.store.listCanonIds(this.type);
  }

  versions(id: string): readonly number[] {
    return this.store.listCanonVersions(this.type, id);
  }
}

export function repository<S extends z.ZodTypeAny>(
  store: Store,
  type: ArtifactType,
  schema: S,
): ArtifactRepository<S> {
  return new ArtifactRepository(store, type, schema);
}
