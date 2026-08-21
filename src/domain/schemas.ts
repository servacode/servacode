import { z } from 'zod';
import {
  ArtifactVerifierResultValue,
  CriterionBasis,
  CriterionResult,
  EvidenceClass,
  GateVerdict,
  IndeterminateReason,
  QualificationKind,
  Severity,
  SourceMarking,
  StageExecutionState,
  StageLedgerDisposition,
  WorkItemState,
  WorkflowRunState,
} from '../vocab/index.js';

/**
 * Canonical persisted models for Phase 2. SPEC: 08 §3.
 *
 * Only the entities Phase 2 needs are modelled. 08 §3 remains the authoritative
 * catalogue; later entities attach to this foundation without replacing it.
 * Every enumeration below is imported from src/vocab — no magic strings (27 §6).
 */

/**
 * Build a Zod enum from a canonical vocabulary object while PRESERVING the literal
 * union type. A plain z.enum(Object.values(e)) widens to `string`, which would let
 * a non-canonical value flow through the type system unnoticed -- exactly the
 * magic-string problem 27 §6 forbids.
 */
const enumOf = <T extends Record<string, string>>(e: T): z.ZodType<T[keyof T]> => {
  const values = Object.values(e) as [string, ...string[]];
  return z.enum(values) as unknown as z.ZodType<T[keyof T]>;
};

export const IdSchema = z.string().regex(/^SC-[A-Z]+-[0-9A-Z]+$/, 'malformed identifier (26 §1)');
export const IsoSchema = z.string().datetime({ offset: false });

export const ArtifactVersionRefSchema = z.object({
  artifactId: IdSchema,
  version: z.number().int().positive(),
  digest: z.string().min(1),
});

/** Mirrors the Finding interface in gates/types.ts. */
export const FindingSchema = z.object({
  id: z.string().min(1),
  severity: z.enum(['BLOCKING', 'MAJOR', 'MINOR', 'SUGGESTION']),
  statement: z.string().min(1),
  location: z.string().optional(),
});

export const QualificationSchema = z.object({
  kind: enumOf(QualificationKind),
  subject: z.string().min(1),
  detail: z.string(),
  criterionRef: z.string().optional(),
  expiresAt: IsoSchema.optional(),
});

/* ------------------------------------------------------------------ project */

export const ProjectSchema = z.object({
  id: IdSchema,
  name: z.string().min(1),
  createdAt: IsoSchema,
  /** 03 §2 — the Idea record is captured verbatim and never altered. */
  idea: z.object({ text: z.string(), capturedAt: IsoSchema, source: z.string() }),
  /** 17 §3 — security risk classification. */
  riskClass: z.enum(['R0', 'R1', 'R2', 'R3', 'R4']).default('R1'),
  profile: z.string().default('PRF-NEW-PRODUCT'),
  currentStage: z.string().optional(),
  servaVersion: z.string(),
});
export type Project = z.infer<typeof ProjectSchema>;

/* ---------------------------------------------------------------- work items */

export const WorkItemSchema = z.object({
  id: IdSchema,
  title: z.string().min(1),
  requestClass: z.string(),
  magnitude: z.enum(['M0', 'M1', 'M2', 'M3', 'M4']),
  state: enumOf(WorkItemState),
  profile: z.string(),
  createdAt: IsoSchema,
  updatedAt: IsoSchema,
});
export type WorkItem = z.infer<typeof WorkItemSchema>;

/* ------------------------------------------------------ definition artifacts */

export const RequirementSchema = z.object({
  id: IdSchema,
  statement: z.string().min(1),
  priority: z.enum(['MUST', 'SHOULD', 'COULD', 'WONT_NOW']),
  source: enumOf(SourceMarking),
  rationale: z.string(),
  tracesTo: z.array(z.string()).default([]),
  acceptanceCriteria: z
    .array(z.object({ id: z.string(), criterion: z.string(), verificationMethod: z.string() }))
    .default([]),
});
export type Requirement = z.infer<typeof RequirementSchema>;

export const DecisionSchema = z.object({
  id: IdSchema,
  title: z.string().min(1),
  decisionClass: z.enum([
    'TRIVIAL',
    'MINOR',
    'SIGNIFICANT',
    'MAJOR',
    'STRUCTURAL',
    'CONSTITUTIONAL',
  ]),
  domain: z.string(),
  context: z.string(),
  /** 09 §4.1 — a decision with no driver is a preference. */
  drivers: z.array(z.string()).min(1, 'a Decision must cite at least one driver (09 §4.1)'),
  options: z
    .array(
      z.object({
        name: z.string(),
        description: z.string(),
        rejectedReason: z.string().optional(),
      }),
    )
    .min(2, 'a Decision must record at least two evaluated options (SC-POL-002)'),
  chosen: z.string(),
  rationale: z.string(),
  consequences: z.array(z.string()).default([]),
  reversalCost: z.enum(['LOW', 'MEDIUM', 'HIGH', 'IRREVERSIBLE']),
  /** SC-POL-015 — a Decision without one is incomplete. */
  reevaluationTrigger: z.string().min(1, 'SC-POL-015 requires a re-evaluation trigger'),
  authority: z.string(),
  decidedAt: IsoSchema,
});
export type Decision = z.infer<typeof DecisionSchema>;

