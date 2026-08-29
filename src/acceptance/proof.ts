import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { IsoSchema } from '../domain/schemas.js';

/**
 * ACCEPTANCE PROOFS — A REPORT DESCRIBING AN EVENT IS NOT THE EVENT.
 *
 * SPEC: Phase 6 closure §1, §2; §59.
 *
 * The independent audit found the previous acceptance status deriving PASS from prose. A
 * markdown line reading `Independent reviewer: Jane Roe` produced a green Security
 * Acceptance; a text file containing `RESULT: ACCEPTED` produced a green Live Acceptance;
 * three phrases in a walkthrough produced a green Portability. My own test suite proved a
 * synthetic file passed, and I wrote that test.
 *
 * That is the same defect three times over, and it is worse than the three parsing bugs
 * before it, because those were mistakes in a check and this was a category error about
 * what a check IS. A file somebody can edit is not an authority boundary, however carefully
 * it is parsed.
 *
 * So acceptance now resolves TYPED PROOFS, and a proof is only as good as what it resolves
 * to:
 *
 *   the exact implementation COMMIT and the exact git TREE it describes, both re-derived
 *   from the repository rather than read from the proof;
 *
 *   every file it cites, by CONTENT DIGEST, recomputed at resolution time;
 *
 *   for a JUDGED proof, a real reviewer AgentRun that COMPLETED, by an actor with reviewer
 *   authority who is not the producer of the work reviewed;
 *
 *   for a LIVE proof, a real run plus the machine fingerprint it happened on.
 *
 * A proof is written by the TOOL that performed the verification, never by hand. A
 * hand-written one is not forbidden — nothing here can forbid editing a file — it simply
 * fails to resolve, because the tree digest, the file digests and the run references are
 * facts about the world rather than claims in the document.
 *
 * WHAT THIS STILL CANNOT DO. There is no signing key, so a determined author with the
 * repository can recompute digests and mint a DETERMINISTIC proof for a tree that really
 * does exist. What they cannot mint is a reviewer AgentRun or a live Producer run, which is
 * why the two lines that gate `READY` are exactly those two. The ceiling is stated rather
 * than papered over.
 */

export const VerificationType = {
  /** An offline test asserted it, with no model and no network. */
  DETERMINISTIC: 'DETERMINISTIC',
  /** A governed agent judged it, in a run that is resolvable. */
  JUDGED: 'JUDGED',
  /** Proved against the real provider on a named machine. */
  LIVE: 'LIVE',
  /** A person followed a written step and the output was captured. */
  HUMAN: 'HUMAN',
  /** Proved in an isolated stand-in. Never device proof. */
  SIMULATED: 'SIMULATED',
} as const;
export type VerificationType = (typeof VerificationType)[keyof typeof VerificationType];

export const ProofStatus = {
  PASS: 'PASS',
  FAIL: 'FAIL',
  NOT_VERIFIED: 'NOT_VERIFIED',
} as const;
export type ProofStatus = (typeof ProofStatus)[keyof typeof ProofStatus];

export const EvidenceKind = {
  /** A file in the package. Requires a digest, checked on resolution. */
  FILE: 'FILE',
  /** An AgentRun id, resolvable in a store. */
  AGENT_RUN: 'AGENT_RUN',
  /** A canonical artifact id in a store. */
  STORE_ARTIFACT: 'STORE_ARTIFACT',
  /** A git commit. */
  COMMIT: 'COMMIT',
  /** A machine fingerprint. */
  MACHINE: 'MACHINE',
} as const;
export type EvidenceKind = (typeof EvidenceKind)[keyof typeof EvidenceKind];

export const EvidenceRefSchema = z
  .object({
    kind: z.enum([
      EvidenceKind.FILE,
      EvidenceKind.AGENT_RUN,
      EvidenceKind.STORE_ARTIFACT,
      EvidenceKind.COMMIT,
      EvidenceKind.MACHINE,
    ]),
    /** Path, run id, artifact id, commit sha or fingerprint. */
    id: z.string().min(1),
    /** REQUIRED for FILE. Recomputed at resolution; a mismatch is a failed proof. */
    digest: z.string().min(1).optional(),
    note: z.string().min(1).optional(),
  })
  .strict();
