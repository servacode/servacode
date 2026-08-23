# SERVA CODE — PHASE 5 AUTHORITY LOCK REPORT

Five defects were raised, plus one additional invariant. All six are closed, and closing
them found two more of the same class.

| | |
|---|---|
| Tests before the lock | 940 |
| Tests after the lock | **973** |
| `npm run verify` | PASS — format, lint, typecheck, 40 files / 973 tests, build |
| Focused regressions | 128 across nine intelligence suites |
| Phase 4 semantics | unchanged |
| Phase 6 | not started |

The previous nine closure fixes are preserved and untouched.

---

## 1. The handoff derives readiness; it cannot be handed one

`generateWorkItems` took a `ReadinessAssessment` and authorised on `isReady()` of whatever
it was given. A caller could construct `{status: 'READY', blockers: []}` and reach work-item
generation while the Store's gates, owner decisions, freshness, reviews and traceability all
said otherwise — the same authority Fix 2 removed from readiness itself, surviving one call
frame higher up.

The parameter is gone. The signature now takes the **work item**, and readiness is assessed
inside the handoff from persisted truth at the moment of the handoff. The derived assessment
is returned on the result so a caller can report it; nothing in it came from the caller.

**Adversarial regression:** an empty Store, a fabricated `{status: 'READY', blockers: []}`
passed alongside the real arguments, and the handoff refuses. There is nowhere to put it.

The production CLI passes the work item and continues to work from disk after restart.

## 2. `waiveGates` is gone

`ReadinessInput` carried a `ReadonlySet<string>` that made a required gate disappear. Every
upstream gate declares `waivable: false`, so this was caller authority over a decision the
catalogue had already refused to delegate.

Removed outright rather than narrowed. If Serva ever supports a real waiver it will go
through the Gate Engine's own waiver model — durable evidence with an authority and an
expiry that the gate resolves and validates — never a string in a Set.

**Regression:** `assessReadiness` takes exactly four arguments, asserted by name, so
reintroducing the bypass is a compile error in a file that says why.

## 3. Review evidence is bound to the work item and the gate cycle

Fix 2 made reviews version-aware but resolved them by reading every `CriterionEvaluation` in
the Store, filtering by criterion id and taking the most recent. A `CriterionEvaluation`
carries no scope, so that quietly accepted an `AR-2` belonging to a **different work item**,
and after a re-entry it accepted the **superseded** evaluation from the cycle that re-entry
had just invalidated.

A `GateResult` does carry `scope`, and it carries `criterionEvaluationIds`. The question is
now asked the right way round: which gate result is authoritative for **this** work item,
and which evaluation did **it** rest on.

Each required review must prove, from disk: the gate result is scoped to this work item, it
currently accepts, the criterion is among the evaluations that gate rested on, the basis is
JUDGED, the judge is the canonical independent reviewer, the value is MET, and every artifact
version it evaluated is still current.

**Regressions:** another work item's later, passing `AR-2` does not rescue this one when its
own architecture gate is superseded by a FAIL; and a passing gate whose
`criterionEvaluationIds` contain no `DS-1` does not count as a design-system review.

## 4. A proposal is accepted by an authority acting, not by a name

`accept` took `acceptedBy: string` and asked whether it *named* an owning agent. That proves
the name of an authority, not that the authority acted: a caller could pass
`"SC-AGENT-020"` with no Product Manager run anywhere in the Store, and any string without
the `SC-AGENT-` prefix was treated as the owner.

Acceptance now takes a reference to a durable **event** and resolves it against the Store:

- **agent-owned canon** — a completed governed `AgentRun` by an authority that owns the
  affected family, which mentions this proposal in **its own immutable trace**. The
  terminal record does not carry the result payload, so binding to a summary was not
  available; binding to the append-only event log is stronger, because a summary is the
  thing a caller would be tempted to shape.
- **owner-reserved canon** — an answered `OwnerDecisionRequest` with purpose
  `PROPOSAL_APPROVAL` targeting this proposal, checked by the same `approvalRefusal` a
  change goes through.

`requestProposalApproval` is the only way to mint proposal consent, and it puts the
previously-unused `DecisionPurpose.PROPOSAL_APPROVAL` to work.

**Regressions:** spoofed name → refused; run by a non-owning actor → refused; unrelated run
by the right actor → refused; incomplete run → refused; the proposer's own run → refused;
arbitrary human string → refused; owner decision for another proposal → refused; owner
REJECT → refused; exact bound APPROVE → accepted.

## 5. An open question can be answered

The escalation path offered *"Answer it, and Serva records the answer as company truth"* and
then stored **that sentence** as the answer. A department asking "how long is a reservation
held?" was told on resume that the owner had answered "Answer it", which is not a duration.
The owner's only workable move was to DEFER something they actually wanted to specify.

Decisions now carry a `responseMode`:

