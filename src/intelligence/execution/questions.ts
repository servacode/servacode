import { ARTIFACT_TYPES } from '../repository.js';
import { OwnerDecisionRequestSchema } from '../artifacts/governance.js';
import { OpenQuestionSchema, isSettlementFor } from '../artifacts/framing.js';
import { repository } from '../repository.js';
import type { ArtifactType } from '../repository.js';
import type { Store } from '../../store/store.js';
import { isAuthoritativeOwnerAnswer } from '../artifacts/governance.js';

/**
 * MODEL FIELD CHOICE MUST NOT CONTROL GOVERNANCE.
 *
 * SPEC: §32.
 *
 * An agent that cannot finish says so in one of two envelope fields. `escalations` carries
 * a condition and a detail; `unresolved` carries a sentence. Which one a run uses is a
 * stylistic choice it makes in the moment, and Serva has now been caught three times
 * routing on exactly that kind of choice:
 *
 *   the `blocking` flag on an escalation — four unanswerable questions, none ticked;
 *   the terminal status — EVIDENCE_VIOLATION rather than ESCALATED, so the question fell
 *   through a rule that enumerated which statuses counted;
 *   the field itself — four owner questions in `unresolved` and none in `escalations`.
 *
 * Each time the fix was to widen the enumeration, and each time the next run found the
 * case the enumeration had missed. So the enumeration is gone. Both fields are normalised
 * into one list of open questions before anything routes on them, and the routing is
 * decided from the STORE rather than from how the sentence was filed.
 *
 * The second half matters as much as the first. Not every open question is the owner's:
 *
 *   ALREADY_ANSWERED    — the owner has answered this, and a restart must not ask again
 *   EXISTING_STORE_FACT — the answer is recorded canon; the run simply had not been shown it
 *   RESEARCH            — it is a fact about the world, and Serva may go and find out
 *   UPSTREAM_DEPARTMENT — another department owes it, and asking the owner would be asking
 *                         them to do Serva's job
 *   OWNER_DECISION      — genuinely theirs: money, policy, scope, a fact only they hold
 *
 * OWNER_DECISION is the DEFAULT, and deliberately so. Every other route requires a
 * positive, checkable reason. The cost of asking the owner something Serva could have
 * worked out is a mild annoyance; the cost of routing away a question that was really
 * theirs is Serva inventing an answer, which is the failure this whole phase exists to
 * prevent.
 */

export const QuestionRouting = {
  /** Already answered for this work item. Not asked again. */
  ALREADY_ANSWERED: 'ALREADY_ANSWERED',
  /** An obligation for this is already outstanding with somebody. Not raised twice. */
  ALREADY_ROUTED: 'ALREADY_ROUTED',
  /** The answer is in the Store; the run was not shown it. */
  EXISTING_STORE_FACT: 'EXISTING_STORE_FACT',
  /** A fact about the world Serva may lawfully retrieve. */
  RESEARCH: 'RESEARCH',
  /** Canon another department owes. Asking the owner would be asking them to do our job. */
  UPSTREAM_DEPARTMENT: 'UPSTREAM_DEPARTMENT',
  /** Genuinely the owner's: money, policy, scope, or a fact only they hold. */
  OWNER_DECISION: 'OWNER_DECISION',
} as const;
export type QuestionRouting = (typeof QuestionRouting)[keyof typeof QuestionRouting];

/** Which envelope field a question came from. Kept for provenance, never for routing. */
export const QuestionSource = {
  ESCALATION: 'escalations',
  UNRESOLVED: 'unresolved',
} as const;
export type QuestionSource = (typeof QuestionSource)[keyof typeof QuestionSource];

export interface OpenQuestion {
  /** The normalised text, used to deduplicate. Not shown to anybody. */
  readonly key: string;
  readonly condition: string;
  readonly detail: string;
  /** Every field this question arrived in. Both, when the run said it twice. */
  readonly sources: readonly QuestionSource[];
  /** The run that raised it. Provenance, so an answer can be traced to its question. */
  readonly runId?: string;
  readonly routing: QuestionRouting;
  /** Why it routed there, in a sentence somebody can disagree with. */
  readonly why: string;
  /** For ALREADY_ANSWERED, the decision that answered it. */
  readonly answeredBy?: string;
  /** For EXISTING_STORE_FACT, the exact artifact whose content answers it. */
  readonly factRef?: string;
  /** For UPSTREAM_DEPARTMENT, the canon family that is missing. */
  readonly missingCanon?: string;
}

