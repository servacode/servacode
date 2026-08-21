import { z } from 'zod';
import { ClaimVerification, EnvelopeStatus } from '../vocab/index.js';
import { ToolCallOutcome, type ObservedToolCall } from '../engine/types.js';

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
  // ONLY a call that ran to completion can corroborate anything. A tool_use event
  // means the model asked and was permitted; it does not mean a result came back, and
  // treating the two as one is how a system starts believing work that never happened.
  const succeeded = observed.filter((c) => c.outcome === ToolCallOutcome.SUCCEEDED);
  const attempted = observed.filter((c) => c.outcome !== ToolCallOutcome.SUCCEEDED);

  const succeededTools = new Set(succeeded.map((c) => c.tool));
  const attemptedTools = new Set(attempted.map((c) => c.tool));
  // A name only counts as a tool reference if it names a tool this run could have
  // called. Anything else in that field is prose, and prose is not a capability claim.
  const knownTools = new Set([...grantedTools, ...succeededTools, ...attemptedTools]);

  return claims.map((claim): ClaimAssessment => {
    // A model asked for an optional tool name often answers "none" rather than
    // omitting the field. That is a statement that NO tool was used, not a claim about
    // a tool called "none", and reading it the second way turns an honest answer into
    // a fabrication finding.
    const named = normalizeToolName(claim.tool);
    const subject = normalizeSubject(claim.reference);

    // A name that corresponds to no tool this run could have called is a description
    // written into the wrong field, not a capability claim. Treating it as a fabricated
    // call would be the most damaging false positive this system can produce.
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

    if (named !== undefined) {
      const claimTool = named;
      const successesWithTool = succeeded.filter((c) => c.tool === claimTool);
      const attemptsWithTool = attempted.filter((c) => c.tool === claimTool);

      if (successesWithTool.length === 0) {
        // The tool never returned a result. Say WHY, because "denied", "failed" and
        // "never finished" are three different facts about the same claim.
        const worst = attemptsWithTool[attemptsWithTool.length - 1];
        return {
          claim,
          verification: ClaimVerification.CONTRADICTED,
          reason: explainNoSuccess(claimTool, worst, succeededTools),
        };
      }

      // A successful call to the right tool is not automatically the right call. Bind
      // on the SUBJECT: reading config.json does not corroborate a claim about
      // README.md, and matching on tool name alone would say it does.
      if (subject !== undefined) {
        const match = successesWithTool.find((c) => subjectsMatch(c.subject, subject));
        if (match === undefined) {
          const seen = successesWithTool
            .map((c) => c.subject ?? '(no recorded subject)')
            .join(', ');
          /*
           * UNVERIFIED, not CONTRADICTED, and the distinction is the whole discipline.
           *
           * CONTRADICTED means the runtime holds positive evidence the claim is false:
           * the tool was denied, or it failed, or it never ran at all. A subject that
           * will not bind is absence of BINDING, not evidence of falsehood — the tool
           * did run, and Serva simply cannot tie this claim to a specific call.
           *
           * A live run proved why this matters. An agent that had honestly run a glob
           * wrote its reference as `pattern=<the glob>`, and calling that fabrication
           * accused a truthful agent of the gravest thing this system can allege.
           * Absence of proof is not proof of absence, here as everywhere else.
           */
          return {
            claim,
            verification: ClaimVerification.UNVERIFIED,
            reason:
              'a successful ' +
              claimTool +
              ' call was observed, but none of them can be bound to "' +
              subject +
              '"; observed targets: ' +
              (seen.length === 0 ? '(none recorded)' : seen),
          };
        }
        return {
          claim,
          verification: ClaimVerification.CORROBORATED,
          reason:
            'a successful ' +
            claimTool +
            ' call targeting "' +
            (match.subject ?? subject) +
            '" was observed by the runtime' +
            (match.resultDigest === undefined
              ? ''
              : ' (result digest ' + match.resultDigest.slice(0, 12) + ')'),
        };
      }

      // No reference to bind on. The tool ran, but Serva cannot tell whether it ran
      // against what the claim is about, so this is recorded rather than believed.
      return {
        claim,
        verification: ClaimVerification.UNVERIFIED,
        reason:
          'a successful ' +
          claimTool +
          ' call was observed, but the claim names no reference to bind it to; supply the path or target so the claim can be checked against what was actually done',
      };
    }

    // Claims about execution without naming a tool cannot be true if the run completed
    // no tool call at all -- a no-tool agent cannot have run a command.
    if (
      succeeded.length === 0 &&
      (claim.kind === 'TOOL_EXECUTION' ||
        claim.kind === 'COMMAND_RUN' ||
        claim.kind === 'TEST_RESULT' ||
        claim.kind === 'FILE_WRITTEN' ||
        claim.kind === 'FILE_READ')
    ) {
      return {
        claim,
        verification: ClaimVerification.CONTRADICTED,
        reason:
          'the claim asserts ' +
          claim.kind +
          ' but the runtime observed no completed tool call in this run' +
          (attempted.length === 0
            ? ''
            : ' (' +
              String(attempted.length) +
              ' call(s) were attempted but none returned a result)'),
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

/** Say precisely why a tool produced nothing, rather than just that it did not. */
function explainNoSuccess(
  tool: string,
  worst: ObservedToolCall | undefined,
  succeededTools: ReadonlySet<string>,
): string {
  const observed = succeededTools.size === 0 ? '(none)' : [...succeededTools].join(', ');
  if (worst === undefined) {
    return (
      'the runtime observed no ' +
      tool +
      ' call at all in this run; tools that did complete: ' +
      observed
    );
  }
  switch (worst.outcome) {
    case ToolCallOutcome.DENIED:
      return 'the runtime observed ' + tool + ' being DENIED; it never executed';
    case ToolCallOutcome.FAILED:
      return (
        'the runtime observed ' +
        tool +
        ' being attempted and FAILING (' +
        (worst.errorClass ?? 'TOOL_ERROR') +
        ')' +
        (worst.subject === undefined ? '' : ' on "' + worst.subject + '"') +
        '; a failed call proves nothing about its target'
      );
    default:
      return (
        'the runtime observed ' +
        tool +
        ' being requested but never completing; the run ended before a result was captured'
      );
  }
}

/** Empty and placeholder references are absent, not targets. */
function normalizeSubject(reference: string | undefined): string | undefined {
  if (reference === undefined) return undefined;
  const r = reference.trim();
  if (r.length === 0) return undefined;
  if (NO_TOOL_SENTINELS.has(r.toLowerCase())) return undefined;
  return r;
}

/**
 * Do a claimed reference and an observed target denote the same thing?
 *
 * Compared on normalised separators and on the tail of the path, because a model
 * writes "README.md" for what the runtime recorded as an absolute path. Deliberately
 * NOT a fuzzy match: one must be a path-segment suffix of the other, so "config.json"
 * never matches "other-config.json".
 */
export function subjectsMatch(observedSubject: string | undefined, claimed: string): boolean {
  if (observedSubject === undefined) return false;
  // A model often labels the reference rather than writing it bare: `pattern=**/x`,
  // `file: src/a.ts`, `path = ./b`. The label is stripped before comparison, because
  // the alternative is failing to bind a reference that is plainly the same thing.
  const norm = (v: string): string =>
    v
      .replace(/^\s*(?:pattern|path|file|file_path|query|glob|target)\s*[:=]\s*/i, '')
      .trim()
      .replace(/\\/g, '/')
      .replace(/^\.\//, '')
      .toLowerCase();
  const a = norm(observedSubject);
  const b = norm(claimed);
  // One must be a whole-segment suffix of the other. `endsWith` alone would let
  // "other-config.json" match a claim about "config.json".
  const isSegmentSuffix = (long: string, short: string): boolean =>
    long === short || long.endsWith('/' + short);
  return isSegmentSuffix(a, b) || isSegmentSuffix(b, a);
}

/** Any contradicted claim is a governance violation, not a quality problem (05 §7). */
export function hasFabricatedClaim(assessments: readonly ClaimAssessment[]): boolean {
  return assessments.some((a) => a.verification === ClaimVerification.CONTRADICTED);
}