export type EvidenceRef = z.output<typeof EvidenceRefSchema>;

export const ProducerKind = {
  /** A deterministic tool run: the verify command, a generator, a harness. */
  TOOL: 'TOOL',
  /** A governed AgentRun. */
  AGENT_RUN: 'AGENT_RUN',
  /** A person. Only ever acceptable for HUMAN verification. */
  HUMAN: 'HUMAN',
} as const;
export type ProducerKind = (typeof ProducerKind)[keyof typeof ProducerKind];

export const AcceptanceProofSchema = z
  .object({
    requirementId: z.string().min(1),
    verificationType: z.enum([
      VerificationType.DETERMINISTIC,
      VerificationType.JUDGED,
      VerificationType.LIVE,
      VerificationType.HUMAN,
      VerificationType.SIMULATED,
    ]),
    status: z.enum([ProofStatus.PASS, ProofStatus.FAIL, ProofStatus.NOT_VERIFIED]),
    /** The exact commit this describes. Compared against the repository, not trusted. */
    implementationCommit: z.string().regex(/^[0-9a-f]{40}$/),
    /**
     * The git TREE of that commit.
     *
     * The commit alone is a label; the tree is the content. Recording both means a proof
     * cannot be carried forward onto a modified working tree by editing one line.
     */
    treeDigest: z.string().regex(/^[0-9a-f]{40}$/),
    producedAt: IsoSchema,
    producer: z
      .object({
        kind: z.enum([ProducerKind.TOOL, ProducerKind.AGENT_RUN, ProducerKind.HUMAN]),
        id: z.string().min(1),
        runId: z.string().min(1).optional(),
      })
      .strict(),
    /** What the proof covers, in words a reader can disagree with. */
    scope: z.string().min(1),
    evidence: z.array(EvidenceRefSchema).default([]),
    /** Required for LIVE: the machine the run happened on. */
    machineFingerprint: z.string().min(1).optional(),
    /** Required for JUDGED: the governed reviewer run. */
    reviewerRunRef: z
      .object({
        runId: z.string().min(1),
        agentId: z.string().min(1),
        storePath: z.string().min(1),
      })
      .strict()
      .optional(),
    /** Required for LIVE: the governed run that produced the accepted result. */
    liveRunRef: z
      .object({
        runId: z.string().min(1),
        agentId: z.string().min(1),
        storePath: z.string().min(1),
      })
      .strict()
      .optional(),
    notes: z.array(z.string().min(1)).default([]),
  })
  .strict();
export type AcceptanceProof = z.output<typeof AcceptanceProofSchema>;

export const PROOF_DIR = 'evidence/acceptance';

/** sha256 of a file's bytes. The one digest this module computes. */
export function fileDigest(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    return undefined;
  }
}

export interface RepositoryIdentity {
  /** HEAD, or the implementation baseline the package declares. */
  readonly commit: string;
  /** The git tree of that commit. */
  readonly tree: string;
}

/**
 * A run, as far as a store can confirm it.
 *
 * Injected rather than imported, because resolution must work against a package somebody
 * has just unpacked — where the store a run lives in may be anywhere, or absent.
 */
/** A governed run, named well enough to be found again in a store on disk. */
export interface RunRef {
  readonly runId: string;
  readonly storePath: string;
}

export interface RunResolver {
  (ref: RunRef): { readonly agentId?: string; readonly outcome?: string } | undefined;
}