/**
 * Reduce a question to something comparable.
 *
 * Case, punctuation and filler words go; the remaining words are sorted. "What is the
 * hold duration?" and "Hold duration is not specified" reduce to the same key, which is
 * what stops the same question being asked twice in one batch and again after a restart.
 *
 * Deliberately crude. A cleverer matcher would merge questions that are genuinely
 * different, and two questions asked once each is a much smaller problem than one
 * question silently swallowed.
 */
export function questionKey(text: string): string {
  const FILLER = new Set([
    'a',
    'an',
    'and',
    'any',
    'are',
    'be',
    'been',
    'by',
    'do',
    'does',
    'for',
    'from',
    'has',
    'have',
    'how',
    'in',
    'is',
    'it',
    'its',
    'long',
    'not',
    'of',
    'on',
    'or',
    'should',
    'specified',
    'stated',
    'the',
    'this',
    'to',
    'undefined',
    'unknown',
    'was',
    'what',
    'when',
    'where',
    'whether',
    'which',
    'who',
    'will',
    'with',
    'yet',
  ]);
  return [
    ...new Set(
      text
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 2 && !FILLER.has(w)),
    ),
  ]
    .sort()
    .join(' ');
}

/** Canon families a question can name in ordinary words. */
const FAMILY_WORDS: readonly (readonly [RegExp, ArtifactType])[] = Object.freeze([
  [/\brequirement/i, ARTIFACT_TYPES.REQUIREMENT],
  [/\bnfr|non-functional|performance target/i, ARTIFACT_TYPES.NFR],
  [/\bbusiness rule/i, ARTIFACT_TYPES.BUSINESS_RULE],
  [/\bfeature/i, ARTIFACT_TYPES.FEATURE],
  [/\bproduct scope|in scope|out of scope/i, ARTIFACT_TYPES.PRODUCT_SCOPE],
  [/\barchitecture|module/i, ARTIFACT_TYPES.ARCHITECTURE_MODEL],
  [/\bdata model|entity|schema/i, ARTIFACT_TYPES.DATA_MODEL],
  [/\bthreat|security model/i, ARTIFACT_TYPES.THREAT_MODEL],
  [/\bflow|screen|journey/i, ARTIFACT_TYPES.FLOW],
  [/\bdesign token|component spec/i, ARTIFACT_TYPES.DESIGN_TOKEN_SET],
  [/\btest strategy/i, ARTIFACT_TYPES.TEST_STRATEGY],
]);

/**
 * Vocabulary of the outside world.
 *
 * A question about what OTHER products do is answerable by retrieval. A question about
 * what THIS product should do is not, however similar the words look — so this is checked
 * only alongside a working research gateway, and it never overrides an owner-shaped
 * question.
 */
const EXTERNAL =
  /\bcompetitor|competing|market|industry standard|other products|rivals|benchmark|typical(ly)? (do|offer)/i;

/** Vocabulary of things only the owner can settle. Checked first, and it wins. */
const OWNER_RESERVED =
  /\bbudget|cost ceiling|price|pricing|fee|deposit|payment|charge|commission|refund|discount|policy|legal|contract|brand|deadline|launch|priorit|trade-?off|acceptable|willing to|prefer/i;

export interface NormalizeInput {
  readonly escalations: readonly { readonly condition: string; readonly detail: string }[];
  readonly unresolved: readonly string[];
  readonly store: Store;
  readonly workItemId: string;
  /**
   * Who is asking. Needed to tell an authentic settlement from an assertion.
   *
   * SPEC: finding OLER-CTX-2 (MEDIUM), 1.0.1 security review — the sibling of OLER-CTX-1.
   *
   * The bookkeeping below suppresses a question when an OpenQuestion with a matching key is
   * already OPEN or ANSWERED. OPEN_QUESTION is universal, so without an identity to check
   * against, any department could forge one whose key collides with a real need and the real
   * question would never be asked. Owner-reserved text was already protected; everything else
   * was not.
   */
  readonly departmentId: string;
  readonly agentId: string;
  /** The department's own outputs: canon it owes rather than canon it is owed. */
  readonly produces: readonly string[];
  /** True when Serva can lawfully retrieve for this run. */
  readonly canResearch: boolean;
  readonly runId?: string;
}

