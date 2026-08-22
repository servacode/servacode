import { ARTIFACT_TYPES, repository } from './repository.js';
import { FeatureSchema } from './artifacts/product.js';
import {
  AcceptanceCriterionSchema,
  NfrSchema,
  RequirementSchema,
} from './artifacts/requirements.js';
import { BusinessRuleSchema } from './artifacts/business.js';
import { AdrSchema, ArchitectureModelSchema } from './artifacts/architecture.js';
import { AdminOperabilityReviewSchema } from './artifacts/admin.js';
import { FlowSchema } from './artifacts/ux.js';
import { ScreenCompositionSchema } from './artifacts/design.js';
import { TestCaseSchema } from './artifacts/testing.js';
import { ThreatModelSchema } from './artifacts/security.js';
import { fail } from '../core/errors.js';
import { isReady } from './readiness.js';
import type { ReadinessAssessment } from './readiness.js';
import type { Store } from '../store/store.js';

/**
 * PHASE 5 → PHASE 4.
 *
 * SPEC: §11 (of this instruction), §36.
 *
 * Engineering receives DECISIONS, not latitude. Every work item generated here carries
 * the requirement it satisfies, the acceptance criteria that verify it, the business
 * rules it must obey, the architecture it must fit, the design refs it must use and the
 * operability obligations it must meet — all as references into accepted canon.
 *
 * The direction of the contract matters and is stated plainly: Phase 5 satisfies the
 * factory, the factory does not accommodate Phase 5. Nothing in Phase 4's authority
 * semantics is touched to make this output fit. If a work item Serva generates would be
 * refused by `recordWorkItem`, that is Phase 5's defect to fix.
 *
 * An engineer who finds a specification gap ESCALATES. The `scopeBoundary` carried on
 * every item says so, because the alternative — filling it in — means the company
 * discovers its own policy later by reading the code.
 */

/** The shape Phase 4's `EngineeringFactory.recordWorkItem` accepts. */
export interface GeneratedWorkItem {
  readonly workItemId: string;
  readonly title: string;
  readonly requirements: readonly string[];
  readonly acceptanceCriteria: readonly string[];
  readonly decisions: readonly string[];
  readonly allowedScope: readonly string[];
  readonly forbiddenScope: readonly string[];
  readonly producerAgentId: string;
  readonly reviewerAgentId: string;
  readonly recipes: readonly string[];
  readonly magnitude: string;
  readonly baseCommit: string;
  readonly expectedOutputs: readonly string[];
  readonly maxAttempts: number;
}

export interface HandoffInput {
  readonly store: Store;
  readonly readiness: ReadinessAssessment;
  readonly baseCommit: string;
  readonly producerAgentId?: string;
  readonly reviewerAgentId?: string;
  readonly recipes?: readonly string[];
  /** Scope roots implementation may write to. Narrow by default. */
  readonly allowedScope?: readonly string[];
}

export interface Handoff {
  readonly items: readonly GeneratedWorkItem[];
  /** Why an item could not be generated for a feature. Reported, never skipped quietly. */
  readonly skipped: readonly { readonly feature: string; readonly reason: string }[];
}

/**
 * Generate work items from accepted canon.
 *
 * Refuses outright unless readiness is READY. That is the whole point of §10: a package
 * that is NOT_READY has a list of specific blockers, and generating work anyway would
 * hand an engineer a specification the company already knows is incomplete.
 */