export interface ResolveOptions {
  readonly root: string;
  readonly repository?: RepositoryIdentity;
  readonly resolveRun?: RunResolver;
  /**
   * Actors that produced the implementation being reviewed.
   *
   * A reviewer drawn from this set is not independent, and the proof fails. Supplied by the
   * caller because who produced a given commit is a fact about the project rather than
   * about this module.
   */
  readonly implementationProducers?: readonly string[];
  /**
   * Re-derive whether a Producer's evidence violation was contained.
   *
   * SPEC: Phase 6 Producer evidence-violation semantics (locked).
   *
   * Supplied by the caller for the same reason `resolveRun` is: this module refuses to open
   * stores, and the answer is a fact about governed evidence rather than about a document.
   * Returning `undefined` means the question could not be decided, which is a refusal — an
   * undecided containment question is never a contained one.
   */
  readonly assessContainment?: (ref: RunRef) => ContainmentVerdict | undefined;
  /**
   * The authority an agent actually holds, from the contract that binds it.
   *
   * SPEC: finding SSA-1 (HIGH).
   *
   * The JUDGED branch checked that a reviewer was not a producer and never checked that it
   * held a verifier's authority at all — so an agent with no certifying power could satisfy a
   * requirement whose text demands "a governed independent reviewer". Injected for the same
   * reason `resolveRun` is: this module refuses to load contracts, and the answer is a fact
   * about the registry rather than about a document.
   */
  readonly reviewerAuthority?: (agentId: string) => string | undefined;
  /**
   * Re-derive the security review this proof claims to rest on.
   *
   * SPEC: HIGH finding SERVA-SELF-ACCEPTANCE-AUTHORITY/SC-SSA-REV-F1.
   *
   * The SECURITY-INDEPENDENT requirement demands the reviewer "left no unresolved Critical or
   * High finding". Nothing here enforced that clause: the JUDGED branch re-derived WHO
   * reviewed and then took WHAT THEY FOUND from `proof.status`, a field anyone can edit.
   *
   * Injected for the same reason `resolveRun` is — this module opens no stores — and returning
   * the aggregate's own refusals rather than a boolean, so there is ONE definition of what a
   * clean security review is and this is not a second copy of it.
   */
  readonly assessSecurityReview?: (ref: RunRef) => SecurityAssessment | undefined;
  /**
   * Re-derive the whole governed chain a LIVE proof rests on.
   *
   * SPEC: Phase 6 bounded writer-vs-resolver sweep.
   *
   * `prove-live.mjs` refuses to mint unless `resolveLiveEngineering` finds the entire chain —
   * ChangeSet, measured evidence, an independent authorised reviewer, the engineering gate and
   * an accepted commit that exists in git. This branch re-derived none of it: it checked that
   * the named run resolved and how it ended, and took the rest from the document.
   *
   * Same shape as `assessSecurityReview`, for the same reason: the writer was trustworthy and
   * the resolver was not.
   */
  readonly assessLiveChain?: (ref: RunRef, requirementId: string) => SecurityAssessment | undefined;
}

/** What the canonical security aggregate concluded. Its refusals, unmodified. */
export interface SecurityAssessment {
  readonly refusals: readonly string[];
}

/** Authorities that are a verifier's rather than a producer's. */
const VERIFIER_AUTHORITIES: ReadonlySet<string> = new Set(['VERIFY', 'REVIEW', 'ASSESS']);

/**
 * The part of a canonical containment assessment this resolver is entitled to act on.
 *
 * Structurally a subset of `ProducerContainment` from `liveProof.ts`, so the canonical
 * assessor satisfies it directly. Deliberately narrow: nothing here can be constructed from
 * a proof document, only from the store the run happened in.
 */
/**
 * Terminal outcomes a LIVE-ENGINEERING run may survive, given canonical containment.
 *
 * SPEC: Phase 6 Producer evidence-violation semantics; LIVE-ENGINEERING PARTIAL semantics.
 *
 * Both entries encode the same principle from opposite directions, and neither is a
 * relaxation: **a Producer's own account is not the verification mechanism — independent
 * measured evidence is.**
 *
 *   EVIDENCE_VIOLATION  the Producer said something the runtime contradicted. Its word is
 *                       worthless, which changes nothing, because its word was never what
 *                       the acceptance rested on.
 *
 *   PARTIAL             the Producer was DENIED the verification command by the intentional
 *                       execution policy and refused to claim a result it had not observed.
 *                       Punishing that would punish the honesty the model is built to reward.
 *
 * Every other terminal outcome stays refused, and containment for these two is always
 * re-derived from governed evidence rather than read from the proof.
 */