/**
 * Turn everything a run could not resolve into one routed list.
 *
 * Deterministic: same inputs, same Store, same output. No model is consulted about how to
 * route a question, because a model asked "is this yours or mine?" will answer helpfully
 * rather than consistently — which is the whole failure this replaces.
 */
export function normalizeOpenQuestions(input: NormalizeInput): readonly OpenQuestion[] {
  /* ---------------------------------------------- 1. one list, whatever field it used */
  const merged = new Map<
    string,
    { condition: string; detail: string; sources: Set<QuestionSource> }
  >();

  const add = (condition: string, detail: string, source: QuestionSource): void => {
    /*
     * Keyed on the DETAIL alone.
     *
     * The condition is a label the run chose — "INSUFFICIENT_CONTEXT", "AMBIGUITY", or
     * the "UNRESOLVED" Serva supplies for the other field. Including it in the key would
     * let the same question filed two ways produce two keys, which is the field choice
     * controlling governance by a slightly longer route.
     */
    const key = questionKey(detail);
    if (key === '') return;
    const existing = merged.get(key);
    if (existing === undefined) {
      merged.set(key, { condition, detail, sources: new Set([source]) });
      return;
    }
    existing.sources.add(source);
    /* Prefer the richer statement: an escalation says what CONDITION was not met. */
    if (detail.length > existing.detail.length) existing.detail = detail;
  };

  for (const e of input.escalations) add(e.condition, e.detail, QuestionSource.ESCALATION);
  for (const u of input.unresolved) add('UNRESOLVED', u, QuestionSource.UNRESOLVED);

  /* ------------------------------------------------- 2. what the Store already answers */
  const answered = repository(
    input.store,
    ARTIFACT_TYPES.OWNER_DECISION_REQUEST,
    OwnerDecisionRequestSchema,
  )
    .list()
    /*
     * SCOPED, WITH NO "BELONGS TO EVERYTHING" CASE.
     *
     * SPEC: finding OLER-SCOPE-OWNERDEC (MEDIUM), 1.0.1 security review — the sibling of
     * OLER-REV-1, which was the same clause in the obligations map.
     *
     * `derived()` stamps `workItemId` on every artifact a department writes, so admitting an
     * UNSCOPED owner decision admitted only what a department did not write — while letting it
     * settle questions for every work item at once. OWNER_DECISION_REQUEST is universal, which
     * is what makes that worth closing rather than tidying.
     */
    .filter((d) => d.meta.workItemId === input.workItemId);

  const answeredByKey = new Map<string, string>();
  for (const d of answered) {
    /*
     * SPEC: finding F1-OWNER-ANSWER-TRUST.
     *
     * This tested `state !== 'ANSWERED'` and nothing else, so a department that persisted an
     * ANSWERED decision attributed to itself routed the matching question to ALREADY_ANSWERED
     * — and the owner was never asked. Authority now comes from the one predicate that knows
     * what an owner answer is.
     */
    if (!isAuthoritativeOwnerAnswer(d)) continue;
    answeredByKey.set(questionKey(d.question), d.id);
  }
  const openByKey = new Set(
    answered.filter((d) => d.state === 'OPEN').map((d) => questionKey(d.question)),
  );

  /*
   * Obligations already recorded, from any earlier run of any department.
   *
   * This is what makes routing survive a restart: an OpenQuestion is canon, so a second
   * process finds the obligation rather than raising it again. Without it, every resume
   * would re-route the same question and produce a second research request or a second
   * upstream obligation for work already outstanding.
   */
  /*
   * A DEPARTMENT'S OWN RECORD CANNOT SETTLE A QUESTION RESERVED TO THE OWNER.
   *
   * SPEC: finding ORGANIZATIONAL-LEARNING-EXECUTION-AND-RESEARCH/SEC-1 (HIGH), 1.0.1 review.
   *
   * This wrote into `answeredByKey` — the same map the loop above fills — with no
   * authoritativeness check and no `workItemId` filter, twenty lines after that loop was
   * hardened to require `isAuthoritativeOwnerAnswer` and a matching work item. So the guard
   * was added to one writer and the other was left open, which is the same map reaching the
   * same routing decision by a different road.
   *
   * It matters because `OPEN_QUESTION` is UNIVERSAL in authority.ts — any department may
   * write one — and ALREADY_ANSWERED is evaluated BEFORE the OWNER_RESERVED rule. A
   * department could therefore pre-write a self-attributed ANSWERED OpenQuestion whose text
   * keys to a money, policy or scope question, and the owner would never be asked. An agent
   * deciding, on its own record, that the owner has already decided.
   *
   * The two kinds of settlement are now kept apart. An owner decision settles anything; a
   * department's OpenQuestion settles only what is not reserved to the owner. Both still
   * survive a restart, which is what this bookkeeping is for.
   */
  const settledByDepartment = new Map<string, string>();

  const outstanding = new Map<string, string>();
  for (const q of repository(
    input.store,
    ARTIFACT_TYPES.OPEN_QUESTION,
    OpenQuestionSchema,
  ).list()) {
    /* Scoped like the decisions above. A question settled under another work item says
       nothing about this one. */
    if (q.meta.workItemId !== undefined && q.meta.workItemId !== input.workItemId) continue;

    /*
     * Only THIS department's own, authentic records are bookkeeping for THIS department.
     *
     * A WITHDRAWN question is not a settlement and carries no answer, so it is accepted only
     * from the department that raised it under its own attribution — the same identity test,
     * without the requirement that something discharged it.
     */
    const mine = q.raisedBy === input.departmentId && q.meta.attribution.agentId === input.agentId;

    if (q.state === 'ANSWERED' || q.state === 'WITHDRAWN') {
      if (
        q.state === 'WITHDRAWN'
          ? mine
          : isSettlementFor(q, {
              departmentId: input.departmentId,
              agentId: input.agentId,
              workItemId: input.workItemId,
            })
      ) {
        settledByDepartment.set(questionKey(q.question), q.id);
      }
      continue;
    }
    if (mine) outstanding.set(questionKey(q.question), q.askedOf);
  }

  /* ------------------------------------------------------------------ 3. route each one */
  const out: OpenQuestion[] = [];
  for (const [key, q] of merged) {
    const text = q.condition + ' ' + q.detail;
    const base = {
      key,
      condition: q.condition,
      detail: q.detail,
      sources: [...q.sources],
      ...(input.runId === undefined ? {} : { runId: input.runId }),
    };

    /* Already settled by the OWNER. A restart must not ask a question they have answered. */
    const already = answeredByKey.get(key);
    if (already !== undefined) {
      out.push({
        ...base,
        routing: QuestionRouting.ALREADY_ANSWERED,
        why: 'the owner already answered this, on ' + already,
        answeredBy: already,
      });
      continue;
    }

    /*
     * Settled by a department's own OpenQuestion — which cannot close an owner-reserved
     * question, however the record was written.
     *
     * SPEC: finding ORGANIZATIONAL-LEARNING-EXECUTION-AND-RESEARCH/SEC-1 (HIGH).
     *
     * Checked against OWNER_RESERVED here rather than relying on the rule further down,
     * because that rule is only reached by questions this branch does not already consume.
     * Ordering was the whole exploit: ALREADY_ANSWERED ran first, so a department record
     * settled the question before anything asked whether the owner owned it.
     */
    const departmentSettled = settledByDepartment.get(key);
    if (departmentSettled !== undefined && !OWNER_RESERVED.test(text)) {
      out.push({
        ...base,
        routing: QuestionRouting.ALREADY_ANSWERED,
        why: 'this question was already settled and recorded, on ' + departmentSettled,
        answeredBy: departmentSettled,
      });
      continue;
    }
    if (openByKey.has(key)) {
      out.push({
        ...base,
        routing: QuestionRouting.ALREADY_ANSWERED,
        why: 'this question is already open with the owner and does not need asking twice',
      });
      continue;
    }

    /*
     * An obligation already exists for this, on somebody. Do not raise a second — unless the
     * question is the owner's and the obligation is parked with somebody else.
     *
     * SPEC: finding ORGANIZATIONAL-LEARNING-EXECUTION-AND-RESEARCH/OLER-1 (HIGH), 1.0.1 review.
     *
     * The SEC-1 fix guarded the SETTLED path and left this one open, which is the same defect
     * one branch across: `outstanding` is filled from any OPEN OpenQuestion, OPEN_QUESTION is
     * UNIVERSAL so any department may write one, and this branch runs before OWNER_RESERVED.
     * A department could park a money question with RESEARCH and the owner's own question then
     * resolved to ALREADY_ROUTED — not answered falsely, simply never asked.
     *
     * Fixing the reported branch and not the class is what produced the second finding, so the
     * rule is now stated once and every branch above obeys it:
     *
     *   AN OWNER-RESERVED QUESTION MAY ONLY BE SUPPRESSED BY SOMETHING THAT PUTS IT IN FRONT
     *   OF THE OWNER.
     *
     * An authoritative owner answer qualifies. An OPEN owner decision request qualifies — the
     * question is with them right now. An obligation held BY the owner qualifies. A
     * department's own record, and an obligation parked on research or another department, do
     * not: none of them ends with the owner being asked.
     *
     * WHAT ACTUALLY REACHES THE OWNER, CHECKED RATHER THAN ASSUMED.
     *
     * SPEC: finding OLER-ROUTE-1 (MEDIUM), 1.0.1 review — the third pass on this rule.
     *
     * The previous fix let an obligation through when `askedOf === 'OWNER'`, reasoning that a
     * question owed by the owner is already with them. That was an invented property, and the
     * reviewer was right to refuse to certify it rather than guess.
     *
     * The owner's surface — `serva intelligence decisions` and `projectSnapshot` — reads
     * OWNER_DECISION_REQUEST and nothing else. OPEN_QUESTION is internal obligation
     * bookkeeping and is shown to nobody. So a department could write an OPEN OpenQuestion
     * with `askedOf: 'OWNER'` keyed to a money question and the real question was suppressed
     * with no OwnerDecisionRequest ever existing: the same harm, through the exception added
     * while fixing it.
     *
     * NO obligation qualifies, because no obligation reaches the owner. Only OWNER_DECISION
     * routing creates the record the owner reads. The correct code is simpler than the version
     * with the exception in it.
     */
    const outstandingWith = outstanding.get(key);
    if (outstandingWith !== undefined && !OWNER_RESERVED.test(text)) {
      out.push({
        ...base,
        routing: QuestionRouting.ALREADY_ROUTED,
        why: 'an obligation for this question is already outstanding with ' + outstandingWith,
      });
      continue;
    }

    /*
     * Owner-reserved vocabulary wins over everything below it. A question about a deposit
     * is the owner's even if it also mentions what competitors charge — Serva may find out
     * what others do, and may not decide what this shop does.
     */
    if (OWNER_RESERVED.test(text)) {
      out.push({
        ...base,
        routing: QuestionRouting.OWNER_DECISION,
        why: 'it asks about money, policy, scope or preference, which is the owner’s to settle',
      });
      continue;
    }

    /* The answer is canon somebody already wrote, and this run was not shown it. */
    const namedId = /\bSC-[A-Z]+-[0-9A-Z]+/.exec(text)?.[0];
    if (namedId !== undefined && canonExistsAnywhere(input.store, namedId)) {
      out.push({
        ...base,
        routing: QuestionRouting.EXISTING_STORE_FACT,
        why: namedId + ' is already recorded; this run was not given it',
        factRef: namedId,
      });
      continue;
    }

    /* A fact about the world, and Serva is permitted to go and find out. */
    if (input.canResearch && EXTERNAL.test(text)) {
      out.push({
        ...base,
        routing: QuestionRouting.RESEARCH,
        why: 'it is a question about the outside world, which Serva may retrieve rather than ask',
      });
      continue;
    }

    /* Canon another department owes: it does not exist yet, and this one does not write it. */
    const family = FAMILY_WORDS.find(([re]) => re.test(text))?.[1];
    if (
      family !== undefined &&
      !input.produces.includes(family) &&
      input.store.listCanonIds(family).length === 0
    ) {
      out.push({
        ...base,
        routing: QuestionRouting.UPSTREAM_DEPARTMENT,
        why:
          'no ' +
          family +
          ' exists yet, and this department does not write it: the stage that does has not run',
        missingCanon: family,
      });
      continue;
    }

    /*
     * Default. Everything that is not demonstrably somebody else's is the owner's, because
     * the alternative to asking is guessing.
     */
    out.push({
      ...base,
      routing: QuestionRouting.OWNER_DECISION,
      why: 'nothing in the Store answers it and Serva may not invent it',
    });
  }
  return out;
}

/** Does any artifact family hold this id? */
function canonExistsAnywhere(store: Store, id: string): boolean {
  for (const type of Object.values(ARTIFACT_TYPES)) {
    if (store.listCanonIds(type).includes(id)) return true;
  }
  return false;
}
