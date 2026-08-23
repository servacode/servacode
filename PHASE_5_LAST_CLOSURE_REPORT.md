# SERVA CODE — PHASE 5 LAST CLOSURE REPORT

Two HIGH defects were raised. Both are closed, and closing the second surfaced a third
finding that the authority validator caught on its own.

| | |
|---|---|
| Tests before | 973 |
| Tests after | **987** |
| `npm run verify` | PASS — format, lint, typecheck, 41 files / 987 tests, build |
| Focused deterministic regressions | 142 across ten intelligence suites |
| Phase 4 semantics | unchanged |
| Phase 6 | not started |

The previously accepted fixes are preserved and untouched.

---

## 1. Typed Proposal authority disposition

`acceptanceRefusal` proved the run existed, completed, belonged to the owning authority,
was not the proposer's, and that **its immutable trace contained the proposal id**.

That last condition proves the run was *about* the proposal. It says nothing about what the
authority concluded. A completed Product Manager run that had recorded

> *"REJECT proposal SC-PROP-000001 — it dilutes the first release"*

satisfied every clause, and so did a run that merely had the proposal in its context bundle.
**The event, not the label** had been honoured; **the decision, not the mention** had not.

### The model

`ProductDecision` and `DesignDecision` already exist in `32` as the canonical record of what
an authority decided. Both gain two fields:

```ts
proposalRef?: Ref                       // which proposal this rules on
proposalDisposition?: OptionDisposition // APPROVE | REJECT | DEFER | INFORM
```

`OptionDisposition` is reused rather than a new verdict vocabulary invented — a second
taxonomy is a second thing to keep in step, and APPROVE/REJECT/DEFER already mean exactly
this. No parallel proposal lifecycle was created.

### Why it cannot be manufactured

The caller supplies a **decision id**, never a disposition. There is no
`{authorityRunId, disposition: "ACCEPT"}` to pass, because `accept` takes no disposition.

The durability guarantee comes from a boundary that already existed: the
**`ScopedCanonWriter` restricts `intel.productDecision` to the agent whose contract declares
it**. A decision artifact carrying a disposition therefore exists only because the owning
authority produced one through a governed run. Serva then verifies the decision names this
exact proposal, was recorded by an owning authority that is not the proposer, and is
attributed to a run that actually **COMPLETED**.

Owner-reserved proposals are unchanged: `PROPOSAL_APPROVAL` + exact target + typed APPROVE.

### Regressions

| # | Case | Result |
|---|---|---|
| 1 | completed owning-agent run merely mentions the proposal | **REFUSED** — there is nothing to pass; a run is not a decision |
| 2 | owning authority explicitly REJECTS the exact proposal | **REFUSED**, and the proposal stays ASSESSED |
| 3 | owning authority DEFERs | **REFUSED** |
| 4 | explicit typed APPROVE, exact proposal, governed run | **ACCEPTED** |
| 5 | APPROVE bound to another proposal | **REFUSED** |
| 6 | correct decision by a non-owning authority | **REFUSED** |
| 7 | proposer rules on its own proposal | **REFUSED** |
| 8 | close process, reopen Store | the disposition still resolves, with no chat history |

Two more the implementation invited: a ruling not attributed to a governed run, and a ruling
citing a run that **FAILED** — both refused. The old regression whose only proof was
`mentions: proposalId` is gone.

## 2. Routing is control flow

`normalizeOpenQuestions` classified correctly and the runner acted on exactly one branch. It
could report `EXISTING_STORE_FACT` — *"the answer is already in the Store"* — and then fail
without supplying it. It could report `RESEARCH` and schedule nothing. It could report
`UPSTREAM_DEPARTMENT` and produce no obligation. Every route but one collapsed into a
generic `FAILED`.

### 2A. Research authority

`canResearch: ctx.gateway !== undefined` was wrong. The orchestrator places **one gateway in
the context for the whole run**, so any department — a UX designer included — could claim a
research route merely because the project has a research capability at all.

Authority now requires all three of the things the gateway itself checks:

```ts
config.usesResearchGateway === true
  && parseToolSurface(contract).net
  && ctx.gateway !== undefined
```

`assertResearchAuthority` is untouched and still refuses at the point of retrieval. This
only stops Serva *routing* a question somewhere it could never be answered.

### 2B. `EXISTING_STORE_FACT`

The exact artifact is read from the Store, bound into the context as one element, and the
department runs **once** more. `MAX_FACT_ATTEMPTS` is 2: a run that asks the same question
after being handed the answer fails explicitly, naming the fact it was given, rather than
looping. Only the artifacts the questions actually named are supplied — no whole-Store
widening — and the retry's diagnostics are prepended with the first attempt's, so the trace
says a question was asked, what was supplied, and that a second attempt happened.

A question is not classified `EXISTING_STORE_FACT` unless Serva can name the artifact.

### 2C. `RESEARCH`