export function generateWorkItems(input: HandoffInput): Handoff {
  if (!isReady(input.readiness)) {
    return fail({
      code: 'E_CAPABILITY_NOT_ENABLED',
      message:
        'Engineering work cannot be generated: readiness is ' +
        input.readiness.status +
        ' with ' +
        String(input.readiness.blockers.length) +
        ' blocker(s)',
      remedy:
        'READY is derived from accepted canon. Resolve the blockers — they are listed on the readiness package — rather than proceeding on an incomplete specification.',
      details: { blockers: input.readiness.blockers.slice(0, 10) },
      specRef: 'Phase 5 §35',
    });
  }

  const { store } = input;
  const features = repository(store, ARTIFACT_TYPES.FEATURE, FeatureSchema).list();
  const requirements = repository(store, ARTIFACT_TYPES.REQUIREMENT, RequirementSchema).list();
  const acceptance = repository(
    store,
    ARTIFACT_TYPES.ACCEPTANCE_CRITERION,
    AcceptanceCriterionSchema,
  ).list();
  const nfrs = repository(store, ARTIFACT_TYPES.NFR, NfrSchema).list();
  const rules = repository(store, ARTIFACT_TYPES.BUSINESS_RULE, BusinessRuleSchema).list();
  const architecture = repository(
    store,
    ARTIFACT_TYPES.ARCHITECTURE_MODEL,
    ArchitectureModelSchema,
  ).list();
  const adrs = repository(store, ARTIFACT_TYPES.ADR, AdrSchema).list();
  const reviews = repository(
    store,
    ARTIFACT_TYPES.ADMIN_OPERABILITY_REVIEW,
    AdminOperabilityReviewSchema,
  ).list();
  const flows = repository(store, ARTIFACT_TYPES.FLOW, FlowSchema).list();
  const screens = repository(
    store,
    ARTIFACT_TYPES.SCREEN_COMPOSITION,
    ScreenCompositionSchema,
  ).list();
  const testCases = repository(store, ARTIFACT_TYPES.TEST_CASE, TestCaseSchema).list();
  const threats = repository(store, ARTIFACT_TYPES.THREAT_MODEL, ThreatModelSchema).list();

  const items: GeneratedWorkItem[] = [];
  const skipped: { feature: string; reason: string }[] = [];

  features.forEach((feature, index) => {
    const featureReqs = requirements.filter(
      (r) => r.featureRef?.id === feature.id || r.tracesTo.some((t) => t.id === feature.id),
    );
    if (featureReqs.length === 0) {
      skipped.push({ feature: feature.name, reason: 'no requirement traces to this feature' });
      return;
    }

    const reqIds = new Set(featureReqs.map((r) => r.id));
    const featureAcs = acceptance.filter((a) => reqIds.has(a.requirementRef.id));
    if (featureAcs.length === 0) {
      skipped.push({
        feature: feature.name,
        reason: 'no acceptance criterion verifies any of its requirements',
      });
      return;
    }

    const review = reviews.find((r) => r.featureRef.id === feature.id);
    if (review === undefined) {
      /* §27: mandatory. A feature with no operability review is not implementable. */
      skipped.push({ feature: feature.name, reason: 'no AdminOperabilityReview exists' });
      return;
    }

    const featureFlows = flows.filter((f) => f.requirementRefs.some((r) => reqIds.has(r.id)));
    const featureTests = testCases.filter((t) =>
      t.derivedFrom.some((d) => reqIds.has(d.id) || featureAcs.some((a) => a.id === d.id)),
    );

    /*
     * `requirements` on a Phase 4 work item is prose the Producer reads. Each line names
     * the canon id it came from, so an engineer that needs the full record can find it,
     * and a reviewer can check that the item did not paraphrase something away.
     */
    const requirementLines = [
      ...featureReqs.map((r) => '[' + r.id + '] ' + r.statement),
      ...rules.map((r) => '[' + r.id + '] business rule: ' + r.statement),
      ...nfrs.map((n) => '[' + n.id + '] ' + n.dimension + ' target: ' + n.target),
      ...featureFlows.map((f) => '[' + f.id + '] user flow: ' + f.name),
      ...screens.map((s) => '[' + s.id + '] screen: ' + s.screen),
      ...(review.whatRequiresAudit.length === 0
        ? []
        : ['[' + review.id + '] admin: audit ' + review.whatRequiresAudit.join(', ')]),
      ...(review.whatMustNeverBeConfigurable.length === 0
        ? []
        : [
            '[' +
              review.id +
              '] admin: NEVER configurable — ' +
              review.whatMustNeverBeConfigurable.join(', '),
          ]),
      ...threats.map((t) => '[' + t.id + '] security: threat model at ' + t.depth + ' depth'),
    ];

    const decisionLines = [
      ...architecture.map((a) => '[' + a.id + '] architecture: ' + a.style + ' — ' + a.rationale),
      ...adrs.map((a) => '[' + a.id + '] ' + a.title + ': ' + a.rationale),
    ];

    items.push({
      /* Phase 4 validates this as a safe path segment; keep it plain and deterministic. */
      workItemId: 'SC-WI-P5' + String(index + 1).padStart(4, '0'),
      title: feature.name,
      requirements: requirementLines,
      acceptanceCriteria: featureAcs.map((a) => '[' + a.id + '] ' + a.criterion),
      decisions: decisionLines,
      allowedScope: [...(input.allowedScope ?? ['src/'])],
      forbiddenScope: [],
      producerAgentId: input.producerAgentId ?? 'SC-AGENT-150',
      reviewerAgentId: input.reviewerAgentId ?? 'SC-AGENT-200',
      recipes: [...(input.recipes ?? [])],
      magnitude: 'M1',
      baseCommit: input.baseCommit,
      expectedOutputs: featureTests.map((t) => t.title),
      maxAttempts: 2,
    });
  });

  return { items, skipped };
}

/**
 * Everything a Producer must be told about the limits of its authority.
 *
 * Appended to the scope boundary rather than left implicit: the engineer receives
 * decisions, and the correct response to a gap is to stop and escalate.
 */
export const ENGINEERING_SCOPE_NOTE =
  'You are implementing decisions that have already been made. Do not redesign the ' +
  'product, change a business rule, choose a different technology, or invent a missing ' +
  'requirement. If the specification is incomplete, ESCALATE — a gap filled in here ' +
  'becomes company policy nobody decided.';
