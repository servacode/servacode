import { z } from 'zod';
import { ClaimVerification, EnvelopeStatus } from '../vocab/index.js';
import type { ObservedToolCall } from '../engine/types.js';

/**
 * The universal Agent Output Envelope. SPEC: 05 §6, 19 SO-4.
 *
 * Every agent output carries these fields whatever its role-specific payload is.
 * The envelope is where the system's scepticism lives:
 *
 *   - `observations` may be empty but never absent (SC-POL-007). `.default([])` would
 *     hide the difference between "I looked and found nothing" and "I did not look",
 *     so the field is REQUIRED and an empty array must be sent explicitly.
 *   - `assumptions_made` is mandatory wherever an assumption was made (05 §6.1),
 *     because silent assumption is the mechanism that produces confidently wrong work.
 *   - `evidence_claims` are claims. See `verifyEvidenceClaims`.
 */

export const ObservationSchema = z
  .object({
    kind: z.string().min(1),
    statement: z.string().min(1),
    severity: z.enum(['INFO', 'MINOR', 'MAJOR', 'BLOCKING']).default('INFO'),
    location: z.string().optional(),
  })
  .strict();

export const EscalationSchema = z
  .object({
    condition: z.string().min(1),
    detail: z.string().min(1),
    blocking: z.boolean().default(false),
  })
  .strict();

export const AssumptionSchema = z
  .object({
    statement: z.string().min(1),
    loadBearing: z.boolean(),
    validatedBy: z.string().optional(),
  })
  .strict();

/**
 * What the agent believes it produced or observed.
 *
 * `kind` names the class of thing claimed so the runtime knows where to look for a
 * corroborating record. There is no `verified` field: an agent does not get to mark
 * its own claim verified.
 */
export const EvidenceClaimSchema = z
  .object({
    kind: z.enum([
      'TOOL_EXECUTION',
      'FILE_READ',
      'FILE_WRITTEN',
      'COMMAND_RUN',
      'TEST_RESULT',
      'STORE_QUERY',
      'EXTERNAL_SOURCE',
      'OTHER',
    ]),
    statement: z.string().min(1),
    /** The tool the agent says produced it, where applicable. */
    tool: z.string().optional(),
    reference: z.string().optional(),
  })
  .strict();

export const SelfReviewSchema = z
  .object({
    contractConformance: z.string().min(1),
    scopeConformance: z.string().min(1),
    knownGaps: z.array(z.string()),
    confidence: z.enum(['HIGH', 'MEDIUM', 'LOW']),
    assumptionsMade: z.array(AssumptionSchema),
  })
  .strict();

export const OutputEnvelopeSchema = z
  .object({
    status: z.nativeEnum(EnvelopeStatus),
    result: z.unknown(),
    selfReview: SelfReviewSchema,
    observations: z.array(ObservationSchema),
    escalations: z.array(EscalationSchema),
    evidenceClaims: z.array(EvidenceClaimSchema),
    unresolved: z.array(z.string()),
  })
  .strict();

export type OutputEnvelope = z.output<typeof OutputEnvelopeSchema>;

/**
 * The envelope as JSON Schema, for `--json-schema`.
 *
 * Hand-written rather than derived from the Zod schema: Phase 2's ADR-001 rejected a
 * converter dependency, and the two are kept honest by a test that round-trips a
 * valid envelope through both. A drift between them therefore fails the suite rather
 * than reaching the engine.
 */
export function envelopeJsonSchema(resultSchema: Record<string, unknown>): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: [
      'status',
      'result',
      'selfReview',
      'observations',
      'escalations',
      'evidenceClaims',
      'unresolved',
    ],
    properties: {
      status: { type: 'string', enum: Object.values(EnvelopeStatus) },
      result: resultSchema,
      selfReview: {
        type: 'object',
        additionalProperties: false,
        required: [
          'contractConformance',
          'scopeConformance',
          'knownGaps',
          'confidence',
          'assumptionsMade',
        ],
        properties: {
          contractConformance: { type: 'string', minLength: 1 },
          scopeConformance: { type: 'string', minLength: 1 },
          knownGaps: { type: 'array', items: { type: 'string' } },
          confidence: { type: 'string', enum: ['HIGH', 'MEDIUM', 'LOW'] },
          assumptionsMade: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['statement', 'loadBearing'],
              properties: {
                statement: { type: 'string', minLength: 1 },
                loadBearing: { type: 'boolean' },
                validatedBy: { type: 'string' },
              },
            },
          },
        },
      },
      observations: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['kind', 'statement'],
          properties: {
            kind: { type: 'string', minLength: 1 },
            statement: { type: 'string', minLength: 1 },
            severity: { type: 'string', enum: ['INFO', 'MINOR', 'MAJOR', 'BLOCKING'] },
            location: { type: 'string' },
          },
        },
      },
      escalations: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['condition', 'detail'],
          properties: {
            condition: { type: 'string', minLength: 1 },
            detail: { type: 'string', minLength: 1 },
            blocking: { type: 'boolean' },
          },
        },
      },
      evidenceClaims: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['kind', 'statement'],
          properties: {
            kind: {
              type: 'string',
              enum: [
                'TOOL_EXECUTION',
                'FILE_READ',
                'FILE_WRITTEN',
                'COMMAND_RUN',
                'TEST_RESULT',
                'STORE_QUERY',
                'EXTERNAL_SOURCE',
                'OTHER',
              ],
            },
            statement: { type: 'string', minLength: 1 },
            tool: { type: 'string' },
            reference: { type: 'string' },
          },
        },
      },
      unresolved: { type: 'array', items: { type: 'string' } },
    },
  };
}

