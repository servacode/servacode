import { z } from 'zod';
import { fail } from '../core/errors.js';
import { ARTIFACT_TYPES, repository } from './repository.js';
import { ProposalSchema, ProposalState, OptionDisposition } from './artifacts/governance.js';
import { ProductDecisionSchema } from './artifacts/product.js';
import { DesignDecisionSchema } from './artifacts/design.js';
import { jsonSchemaFor } from './execution/jsonSchema.js';
import { runDepartment } from './execution/runner.js';
import { DepartmentOutcome } from './execution/types.js';
import { owningAuthorities } from './proposals.js';
import { resolveApplicability } from './applicability.js';
import { SourceMarking } from '../vocab/index.js';
import type { Proposal } from './artifacts/governance.js';
import type {
  DepartmentConfig,
  DepartmentContext,
  DepartmentResult,
  RunnerDeps,
} from './execution/types.js';
import type { ArtifactType } from './repository.js';

/**
 * A PROPOSAL RULING IS A GOVERNED RUN, NOT AN ARGUMENT TO A FUNCTION.
 *
 * SPEC: §33, 06, 32 §9.
 *
 * `acceptanceRefusal` resolves a canonical decision artifact carrying a typed disposition
 * on the exact proposal, written by an authority that owns the affected canon and
 * attributed to a completed governed run. That rule is right, and it described something
 * the company could not actually do: no department declared `ProductDecision` in its
 * outputs, the authority table did not even map the name, and the only way to produce a
 * ruling was to write one straight into the Store — which is precisely the bypass the
 * ScopedCanonWriter exists to make impossible.
 *
 * So here is the path. It is deliberately NARROW:
 *
 *   it is not a new sovereign agent — the ruling is made by the canonical authority that
 *   already owns the canon the proposal would change, running under its own contract;
 *
 *   it is not the department's ordinary run — the Product Manager deciding one proposal
 *   should not re-do product validation, re-write the scope, or spend what a full
 *   lifecycle stage costs. A ruling is one bounded question with one bounded answer;
 *
 *   it is not a second lifecycle — no new proposal states, no new verdict vocabulary. The
 *   agent returns APPROVE / REJECT / DEFER in the `OptionDisposition` Serva already routes
 *   on, and `accept()` reads the artifact afterwards exactly as it already does.
 *
 * The caller says WHICH proposal. It cannot say what the answer is: there is no
 * disposition parameter anywhere in this file's public surface, and the value that reaches
 * the artifact comes from locally validated structured output and nowhere else.
 */

export const ProposalRulingOutputSchema = z
  .object({
    /**
     * The ruling itself.
     *
     * INFORM is not offered. A ruling that neither approves, rejects nor defers has not
     * ruled, and an authority asked to decide must decide — including deciding "not now",
     * which is what DEFER is for and why it is a first-class answer rather than silence.
     */
    disposition: z.enum([
      OptionDisposition.APPROVE,
      OptionDisposition.REJECT,
      OptionDisposition.DEFER,
    ]),
    /** Why. Kept forever, so the same idea is not re-argued from scratch every quarter. */
    rationale: z.string().min(1),
    /** What follows if this is taken into scope. */
    consequenceIfAccepted: z.string().min(1),
    /** What follows if it is not. A decision with only one consequence is an opinion. */
    consequenceIfRejected: z.string().min(1),
    /** What would make this worth revisiting. Most valuable on a DEFER. */
    reevaluationTrigger: z.string().min(1).optional(),
  })
  .strict();
export type ProposalRulingOutput = z.output<typeof ProposalRulingOutputSchema>;

/** The decision family each authority records its rulings in. */
const RULING_FAMILY: Readonly<Record<string, ArtifactType>> = Object.freeze({
  'SC-AGENT-020': ARTIFACT_TYPES.PRODUCT_DECISION,
  'SC-AGENT-130': ARTIFACT_TYPES.DESIGN_DECISION,
});

/** The canonical stage each authority belongs to, for the ledger. */
const RULING_STAGE: Readonly<Record<string, string>> = Object.freeze({
  'SC-AGENT-020': 'SC-STAGE-004',
  'SC-AGENT-130': 'SC-STAGE-025',
});

const ID_PREFIX: Readonly<Record<string, string>> = Object.freeze({
  [ARTIFACT_TYPES.PRODUCT_DECISION]: 'SC-PDEC',
  [ARTIFACT_TYPES.DESIGN_DECISION]: 'SC-DDEC',
});

/**
 * The bounded decision execution for one authority ruling on one proposal.
 *
 * A `DepartmentConfig` like any other, which is the point: it goes through the same
 * enablement check, the same independence check, the same ledger, the same run and the
 * same ScopedCanonWriter as every stage in the company. Nothing about a governance
 * decision earns it a private path.
 */