- **OPTION** — a choice between things Serva has worked out. The only mode that can carry an
  `APPROVE` disposition.
- **VALUE** — a fact only the owner holds, with a typed `valueKind`
  (`TEXT | NUMBER | BOOLEAN | DATE | DURATION | ENUM`) so an answer can be checked.

A VALUE answer is **information and never authorisation**, however agreeable its prose.
`chosenDisposition` returns undefined for one, `approvalRefusal` refuses one outright, and
`decisionShapeRefusal` forbids a VALUE decision from carrying an approval purpose at all —
so the two shapes cannot be confused rather than merely being distinguished by care.

Closing this exposed a second defect in the same area: `ownerDecisionRefusal` required a
`chosenOption` on any ANSWERED decision, which a VALUE answer correctly lacks. That check is
what the orchestrator uses to decide whether a pause is resolved, so a VALUE answer would
have looked unanswered and the orchestrator would have refused to resume from an answer it
had just been given.

### 5b. Model field choice must not control governance

The live run made for this defect found the third instance of one pattern. Intake ended
`EVIDENCE_VIOLATION` having recorded four genuine owner questions — the budget ceiling, the
payment model, the hold duration, the catchment — in `unresolved`, and none in `escalations`.
Serva read `escalations`. Four answerable questions, nobody asked.

The three instances, in order: the `blocking` flag on an escalation; the terminal status; the
field itself. Each fix widened an enumeration and the next run found the case the enumeration
missed.

`normalizeOpenQuestions` replaces the enumeration. Both fields merge into one deduplicated
list, and each question is routed **from the Store**:

| Routing | When |
|---|---|
| `ALREADY_ANSWERED` | the owner answered it, or it is already open — a restart does not ask twice |
| `EXISTING_STORE_FACT` | it names canon that exists; the run was not shown it |
| `RESEARCH` | a fact about the world, and Serva may lawfully retrieve it |
| `UPSTREAM_DEPARTMENT` | canon another department owes and this one does not write |
| `OWNER_DECISION` | money, policy, scope, or a fact only the owner holds |

`OWNER_DECISION` is the **default**; every other route needs a positive, checkable reason.
Asking the owner something Serva could have worked out is an annoyance. Routing away a
question that was really theirs is Serva inventing an answer.

Two details the regressions forced:

- The **owner-reserved check runs first**, so *"what deposit should we charge? competitors
  charge 10%"* stays with the owner. Serva may find out what others do; it may not decide
  what this shop does.
- The **dedupe key is computed from the question alone**, not from the run's condition label.
  Keying on `"INSUFFICIENT_CONTEXT: …"` versus `"UNRESOLVED: …"` would have let the field
  choice control governance by a slightly longer route.

The raised decision's question text is now the question, not a labelled one.

## 6. Reserved approval purposes

`OwnerDecisionRequest` is a universal artifact family — every department must be able to stop
and ask, or the authority boundary has a hole in it. But the **form of consent** is not the
same as the ability to ask: a decision whose purpose is `CHANGE_APPROVAL` or
`PROPOSAL_APPROVAL` is what `approveChange` and `accept` later read as authorisation.

Both purposes are refused to every department at the `ScopedCanonWriter`, before the write is
staged. Only `requestChangeApproval` and `requestProposalApproval` mint them.

**Adversarial regression:** a department attempts each purpose and is refused by name; the
same department raising an ordinary `SPECIFICATION_GAP` is not.

## 7. CLI decision usability

`serva intelligence decisions` previously showed an id and a sentence. An owner would have
had to read `.serva` to discover what they were allowed to say, which is not an interface.

It now shows the question, why Serva cannot decide it, every option with its **disposition**,
each option's impact and cost/risk implications, Serva's recommendation and its rationale —
or, for a VALUE decision, the expected kind, unit and permitted values.

```
serva intelligence answer <id> --option "..." --by "<you>"
serva intelligence answer <id> --value  "48 hours" --by "<you>"
```

Giving both, or neither, is refused with the reason.

## 8. Focused regression results

| Suite | Tests |
|---|---|
| `intel.questions.test.ts` (normalisation) | 15 |
| `intel.ownervalue.test.ts` (VALUE decisions) | 4 |
| `intel.governance.test.ts` (approvals, proposals, change, learning) | 45 |
| `intel.authority.test.ts` (handoff, independence, escalation) | 20 |
| `intel.restart.test.ts` (durability, review scope, waivers, CLI) | 10 |
| `intel.writeauthority.test.ts` (output authority) | 15 |
| `intel.e2e.test.ts` · `intel.scenarios.test.ts` · `intel.security.test.ts` | 19 |
| **Total focused** | **128**, all passing |

## 9. Deterministic E2E

Scenario A (new product), B (major feature), C (research failure) and D (owner authority) all
pass. Readiness reaches READY with nothing injected, and the real Phase 4
`EngineeringFactory.recordWorkItem` accepts the generated work item unchanged.