export const RiskSchema = z.object({
  id: IdSchema,
  category: z.string(),
  statement: z.string().min(1),
  probability: z.enum(['LOW', 'MEDIUM', 'HIGH']),
  impact: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
  mitigation: z.string(),
  owner: z.string(),
  trigger: z.string(),
  state: z.enum(['OPEN', 'MITIGATED', 'ACCEPTED', 'CLOSED']),
});
export type Risk = z.infer<typeof RiskSchema>;

export const IssueSchema = z.object({
  id: IdSchema,
  description: z.string().min(1),
  severity: z.enum(['CRITICAL', 'MAJOR', 'MINOR', 'COSMETIC']),
  state: z.enum(['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED', 'REJECTED']),
  resolution: z.string().optional(),
});
export type Issue = z.infer<typeof IssueSchema>;

export const ProposalSchema = z.object({
  id: IdSchema,
  title: z.string().min(1),
  proposalClass: z.enum([
    'BLOCKING',
    'ESSENTIAL',
    'RECOMMENDED',
    'OPPORTUNITY',
    'EXPERIMENT',
    'HYGIENE',
    'OPTIONAL',
  ]),
  observation: z.string().min(1),
  proposal: z.string().min(1),
  reason: z.string().min(1),
  state: z.string(),
  /** SC-POL-008 — every terminal state requires a reason. */
  outcomeReason: z.string().optional(),
});
export type Proposal = z.infer<typeof ProposalSchema>;

/* --------------------------------------------------------- artifacts/evidence */

export const ArtifactRefSchema = z.object({
  id: IdSchema,
  path: z.string().min(1),
  version: z.number().int().positive(),
  digest: z.string().min(1),
  producedByRun: z.string().optional(),
});
export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;

/**
 * Evidence metadata foundation. 16 §2.
 * No `state` field: ValidityState is derived (31 VD-1).
 */