export function proposalRulingDepartment(
  agentId: string,
  proposal: Proposal,
): DepartmentConfig<typeof ProposalRulingOutputSchema> {
  const family = RULING_FAMILY[agentId] as ArtifactType;
  const stageId = RULING_STAGE[agentId] as string;
  const schema =
    family === ARTIFACT_TYPES.DESIGN_DECISION ? DesignDecisionSchema : ProductDecisionSchema;

  return {
    id: 'DEPT-PROPOSAL-RULING-' + agentId,
    stageId,
    agentId,
    title: 'Proposal Ruling',
    /*
     * ONE FAMILY. The authority is running to record a decision, not to revise the canon
     * the proposal is about — so this run cannot write scope, features or tokens even
     * though its contract permits them elsewhere. A ruling that rewrote the product while
     * ruling on it would be the scope creep §33 exists to prevent, arriving through the
     * mechanism built to stop it.
     */
    produces: [family],
    /*
     * The proposer may not rule on its own proposal. Enforced by the runner's existing
     * independence check rather than by a rule invented here — an actor accepting its own
     * idea is how scope grows without anybody agreeing to it.
     */
    independentOf: [proposal.origin],
    outputSchema: ProposalRulingOutputSchema,
    outputJsonSchema: jsonSchemaFor(ProposalRulingOutputSchema),

    buildContext(): { canon: readonly never[]; excluded: readonly never[] } {
      return {
        canon: [
          {
            source: proposal.id,
            kind: ARTIFACT_TYPES.PROPOSAL,
            version: String(proposal.version),
            content:
              'PROPOSAL ' +
              proposal.id +
              ': ' +
              proposal.title +
              String.fromCharCode(10) +
              proposal.description +
              String.fromCharCode(10) +
              'It would change: ' +
              proposal.affectsCanon +
              String.fromCharCode(10) +
              'Raised by: ' +
              proposal.origin +
              String.fromCharCode(10) +
              'Assessment: ' +
              JSON.stringify(proposal.assessment ?? {}),
            relevance: 1,
          },
        ],
        excluded: [
          {
            subject: 'the rest of the project',
            reason:
              'this run rules on one proposal. A ruling that needed the whole project to decide is a ruling that is really a re-planning, and that is a change request rather than a proposal',
          },
        ],
      } as never;
    },

    task(): string {
      return [
        'Rule on this proposal. You own the canon it would change, so this decision is',
        'yours to make and nobody else’s.',
        '',
        'Answer APPROVE, REJECT or DEFER. All three are real answers:',
        '',
        '  APPROVE — it should become scope. It is not built yet; it becomes eligible.',
        '  REJECT  — it should not, and your rationale is kept so it is not re-argued.',
        '  DEFER   — a good idea at the wrong time. Say what would change your mind.',
        '',
        'Say what follows either way. A decision with only one consequence written down is',
        'an opinion; the reader six months from now needs to see what you traded off.',
        '',
        'You are ruling, not re-planning. Do not redesign the product around this proposal.',
      ].join('\n');
    },

    scopeBoundary(): string {
      return (
        'Rule on proposal ' +
        proposal.id +
        ' and record why. Do not revise ' +
        proposal.affectsCanon +
        ' in this run — accepting a proposal makes it eligible for scope, it does not incorporate it.'
      );
    },

    persist(tx, output, ctx) {
      const at = ctx.clock.now();
      const id = ctx.ids.next(ID_PREFIX[family] as never);

      /*
       * The OPTIONS are Serva's and the CHOICE is the agent's.
       *
       * The three courses open to an authority ruling on a proposal are the same three
       * every time, so composing them here costs nothing and removes the one place a run
       * could describe its own answer into existence. What the agent supplies is the
       * disposition, the rationale and the consequences — the judgement, which is the part
       * only the authority can make.
       */
      const OPTIONS = [
        { option: 'Accept it into scope', consequence: output.consequenceIfAccepted },
        { option: 'Reject it', consequence: output.consequenceIfRejected },
        {
          option: 'Defer it',
          consequence: 'the proposal stays on record, unbuilt, and may be revisited',
        },
      ];
      const CHOSEN: Readonly<Record<string, string>> = {
        [OptionDisposition.APPROVE]: OPTIONS[0]?.option as string,
        [OptionDisposition.REJECT]: OPTIONS[1]?.option as string,
        [OptionDisposition.DEFER]: OPTIONS[2]?.option as string,
      };

      repository(ctx.store, family, schema).put(tx, {
        id,
        createdAt: at,
        proposalRef: { id: proposal.id, version: proposal.version },
        proposalDisposition: output.disposition,
        context:
          'Proposal ' +
          proposal.id +
          ' — ' +
          proposal.title +
          ' — would change ' +
          proposal.affectsCanon,
        options: OPTIONS,
        chosen: CHOSEN[output.disposition] as string,
        rationale: output.rationale,
        rejectedReasons: [],
        ...(output.reevaluationTrigger === undefined
          ? {}
          : { reevaluationTrigger: output.reevaluationTrigger }),
        meta: {
          provenance: {
            marking: SourceMarking.DERIVED,
            from: [proposal.id],
            rationale: 'ruling on a proposal by the authority that owns the affected canon',
          },
          attribution: {
            agentId,
            ...(ctx.runId === undefined ? {} : { runId: ctx.runId }),
            at,
          },
          workItemId: ctx.workItemId,
        },
      } as never);

      return {
        artifactIds: [id],
        notes: [agentId + ' recorded ' + output.disposition + ' on ' + proposal.id + ' as ' + id],
      };
    },
  } as DepartmentConfig<typeof ProposalRulingOutputSchema>;
}