## 10. Restart / readiness / handoff

`tests/intel.restart.test.ts` runs the company, discards every object, reopens the Store in a
process that has seen nothing, and derives READY and a Phase 4 handoff from disk alone. It
also invokes the **built CLI in a separate process** with only a directory as input, and gets
the same result.

## 11. The eleven recorded items — evidenced live, or deterministically

This is stated as a split rather than blurred, because the live run did not exercise
everything.

**The clean live slice** (`evidence/LIVE_NORMALIZER_SLICE.txt`, HEAD `3455cd5`, 10 tests
passing) produced **no `ESCALATED_TO_OWNER` at all**: the model completed discovery on its
first attempt, so normalisation ran and produced no open questions. Business analysis raised
two owner decisions through the financial path — a different mechanism — and the run blocked
at the requirements gate because the independent verifier failed.

| # | Item | Evidence |
|---|---|---|
| 1 | raw escalations count | deterministic — `intel.questions.test.ts` 1 |
| 2 | raw unresolved count | deterministic — 2 |
| 3 | normalised/deduplicated count | deterministic — 3 |
| 4 | routing disposition for every question | deterministic — one test per branch, incl. two negative cases |
| 5 | provenance: run + source fields | deterministic — 7 |
| 6 | duplicate across both fields → one obligation | deterministic — 3 |
| 7 | owner VALUE question → value persisted | deterministic **and live** (pre-`3455cd5` run) |
| 8 | restart from Store | deterministic — `intel.ownervalue.test.ts` |
| 9 | resumed department receives the actual value | deterministic **and live** |
| 10 | answered question not raised again | deterministic — `ALREADY_ANSWERED` |
| 11 | no duplicate OwnerDecisionRequest after restart | deterministic |

**What the live evidence covers.** The pre-`3455cd5` run proved the VALUE *mechanism*
end to end against a real model: `SC-AGENT-030:ESCALATED_TO_OWNER` → the owner supplied
actual facts (*"No system. Staff check the shelf and keep a paper notebook."*) →
`SC-AGENT-030:COMPLETED` on the next round, and the lifecycle carried on through business
analysis, requirements, NFRs and the independent verifier. That run predates the normaliser
and is not evidence for routing.

**What it does not cover.** No live run has exercised `normalizeOpenQuestions` producing
owner questions, because whether a model escalates is the model's decision — across seven
live runs it escalated in four and not in three. Routing is evidenced by the deterministic
regressions, which cover every branch including the two negative cases (a market question
with no research capability, and a money question that mentions the market).

An honest reading: the mechanism is proved live, the **routing** is proved deterministically.

## 12. `npm run verify`

```
format:check  PASS
lint          PASS
typecheck     PASS
test          40 files, 973 tests
build         PASS
```

## 13–14. Implementation commit and Git state

Implementation: **`3455cd5`** — *lock 5c: normalise open questions before routing them*.
Evidence is captured in a separate commit above it, because a file cannot record its own
hash. Working tree clean; see `evidence/GIT_STATE.txt`.

## 15. Remaining Critical/High blockers

**None known.**

Standing limitations, unchanged in kind:

1. **8 of 19 canonical gates are undefined** — they guard Phase 4 and later stages. An
   undefined gate blocks rather than passes.
2. **Learning has no cross-project store.** The wall is implemented and tested; the shared
   library is a Phase 6 concern.
3. **Three artifact families have no owner in `32`** (SF-12) — recorded as explicit
   exceptions, each with a stated reason, enumerated by a test.
4. **The competitive chain has never completed live** (`RS-6`) — the public pages carry no
   competitor data, reported as BLOCKED rather than passing quietly.
5. **The 180-second per-run budget** is inherited from Phase 3 and is tight for some
   departments. Handled correctly when it fires.
6. **Live routing evidence is absent by model behaviour**, per §11. A brief engineered to
   force escalation would produce it, but a test whose input is chosen to make a branch fire
   proves less than the deterministic regression already does.

## 16. Phase 6 was NOT started

Confirmed. No VS Code UI, no dashboard, no conversational interface, no installer, no
bootstrap UX, no backup/restore, no migration UX, no disaster-recovery wizard, no release
company, no cloud operations, no QA lab, no Serva 1.0 acceptance suite.

The professional backup, restore, migration, new-machine bootstrap and automatic
requalification experience remains a required Serva 1.0 concern. It has not been forgotten and
it has not been built.

---

## Appendix — a process error worth recording

Two live runs were launched concurrently with their output redirected to the same file, and
the transcripts interleaved. The numbers could not be attributed to either run, so they were
discarded and the slice was re-run to a distinct path rather than reported.

It is recorded here because the same failure in a governed run — two writers, one artifact,
no way to tell afterwards which produced what — is precisely what the Store's transaction
model exists to prevent, and the tooling around it should hold to the same standard.