Becomes a real obligation: a canonical `ResearchRequest` plus an `OpenQuestion` with
`askedOf: RESEARCH` linking to it. The asking department retrieves nothing and cannot — its
granted policy has no network — and `dataAllowedToLeave` is empty, so nothing about the
project leaves in the asking. The research department finds the request on its own stage and
the requester later resumes from persisted evidence.

Where research capability is absent, the route is never labelled `RESEARCH`: it falls to the
owner, which is the honest result.

### 2D. `UPSTREAM_DEPARTMENT`

Records an `OpenQuestion` with `askedOf: UPSTREAM_DEPARTMENT` naming the missing canon
family, the stage that owes it, the department that asked, the originating run, the source
fields and the work item. Ownership is resolved from the **registered configuration** — a
naming convention would be a second source of truth about who produces what.

Two contradictions are reported rather than waited on: canon owed by a stage the active
profile does not run, and canon no registered department produces. Neither becomes an owner
question, because asking the owner would be asking them to do Serva's departmental work.

### 2E. `ALREADY_ANSWERED` / `ALREADY_ROUTED`

No duplicate is ever created. When *every* question a run raises is already settled or
outstanding, the run receives an explicit bounded failure saying it did not use the
authoritative context it was given — rather than a quiet retry. The Store stays
authoritative.

### 2F. Restart durability

`OpenQuestion` and `ResearchRequest` are canon, and the normaliser reads outstanding
obligations before routing. A reopened Store **finds** the obligation instead of raising a
second, proved by a test that runs the department, discards the process, reopens from disk
and re-runs: one research request, one open question, and an explicit "already outstanding".

### A third finding

Making `OpenQuestion` writable by any department — it is governance, like an owner decision —
made `DEPT-INTAKE`'s beyond-contract exception for it redundant. The authority validator said
so immediately and by name. That is the fourth time that check has corrected something
nobody had gone looking for.

## 3. Required tests

| | Test | Suite |
|---|---|---|
| A | fact supplied, bounded retry succeeds, no owner asked | `intel.routing.test.ts` |
| B | asks again after being given it → explicit failure, no loop | `intel.routing.test.ts` |
| C | global gateway grants an ordinary department nothing | `intel.routing.test.ts` |
| D | governed research obligation recorded; department retrieves nothing | `intel.routing.test.ts` |
| E | upstream obligation names family, stage, asker; contradictions reported | `intel.routing.test.ts` |
| F | route persisted, process discarded, Store reopened, no duplicate | `intel.routing.test.ts` |
| G | same question either field → same operational route; both fields → one obligation | `intel.routing.test.ts` |

## 4. Focused results

```
intel.routing.test.ts        10
intel.questions.test.ts      15
intel.governance.test.ts     49
intel.ownervalue.test.ts      4
intel.authority.test.ts      20
intel.restart.test.ts        10
intel.writeauthority.test.ts 15
intel.e2e / scenarios / security  19
                            ----
                            142   all passing
```

Scenarios A–D and the restart/CLI acceptance are unchanged and green: readiness reaches
READY with nothing injected, and the real Phase 4 factory accepts the generated work item.

## 5. `npm run verify`

```
format:check  PASS
lint          PASS
typecheck     PASS
test          41 files, 987 tests
build         PASS
```

No live model time was spent. Both fixes are deterministic authority invariants, and the
network routing is proved with the governed offline retriever — a live run would have cost
money to observe nothing the fake does not show.

## 6. Implementation commit and Git state

Implementation: **`52e9557`** — *last closure: typed proposal rulings, and routing that acts*.
This report is `e68dd24`. Evidence was captured **after** the implementation commit and
committed separately, because a file cannot record its own hash.

`git status --porcelain` → empty. Branch `phase-5-company-intelligence`.

## 7. Remaining Critical/High blockers

**None known.**

Standing limitations, unchanged:

1. 8 of 19 canonical gates are undefined — they guard Phase 4 and later stages; an undefined
   gate blocks rather than passes.
2. Learning has no cross-project store; the wall is implemented and tested.
3. Three artifact families have no owner in `32` (SF-12), recorded as enumerated exceptions.
4. The competitive chain has never completed live — the public pages carry no competitor
   data, reported as BLOCKED.
5. The 180-second per-run budget is inherited from Phase 3 and is tight for some departments.
6. Live routing evidence is absent by model behaviour: across seven live runs the model
   escalated in four. Routing is proved deterministically, branch by branch.

## 8. Phase 6 was NOT started

Confirmed. No VS Code UI, no dashboard, no conversational interface, no installer, no
bootstrap UX, no backup/restore, no migration UX, no disaster-recovery wizard, no release
company, no cloud operations, no QA lab, no Serva 1.0 acceptance suite.

The professional backup, restore, migration, new-machine bootstrap and automatic
requalification experience remains a required Serva 1.0 concern. It has not been forgotten and
it has not been built.