export interface ProposalRulingResult {
  readonly proposalId: string;
  readonly agentId: string;
  /** The decision artifact, when one was recorded. Feed it to `accept`. */
  readonly decisionId?: string;
  readonly outcome: DepartmentOutcome;
  readonly result: DepartmentResult;
  readonly reason?: string;
}

/**
 * Ask the owning authority to rule on a proposal, through a governed run.
 *
 * The caller supplies the proposal and nothing else that matters. It cannot supply the
 * answer: `ruleOnProposal` has no disposition parameter, the department's persist function
 * reads the disposition only from validated structured output, and the artifact it writes
 * goes through a writer scoped to exactly one family.
 *
 * Refusals happen BEFORE the run, because paying a model to produce a ruling nobody could
 * act on is worse than not asking. Two of them are real governance rather than
 * bookkeeping: a proposal nobody has assessed cannot be ruled on, and a proposal whose only
 * owning authority is the proposer is an owner decision — Serva does not have a lawful
 * authority to ask, and pretending otherwise would be self-approval with extra steps.
 */
export async function ruleOnProposal(
  deps: RunnerDeps & { readonly workItemId?: string },
  o: {
    readonly proposalId: string;
    readonly workItemId: string;
    readonly profileId?: string;
  },
): Promise<ProposalRulingResult> {
  const proposal = repository(deps.store, ARTIFACT_TYPES.PROPOSAL, ProposalSchema).get(
    o.proposalId,
  );
  if (proposal === undefined) {
    return fail({
      code: 'E_VALIDATION',
      message: 'No proposal ' + o.proposalId + ' exists',
      remedy: 'Raise and assess it before asking anybody to rule on it.',
      specRef: '§33',
    });
  }
  if (proposal.state !== ProposalState.ASSESSED && proposal.state !== ProposalState.DEFERRED) {
    return fail({
      code: 'E_VALIDATION',
      message: 'Proposal ' + proposal.id + ' is ' + proposal.state + ', not ASSESSED',
      remedy:
        'Assess a proposal before asking an authority to rule on it. A yes to something nobody costed is not a decision.',
      specRef: '§33',
    });
  }

  const owners = [...owningAuthorities(proposal.affectsCanon)].sort();
  const eligible = owners.filter(
    (a) => RULING_FAMILY[a] !== undefined && a !== proposal.origin && deps.enabledAgents.has(a),
  );
  if (eligible.length === 0) {
    return fail({
      code: 'E_GATE_AUTHORITY',
      message:
        'No enabled authority can rule on ' +
        proposal.id +
        ' (it affects ' +
        proposal.affectsCanon +
        ', owned by ' +
        (owners.length === 0 ? 'nobody' : owners.join(' or ')) +
        ')',
      remedy:
        owners.includes(proposal.origin) && owners.length === 1
          ? 'The only owning authority raised this proposal, and an actor may not rule on its own idea. This one is the owner’s: raise it with requestProposalApproval.'
          : 'A proposal affecting canon no enabled agent owns is the owner’s decision. Raise it with requestProposalApproval.',
      details: { proposalId: proposal.id, affectsCanon: proposal.affectsCanon, owners },
      specRef: '§33',
    });
  }

  const agentId = eligible[0] as string;
  const config = proposalRulingDepartment(agentId, proposal);
  const plan = resolveApplicability(o.profileId ?? 'PRF-NEW-PRODUCT');
  const stage = plan.stages.find((s) => s.stageId === config.stageId);
  if (stage === undefined) {
    return fail({
      code: 'E_CONFIG',
      message:
        'The stage ' + config.stageId + ' that ' + agentId + ' belongs to is not a known stage',
      remedy: 'A ruling is recorded against the stage that owns the canon it rules on.',
      specRef: '§33',
    });
  }

  const ctx: DepartmentContext = {
    workItemId: o.workItemId,
    store: deps.store,
    clock: deps.clock,
    ids: deps.ids,
    plan,
    stage,
  };

  const result = await runDepartment(deps, config as never, ctx);
  const decisionId = result.artifactIds[0];
  return {
    proposalId: proposal.id,
    agentId,
    ...(result.outcome === DepartmentOutcome.COMPLETED && decisionId !== undefined
      ? { decisionId }
      : {}),
    outcome: result.outcome,
    result,
    ...(result.reason === undefined ? {} : { reason: result.reason }),
  };
}