const CONTAINABLE_OUTCOMES: ReadonlySet<string> = new Set(['EVIDENCE_VIOLATION', 'PARTIAL']);

export interface ContainmentVerdict {
  readonly contained: boolean;
  readonly producerOutcome: string;
  readonly reasons: readonly string[];
}

export interface ResolvedProof {
  readonly requirementId: string;
  readonly verificationType: VerificationType;
  /** The resolved status. Never simply the status the file claimed. */
  readonly status: ProofStatus;
  readonly claimed: ProofStatus;
  /** Why it did not resolve to PASS, in one sentence per reason. */
  readonly refusals: readonly string[];
  readonly proof?: AcceptanceProof;
  readonly source: string;
}

/** Read one proof file, without resolving it. */
export function readProof(root: string, requirementId: string): AcceptanceProof | undefined {
  const path = join(root, PROOF_DIR, requirementId + '.json');
  if (!existsSync(path)) return undefined;
  try {
    const parsed = AcceptanceProofSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * What the recorded verification run actually reports.
 *
 * Read from the file the proof cites — already digest-checked above, so this is reading a file
 * whose bytes are pinned, and asking it the question nobody was asking.
 */
function verificationRecordRefusals(
  root: string,
  proof: AcceptanceProof,
  repository: RepositoryIdentity | undefined,
): readonly string[] {
  const cited = proof.evidence.find(
    (e) => e.kind === EvidenceKind.FILE && e.id.endsWith('offline-verification.json'),
  );
  if (cited === undefined) {
    return ['the proof cites no verification run record, so nothing says the suite passed'];
  }

  let record: {
    implementationCommit?: string;
    treeDigest?: string;
    commands?: { command?: string; exitCode?: number; testsFailed?: number }[];
  };
  try {
    record = JSON.parse(readFileSync(join(root, ...cited.id.split('/')), 'utf8')) as never;
  } catch {
    return ['the verification run record could not be read'];
  }

  const refusals: string[] = [];
  if (repository !== undefined) {
    if (record.implementationCommit !== repository.commit) {
      refusals.push(
        'the verification ran against commit ' +
          String(record.implementationCommit).slice(0, 12) +
          ' and this package is ' +
          repository.commit.slice(0, 12),
      );
    }
    if (record.treeDigest !== repository.tree) {
      refusals.push('the verification ran against a different tree than this package is');
    }
  }

  const commands = Array.isArray(record.commands) ? record.commands : [];
  if (commands.length === 0) {
    refusals.push('the verification record names no command, so it verified nothing');
  }
  for (const c of commands) {
    if (c.exitCode !== 0) {
      refusals.push(String(c.command) + ' exited ' + String(c.exitCode));
    }
    if (typeof c.testsFailed === 'number' && c.testsFailed > 0) {
      refusals.push(String(c.command) + ' reported ' + String(c.testsFailed) + ' failing test(s)');
    }
  }
  return refusals;
}

/**
 * Resolve a proof against the world it claims to describe.
 *
 * Every refusal is collected rather than returned on the first, because somebody looking at
 * a failed acceptance needs the whole list — a queue of one-at-a-time refusals is how a
 * five-minute fix becomes an afternoon.
 */
export function resolveProof(requirementId: string, o: ResolveOptions): ResolvedProof {
  const source = PROOF_DIR + '/' + requirementId + '.json';
  const path = join(o.root, PROOF_DIR, requirementId + '.json');

  if (!existsSync(path)) {
    return {
      requirementId,
      verificationType: VerificationType.DETERMINISTIC,
      status: ProofStatus.NOT_VERIFIED,
      claimed: ProofStatus.NOT_VERIFIED,
      refusals: ['no acceptance proof exists for ' + requirementId],
      source,
    };
  }

  let proof: AcceptanceProof;
  try {
    const parsed = AcceptanceProofSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
    if (!parsed.success) {
      return {
        requirementId,
        verificationType: VerificationType.DETERMINISTIC,
        status: ProofStatus.NOT_VERIFIED,
        claimed: ProofStatus.NOT_VERIFIED,
        refusals: [
          'the proof is malformed: ' +
            parsed.error.issues
              .slice(0, 3)
              .map((i) => i.path.join('.') + ' ' + i.message)
              .join('; '),
        ],
        source,
      };
    }
    proof = parsed.data;
  } catch (e) {
    return {
      requirementId,
      verificationType: VerificationType.DETERMINISTIC,
      status: ProofStatus.NOT_VERIFIED,
      claimed: ProofStatus.NOT_VERIFIED,
      refusals: ['the proof could not be read: ' + String(e instanceof Error ? e.message : e)],
      source,
    };
  }

  const refusals: string[] = [];

  if (proof.requirementId !== requirementId) {
    refusals.push('the proof is for ' + proof.requirementId + ', not ' + requirementId);
  }

  /* ------------------------------------------------- the tree it claims to describe */

  if (o.repository !== undefined) {
    if (proof.implementationCommit !== o.repository.commit) {
      refusals.push(
        'the proof describes commit ' +
          proof.implementationCommit.slice(0, 12) +
          ' and this package is ' +
          o.repository.commit.slice(0, 12),
      );
    }
    if (proof.treeDigest !== o.repository.tree) {
      /*
       * The commit is a label and the tree is the content. Checking both is what stops a
       * proof being carried onto a modified working tree by editing one line.
       */
      refusals.push(
        'the proof describes tree ' +
          proof.treeDigest.slice(0, 12) +
          ' and this package is ' +
          o.repository.tree.slice(0, 12),
      );
    }
  } else {
    refusals.push(
      'the repository identity could not be read, so nothing binds this proof to a tree',
    );
  }

  /* ------------------------------------------------------ the evidence it cites */

  if (proof.evidence.length === 0) {
    refusals.push('the proof cites no evidence, so it asserts rather than establishes');
  }
  for (const ref of proof.evidence) {
    if (ref.kind !== EvidenceKind.FILE) continue;
    if (ref.digest === undefined) {
      refusals.push('evidence ' + ref.id + ' has no digest, so nothing pins its content');
      continue;
    }
    const actual = fileDigest(join(o.root, ref.id));
    if (actual === undefined) {
      refusals.push('evidence ' + ref.id + ' is not in this package');
      continue;
    }
    if (actual !== ref.digest) {
      refusals.push(
        'evidence ' + ref.id + ' does not match its recorded digest, so it changed since',
      );
    }
  }

  /* --------------------------------------------------- what each type additionally needs */

  if (
    proof.verificationType === VerificationType.DETERMINISTIC ||
    proof.verificationType === VerificationType.LIVE
  ) {
    if (proof.producer.kind === ProducerKind.HUMAN) {
      refusals.push(
        'a ' +
          proof.verificationType +
          ' proof produced by a person is a claim: it must come from the tool or run that performed it',
      );
    }
  }

  if (proof.verificationType === VerificationType.JUDGED) {
    const reviewer = proof.reviewerRunRef;
    if (reviewer === undefined) {
      refusals.push('a JUDGED proof must name the governed reviewer run that produced it');
    } else if (o.resolveRun === undefined) {
      refusals.push('no run resolver was supplied, so the reviewer run could not be confirmed');
    } else {
      const run = o.resolveRun(reviewer);
      if (run === undefined) {
        refusals.push(
          'reviewer run ' + reviewer.runId + ' does not resolve in ' + reviewer.storePath,
        );
      } else {
        if (run.outcome !== 'COMPLETED') {
          refusals.push(
            'reviewer run ' +
              reviewer.runId +
              ' ended ' +
              String(run.outcome) +
              ', so it judged nothing',
          );
        }
        if (run.agentId !== reviewer.agentId) {
          refusals.push(
            'reviewer run ' +
              reviewer.runId +
              ' was made by ' +
              String(run.agentId) +
              ', not the ' +
              reviewer.agentId +
              ' the proof names',
          );
        }
        if ((o.implementationProducers ?? []).includes(reviewer.agentId)) {
          refusals.push(
            reviewer.agentId +
              ' produced the implementation being reviewed, so this is not an independent review',
          );
        }

        /*
         * AND IT MUST BE ABLE TO CERTIFY AT ALL.
         *
         * SPEC: finding SSA-1 (HIGH). Not producing the work is only half of independence;
         * the other half is holding a verifier's authority, which this branch never asked
         * about. With no resolver supplied the answer is unknown, and unknown is a refusal —
         * a JUDGED proof whose reviewer's authority nobody can establish is not judged.
         */
        /*
         * AND THE REVIEW MUST HAVE FOUND NOTHING BLOCKING.
         *
         * SPEC: finding SC-SSA-REV-F1 (HIGH).
         *
         * Confined to SECURITY-INDEPENDENT, because it is the only requirement whose text
         * makes a claim about FINDINGS rather than only about who judged. The answer comes
         * from `aggregateSecurityReview` — the same machinery the minting script runs — so a
         * document that disagrees with the evidence loses to the evidence.
         */
        if (requirementId === 'SECURITY-INDEPENDENT') {
          if (o.assessSecurityReview === undefined) {
            refusals.push(
              'no canonical security assessment was available, so the review this proof cites ' +
                'could not be re-derived and its findings are unknown',
            );
          } else {
            const assessment = o.assessSecurityReview(reviewer);
            if (assessment === undefined) {
              refusals.push(
                'the security review this proof cites does not resolve in ' + reviewer.storePath,
              );
            } else {
              refusals.push(...assessment.refusals);
            }
          }
        }

        if (o.reviewerAuthority === undefined) {
          refusals.push(
            'no authority resolver was supplied, so ' +
              reviewer.agentId +
              " could not be shown to hold a verifier's authority",
          );
        } else {
          const authority = o.reviewerAuthority(reviewer.agentId);
          if (authority === undefined) {
            refusals.push(
              reviewer.agentId + ' holds no contract, so it holds no authority to certify',
            );
          } else if (!VERIFIER_AUTHORITIES.has(authority.toUpperCase())) {
            refusals.push(
              reviewer.agentId +
                ' holds ' +
                authority +
                ', which is not a verifier authority; an agent that can produce cannot certify',
            );
          }
        }
      }
    }
  }

  if (proof.verificationType === VerificationType.LIVE) {
    if (proof.machineFingerprint === undefined) {
      refusals.push('a LIVE proof must name the machine it happened on');
    }
    const live = proof.liveRunRef;
    if (live === undefined) {
      refusals.push('a LIVE proof must name the governed run that produced the result');
    } else if (o.resolveRun === undefined) {
      refusals.push('no run resolver was supplied, so the live run could not be confirmed');
    } else {
      const run = o.resolveRun(live);

      /*
       * THE CHAIN, NOT ONLY THE RUN.
       *
       * A run id resolving says somebody ran something. What makes a LIVE proof mean anything
       * is everything around it, and none of that was checked here.
       */
      if (run !== undefined) {
        if (o.assessLiveChain === undefined) {
          refusals.push(
            'no canonical chain assessment was available, so the governed chain behind ' +
              live.runId +
              ' could not be re-derived',
          );
        } else {
          const chain = o.assessLiveChain(live, requirementId);
          if (chain === undefined) {
            refusals.push(
              'the governed chain behind ' + live.runId + ' does not resolve in ' + live.storePath,
            );
          } else {
            refusals.push(...chain.refusals);
          }
        }
      }

      if (run === undefined) {
        refusals.push('live run ' + live.runId + ' does not resolve in ' + live.storePath);
      } else if (run.outcome !== 'COMPLETED') {
        /*
         * A CONTAINED EVIDENCE VIOLATION IS NOT DISQUALIFYING — FOR LIVE-ENGINEERING ALONE.
         *
         * SPEC: Phase 6 Producer evidence-violation semantics (locked).
         *
         * `liveProof.ts` already implemented the locked rule: a Producer that misreported its
         * own work has not thereby invalidated work that deterministic checks measured and an
         * independent Reviewer judged. This resolver predated it and demanded COMPLETED, so a
         * single real run was accepted by the chain verifier and refused here.
         *
         * The exception is deliberately narrow in three ways, and each matters:
         *
         *   it is keyed to LIVE-ENGINEERING, so no other LIVE requirement inherits it;
         *   it admits EVIDENCE_VIOLATION only — every other terminal outcome stays refused;
         *   containment is RE-DERIVED by the caller's canonical assessor, never read from the
         *   proof document. A `contained: true` written into a file is a claim, and claims in
         *   files are what this whole model exists to refuse.
         *
         * With no assessor supplied the answer is NOT_VERIFIED. Absence of a containment
         * judgement is not a containment judgement.
         */
        const eligible =
          requirementId === 'LIVE-ENGINEERING' && CONTAINABLE_OUTCOMES.has(String(run.outcome));

        if (!eligible) {
          refusals.push('live run ' + live.runId + ' ended ' + String(run.outcome));
        } else if (o.assessContainment === undefined) {
          refusals.push(
            'live run ' +
              live.runId +
              ' ended ' +
              String(run.outcome) +
              ' and no canonical containment assessment was available, so containment is unproven',
          );
        } else {
          const containment = o.assessContainment(live);
          if (containment === undefined) {
            refusals.push(
              'live run ' +
                live.runId +
                ' ended ' +
                String(run.outcome) +
                ' and containment could not be assessed from the store',
            );
          } else if (containment.producerOutcome !== run.outcome) {
            /*
             * The assessment must be about THIS run's outcome. An assessor answering for a
             * different terminal state is answering a different question, and a mismatch here
             * would let a containment verdict for one outcome license another.
             */
            refusals.push(
              'live run ' +
                live.runId +
                ' ended ' +
                String(run.outcome) +
                ' but containment was assessed for ' +
                containment.producerOutcome,
            );
          } else if (!containment.contained) {
            refusals.push(
              'live run ' +
                live.runId +
                ' ended ' +
                String(run.outcome) +
                ' and it is not contained: ' +
                (containment.reasons[0] ?? 'no reason recorded'),
            );
          }
        }
      }
    }
  }

  /*
   * OFFLINE-VERIFICATION MUST SAY THE SUITE PASSED, NOT MERELY THAT IT RAN.
   *
   * SPEC: Phase 6 bounded writer-vs-resolver sweep.
   *
   * The proof cites the run record by content digest, so the file cannot be altered after
   * minting — and nothing ever read what it SAYS. A record of a run that exited 1 with five
   * hundred failures digests exactly as cleanly as a green one, and the claim that the suite
   * passed lived only in the proof's `notes`, which is prose.
   *
   * The digest proves the file is unmodified. It was never evidence that the file says the
   * tests passed.
   */
  if (requirementId === 'OFFLINE-VERIFICATION') {
    refusals.push(...verificationRecordRefusals(o.root, proof, o.repository));
  }

  /* ------------------------------------------------------------------- the verdict */

  const status =
    proof.status !== ProofStatus.PASS
      ? proof.status
      : refusals.length === 0
        ? ProofStatus.PASS
        : ProofStatus.NOT_VERIFIED;

  return {
    requirementId,
    verificationType: proof.verificationType,
    status,
    claimed: proof.status,
    refusals,
    proof,
    source,
  };
}