export const EvidenceSchema = z.object({
  id: IdSchema,
  evidenceClass: enumOf(EvidenceClass),
  claim: z.string().min(1),
  provenance: z.object({
    capturedBy: z.enum(['RUNTIME', 'OWNER']),
    method: z.string(),
    command: z.string().optional(),
    exitCode: z.number().int().optional(),
    startedAt: IsoSchema.optional(),
    endedAt: IsoSchema.optional(),
    outputDigest: z.string().optional(),
  }),
  artifactVersionsCovered: z.array(ArtifactVersionRefSchema).default([]),
  dependsOn: z.array(z.string()).default([]),
  producedByRun: z.string().optional(),
  capturedAt: IsoSchema,
  validUntil: IsoSchema.optional(),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

/* -------------------------------------------------------------- verification */

export const CriterionEvaluationSchema = z
  .object({
    id: IdSchema,
    criterionRef: z.string().min(1),
    value: enumOf(CriterionResult),
    basis: enumOf(CriterionBasis),
    reason: enumOf(IndeterminateReason).optional(),
    severity: enumOf(Severity),
    evidenceRefs: z.array(z.string()).default([]),
    waiverRef: z.string().optional(),
    applicabilityBasis: z
      .object({
        condition: z.string().min(1),
        resolvedBy: z.string().min(1),
        resolvedAt: IsoSchema,
      })
      .optional(),
    judgedBy: z
      .object({
        role: z.string(),
        criteriaApplied: z.array(z.string()),
        confidence: z.enum(['HIGH', 'MEDIUM', 'LOW']),
      })
      .optional(),
    qualifications: z.array(QualificationSchema).default([]),
    artifactVersionsEvaluated: z.array(ArtifactVersionRefSchema).default([]),
    evaluatedAt: IsoSchema,
  })
  .strict()
  // 08 KI-2b, enforced at the schema layer rather than by convention.
  .refine((v) => v.value !== CriterionResult.INDETERMINATE || v.reason !== undefined, {
    message: 'INDETERMINATE requires a reason (31 §2 TX-3b)',
  })
  .refine((v) => v.value !== CriterionResult.WAIVED || v.waiverRef !== undefined, {
    message: 'WAIVED requires an active waiverRef (09 §9)',
  })
  .refine((v) => v.basis !== CriterionBasis.JUDGED || v.judgedBy !== undefined, {
    message: 'JUDGED basis requires judgedBy (08 KI-2b)',
  })
  .refine((v) => v.value !== CriterionResult.NOT_APPLICABLE || v.applicabilityBasis !== undefined, {
    message: 'NOT_APPLICABLE requires a recorded applicability basis (31 §2)',
  });

/**
 * Full parity with the ArtifactVerifierResult interface in gates/types.ts.
 * `.strict()` so a field added to the interface but not to the schema is caught
 * by the parity test rather than silently stripped at the store boundary.
 */
export const ArtifactVerifierResultSchema = z
  .object({
    id: IdSchema,
    role: z.string().min(1),
    subject: z.array(ArtifactVersionRefSchema).default([]),
    // AV-1: ESCALATED is absent from this vocabulary by construction.
    value: enumOf(ArtifactVerifierResultValue),
    cause: enumOf(IndeterminateReason).optional(),
    dimensionsChecked: z.array(z.string()).default([]),
    dimensionsNotChecked: z
      .array(z.object({ dimension: z.string(), reason: z.string() }))
      .default([]),
    findings: z.array(FindingSchema).default([]),
    basisSummary: z.object({
      measured: z.array(z.string()).default([]),
      judged: z.array(z.string()).default([]),
      derived: z.array(z.string()).default([]),
    }),
    evidenceRefs: z.array(z.string()).default([]),
    actor: z.object({
      runRef: z.string(),
      agentId: z.string(),
      role: z.string(),
    }),
    criteriaApplied: z.array(z.string()).default([]),
    confidence: z.enum(['HIGH', 'MEDIUM', 'LOW']).optional(),
    qualifications: z.array(QualificationSchema).default([]),
    artifactVersionsEvaluated: z.array(ArtifactVersionRefSchema).default([]),
    dependsOn: z.array(z.string()).default([]),
    evaluatedAt: IsoSchema,
  })
  .strict()
  .refine(
    (v) =>
      (v.value !== ArtifactVerifierResultValue.NOT_VERIFIED &&
        v.value !== ArtifactVerifierResultValue.BLOCKED) ||
      v.cause !== undefined,
    { message: 'NOT_VERIFIED and BLOCKED require a cause (31 §4.3, MV-3/MV-4)' },
  );

/** Full parity with the GateResult interface in gates/types.ts. */
export const GateResultSchema = z
  .object({
    id: IdSchema,
    gateRef: z.string().min(1),
    gateVersion: z.string(),
    scope: z.string(),
    verdict: enumOf(GateVerdict),
    criterionEvaluationIds: z.array(z.string()).default([]),
    evidenceRefs: z.array(z.string()).default([]),
    artifactVersionsEvaluated: z.array(ArtifactVersionRefSchema).default([]),
    qualifications: z.array(QualificationSchema).default([]),
    findings: z.array(FindingSchema).default([]),
    evaluatedAt: IsoSchema,
    evaluator: z.string(),
    storeVersion: z.number().int().nonnegative(),
    dependsOn: z.array(z.string()).default([]),
  })
  .strict();

/* ------------------------------------------------------------ stage / ledger */

/**
 * 03 §10 / 31 V5d — immutable, appended per attempt.
 * PS-1: REWORK is not a member of StageLedgerDisposition, enforced by the enum.
 */
export const StageLedgerEntrySchema = z.object({
  id: IdSchema,
  stageId: z.string().min(1),
  workItemId: z.string().min(1),
  attempt: z.number().int().positive(),
  disposition: enumOf(StageLedgerDisposition),
  reason: z.string().optional(),
  profileRef: z.string(),
  gateResultRef: z.string().optional(),
  decidedBy: z.string(),
  at: IsoSchema,
});
export type StageLedgerEntry = z.infer<typeof StageLedgerEntrySchema>;

export const StageStateSchema = z.object({
  stageId: z.string(),
  workItemId: z.string(),
  state: enumOf(StageExecutionState),
  attempt: z.number().int().nonnegative(),
  updatedAt: IsoSchema,
});
export type StageState = z.infer<typeof StageStateSchema>;

/* ------------------------------------------------------------------ workflow */

export const WorkflowRunSchema = z.object({
  id: IdSchema,
  workflowRef: z.string(),
  workflowVersion: z.string(),
  workItemId: z.string(),
  state: enumOf(WorkflowRunState),
  currentSteps: z.array(z.string()).default([]),
  completedSteps: z.array(z.string()).default([]),
  failedSteps: z.array(z.string()).default([]),
  startedAt: IsoSchema,
  updatedAt: IsoSchema,
  endedAt: IsoSchema.optional(),
});
export type WorkflowRun = z.infer<typeof WorkflowRunSchema>;

/**
 * Validate and surface a readable error path. Used at every store boundary.
 *
 * Returns z.output<S> so schema defaults are reflected as REQUIRED in the result,
 * rather than inferring from the input side and leaving them optional.
 */
export function parseOrThrow<S extends z.ZodTypeAny>(
  schema: S,
  value: unknown,
  what: string,
): z.output<S> {
  const r = schema.safeParse(value);
  if (!r.success) {
    const detail = r.error.issues
      .map((i) => (i.path.length > 0 ? i.path.join('.') : '<root>') + ': ' + i.message)
      .join('; ');
    throw new Error('Invalid ' + what + ' — ' + detail);
  }
  return r.data as z.output<S>;
}