/**
 * Values a model uses to mean "no tool", which are not tool names.
 *
 * Kept explicit rather than inferred: the point of this list is that reading any of
 * them as a tool name converts a truthful "I used no tools" into an evidence
 * fabrication finding, which is the most damaging false positive this system can
 * produce.
 */
const NO_TOOL_SENTINELS: ReadonlySet<string> = new Set([
  'none',
  'n/a',
  'na',
  'null',
  'nil',
  'no tool',
  'no tools',
  '-',
]);

/**
 * Names the provider emits for its own machinery rather than for a granted tool.
 *
 * `StructuredOutput` is how `--json-schema` is delivered; it is not a capability Serva
 * granted and counting it as one would misreport every structured run as having made
 * a tool call.
 */
export const PROVIDER_INTERNAL_TOOLS: ReadonlySet<string> = new Set([
  'StructuredOutput',
  'structured_output',
]);

export function normalizeToolName(tool: string | undefined): string | undefined {
  if (tool === undefined) return undefined;
  const t = tool.trim();
  if (t.length === 0) return undefined;
  if (NO_TOOL_SENTINELS.has(t.toLowerCase())) return undefined;
  return t;
}

export interface ClaimAssessment {
  readonly claim: z.output<typeof EvidenceClaimSchema>;
  readonly verification: ClaimVerification;
  readonly reason: string;
}

/**
 * Compare what the agent CLAIMS it did against what the runtime OBSERVED.
 *
 * SPEC: 19 SO-5, 04 §7.1 check 4, SC-POL-023.
 *
 * This is the distinction the whole architecture rests on. An agent cannot bring a
 * test pass, a command result, a file write or a git diff into existence by mentioning
 * it in JSON. The only things that corroborate a claim are records the runtime made
 * itself while the run was happening.
 *
 * Phase 3 implements the FOUNDATION and the distinction, not the full Phase 4 evidence
 * capture. That limit is expressed honestly: a claim the runtime has no capture channel
 * for comes back `UNVERIFIED` with a reason saying so — never `CORROBORATED` by default,
 * and never silently dropped.
 */
export function verifyEvidenceClaims(
  claims: readonly z.output<typeof EvidenceClaimSchema>[],
  observed: readonly ObservedToolCall[],
  grantedTools: readonly string[] = [],
): ClaimAssessment[] {
  const succeeded = new Set(observed.filter((t) => t.allowed).map((t) => t.tool));
  const denied = new Set(observed.filter((t) => !t.allowed).map((t) => t.tool));
  // A name only counts as a tool reference if it names a tool this run could have
  // called. Anything else in that field is prose, and prose is not a capability claim.
  const knownTools = new Set([...grantedTools, ...succeeded, ...denied]);

  return claims.map((claim) => {
    // A model asked for an optional tool name often answers "none" rather than
    // omitting the field. That is a statement that NO tool was used, not a claim about
    // a tool called "none", and reading it the second way turns an honest answer into
    // a fabrication finding.
    const named = normalizeToolName(claim.tool);

    // A name that does not correspond to any tool this run could have called is not a
    // capability claim at all -- it is a description written into the wrong field.
    // Treating it as a fabricated tool call would be the most damaging false positive
    // this system can produce, so it is reported as unverified with the reason stated.
    if (named !== undefined && !knownTools.has(named)) {
      return {
        claim,
        verification: ClaimVerification.UNVERIFIED,
        reason:
          '"' +
          named +
          '" is not a tool granted to this run, so the field describes something rather than naming a capability; the claim is recorded, not corroborated',
      };
    }

    // A claim naming a real tool is checkable now: either the runtime saw that call or
    // it did not, and "did not" is decisive rather than merely unproven.
    if (named !== undefined) {
      const claimTool = named;
      if (denied.has(claimTool) && !succeeded.has(claimTool)) {
        return {
          claim,
          verification: ClaimVerification.CONTRADICTED,
          reason:
            'the runtime observed ' + claimTool + ' being DENIED and never succeeding in this run',
        };
      }
      if (!succeeded.has(claimTool)) {
        return {
          claim,
          verification: ClaimVerification.CONTRADICTED,
          reason:
            'the runtime observed no successful ' +
            claimTool +
            ' call in this run; observed tools: ' +
            (succeeded.size === 0 ? '(none)' : [...succeeded].join(', ')),
        };
      }
      return {
        claim,
        verification: ClaimVerification.CORROBORATED,
        reason: 'a successful ' + claimTool + ' call was observed by the runtime',
      };
    }

    // Claims about execution without naming a tool cannot be true if the run made no
    // tool calls at all — a no-tool agent cannot have run a command.
    if (
      observed.length === 0 &&
      (claim.kind === 'TOOL_EXECUTION' ||
        claim.kind === 'COMMAND_RUN' ||
        claim.kind === 'TEST_RESULT' ||
        claim.kind === 'FILE_WRITTEN')
    ) {
      return {
        claim,
        verification: ClaimVerification.CONTRADICTED,
        reason:
          'the claim asserts ' +
          claim.kind +
          ' but the runtime observed no tool call at all in this run',
      };
    }

    return {
      claim,
      verification: ClaimVerification.UNVERIFIED,
      reason:
        'Serva has no runtime capture channel for a ' +
        claim.kind +
        ' claim yet, so it is recorded as a claim and not treated as evidence (SC-POL-023)',
    };
  });
}

/** Any contradicted claim is a governance violation, not a quality problem (05 §7). */
export function hasFabricatedClaim(assessments: readonly ClaimAssessment[]): boolean {
  return assessments.some((a) => a.verification === ClaimVerification.CONTRADICTED);
}
