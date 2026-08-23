# SERVA CODE — PHASE 5 FINAL ACCEPTANCE REPORT

Two production-path defects were raised, plus package identity. All three are closed.

| | |
|---|---|
| Tests before | 987 (41 files) |
| Tests after | **1004 (43 files)** |
| `npm run verify` | PASS — format, lint, typecheck, 1004 tests, build |
| Focused acceptance | 159 tests across twelve intelligence suites |
| Implementation baseline | `5d26bbc` |
| Working tree | clean |
| Phase 6 | not started |

The previously accepted fixes are preserved. Nothing on the do-not-reopen list was
redesigned; two of them are touched only where the new control flow had to integrate, and
both changes are stated below rather than buried.

---

## 1. The governed proposal-ruling path

`acceptanceRefusal` was right about what acceptance requires and described something the
company could not do. There was no path from an ASSESSED proposal to a canonical decision
carrying a typed disposition, so the only way to produce one was to write it into the Store
by hand — which is exactly the bypass `ScopedCanonWriter` exists to make impossible.

A **Proposal Ruling** execution now exists, in `src/intelligence/proposalRuling.ts`. It is
a `DepartmentConfig` like any other, which is the point: the same enablement check, the same
independence check, the same ledger, the same run, the same scoped writer. Nothing about a
governance decision earns it a private path.

It is deliberately narrow in three ways:

- **No new sovereign agent.** The ruling is made by the canonical authority that already
  owns the canon the proposal would change — `SC-AGENT-020` for `ProductDecision`,
  `SC-AGENT-130` for `DesignDecision` — running under its own contract.
- **Not the department's ordinary run.** The Product Manager ruling on one proposal does not
  re-do product validation or rewrite the scope. The configuration declares **one** artifact
  family, so the run physically cannot touch anything else, and Product Validation's own
  `produces` is unchanged.
- **No second lifecycle.** No new proposal states and no new verdict vocabulary. The agent
  answers in the `OptionDisposition` Serva already routes on, and `accept()` reads the
  artifact afterwards exactly as it already did.

The caller says *which* proposal. `ruleOnProposal` has no disposition parameter, the persist
function reads the disposition only from validated structured output, and a test passes
`disposition: APPROVE` alongside a REJECT-scripted agent to prove REJECT is what gets
recorded.

Two refusals happen **before** the run, because paying for a ruling nobody could act on is
worse than not asking: an unassessed proposal, and a proposal whose only owning authority is
the proposer — which is an owner decision, not a self-approval with extra steps.

## 2. `ProductDecision` authority mapping

`OUTPUT_NAMES` in `src/intelligence/execution/authority.ts` did not map `ProductDecision`,
although `SC-AGENT-020`'s contract has always declared `ProductDecision[]`. The name
resolved to nothing, so the Product Manager's own decision family was outside its computed
authority and no department could declare it.

```ts
ProductDecision: ARTIFACT_TYPES.PRODUCT_DECISION,
```

The intersection rule means this widens nothing on its own: `allowedTypesFor` still takes
`declared ∩ contract`, and `productValidationDepartment.produces` does not list it. A test
asserts both — that the contract now permits it, and that the ordinary validation run still
does not.

## 3. APPROVE / REJECT / DEFER, through the governed path

`tests/intel.proposalruling.test.ts` — ten tests, none of which writes a decision by hand.

| Case | Result |
|---|---|
| APPROVE, exact proposal, governed run | decision persisted with `proposalRef` + `APPROVE` + run attribution; `accept()` → **ACCEPTED** |
| REJECT | acceptance refused; the proposal stays **ASSESSED** |
| DEFER | acceptance refused; `reevaluationTrigger` recorded |
| caller asks for APPROVE, agent says REJECT | **REJECT** is recorded |
| a non-owning department runs the identical configuration | refused at the write boundary, `not among its canonical outputs`, nothing persisted |
| the proposer rules on its own proposal | refused before dispatch |
| an unassessed proposal | refused before dispatch |
| process discarded, Store reopened | the ruling still resolves and still accepts |

The unit-level `acceptanceRefusal` regressions in `intel.governance.test.ts` are unchanged
and still seed decisions directly — they test the refusal logic, and are no longer the only
proof that the authority path exists.

One thing had to change for the ruling to be attributable: **`persist` now receives the run
id.** It is set by the runner immediately before the call and never by a caller, because the
run does not exist when the context is built. An artifact that cannot name the run that
produced it cannot be told apart from one somebody wrote by hand.

## 4. The research obligation consumer

`src/intelligence/execution/obligations.ts`. It is not a second scheduler: it owns no queue,
no state and no ordering. It reads the obligations already in the Store, dispatches the
canonical department through the **same `runDepartment`** every stage uses, resolves the
question with the canon that settled it, and folds what it ran into the orchestrator's
existing `completedDepartments` — so the main loop finds that department already done and
steps over it rather than running it twice.

The orchestrator calls it from two places, and both matter:

- **before the stage loop**, which is what makes a restart mid-obligation resume rather than
  deadlock on its own good bookkeeping;
- **immediately after a department stops for want of something it recorded**, then retries
  that department exactly once. If the obligation was discharged and it still cannot
  proceed, the honest answer is the block, not another attempt.

## 5. The exact request is consumed

`marketResearchDepartment.prepare()` composed its own generic `ResearchRequest` every time.
It now reads `ctx.obligation` and **consumes the exact request** — its question, its
permitted hosts, its source cap are the ones the gateway enforces. No substitute request is
written, and the requester's question is the one that gets answered.

The test asserts exactly one `ResearchRequest` exists at the end, that its question is the
requester's words, and that `dataAllowedToLeave` is empty.

Where the request permits no host, consumption **BLOCKS** naming the request and the
question. Nothing is captured, nothing is concluded, and the obligation stays OPEN. That
path is tested too.

`allowedHosts` on a raised obligation now comes from the deployment's configured research
seeds rather than being empty. That is a policy the installation sets, not something the
asking department chooses — and an empty list was making every obligation unfulfillable by
construction while looking like progress. The seeds moved to
`src/intelligence/research/seeds.ts` so the runner can read them without depending on a
department; `configureResearchSeeds` is re-exported from its old home and every existing
caller is unchanged.

## 6. Research `OpenQuestion` resolution

`state`, `answer` and `answeredAt` already existed and are simply used. One narrow field was
added — `resolvedByRefs` — because "this was answered" without the artifacts is a claim
rather than evidence. After a restart Serva distinguishes OUTSTANDING from FULFILLED by
reading `state`, and a reader follows the refs to the captures and findings that settled it.

## 7. The requester resumes

The runner now hands a department back the obligations **it** raised that somebody has since
discharged: the answer, plus the canon it points at, as context elements. This is the mirror
of the owner-answer mechanism and exists for the same reason — the process that asks a
question is not the process that resumes with the answer.

Without it the resumed department asks the identical question, the normaliser correctly
reports the obligation as already outstanding, and the lifecycle deadlocks on work that was
in fact completed.

## 8. The upstream obligation consumer

Same controller. It resolves the owing department from the registered configuration by the
canon family the question names, runs it, and resolves the obligation with what it wrote.
This is re-entry rather than a retry of the department that asked: re-running the requester
while the canon is still absent produces the same block, the same cost and the same
obligation, which is the difference between control flow and a loop.

Three things are refused rather than waited on, each with the real reason: canon owed by a
stage the active profile does not run, canon no registered department produces, and a
department that has already run and produced nothing that satisfies the question. None of
them becomes an owner decision, because asking the owner would be asking them to do Serva's
departmental work.

## 9. Upstream `OpenQuestion` resolution

Identical mechanism: `state: ANSWERED`, an answer naming the department and the run, and
`resolvedByRefs` pointing at the artifacts produced. The test asserts the refs equal the
`DATA_MODEL` ids actually in the Store.

## 10. The downstream department resumes

Proved in `tests/intel.obligations.test.ts`: the last run of `DEPT-REQUESTER` in the advance
is **COMPLETED**, no `OwnerDecisionRequest` exists, and the Data Architect ran **once** —
not once for the obligation and again in stage order.

## 11. Restart at the midpoint — research

The first process records the obligation and the researcher is dispatched and never answers.
That is the state a crash leaves: an obligation on disk and nothing in memory that knows
about it. A new process, a new engine, nothing carried but the Store.

The sweep finds the obligation, discharges it, and the requester resumes. Afterwards: one
`ResearchRequest`, one `OpenQuestion` — **the same id** the dead process left behind — now
ANSWERED with refs, and findings in the Store.

## 12. Restart at the midpoint — upstream

The same shape. After the restart there is one `DATA_MODEL`, one `OpenQuestion` (ANSWERED),
and exactly one run of `DEPT-DATA-ARCHITECTURE` in the resumed advance.

## 13. `npm run verify`

```
format:check  PASS
lint          PASS
typecheck     PASS
test          43 files, 1004 tests
build         PASS
```

Full output in `evidence/VERIFY.txt`. Focused acceptance — 159 tests across twelve
intelligence suites — in `evidence/OFFLINE_ACCEPTANCE.txt`.

No live run. Both defects are deterministic control and authority issues, and the network
path is proved with a governed fake retriever under the real gateway, which enforces
`allowedHosts` and `assertResearchAuthority` exactly as it does against a real one.

### One accepted invariant, restated rather than reopened

Research routing previously asked whether **this run** may retrieve:
`usesResearchGateway && contract.net && gateway !== undefined`. Under that rule a department
with no network could never route a question to research — and defect 2 requires precisely
that: a requester with no network, an obligation, and a separate authority that answers it.

So the question it asks changed, and the guarantee did not. It now asks whether **the
company** can lawfully answer by retrieval: a *registered* department declares research, its
canonical contract grants network scope, and a gateway exists. A gateway object alone still
grants nothing — the original defect — and the asking department still retrieves nothing and
could not if it tried, because `assertResearchAuthority` refuses it at the gateway.

The accepted test is unchanged and still passes; a second case was added beside it showing
the same department, the same question and the same gateway routing to research once a
researcher is registered, while capturing nothing itself.

## 14. Implementation baseline commit

**`5d26bbc`** — *true final closure: a ruling that can be made, and an obligation that gets
discharged*. It is the last commit that touches `src/` or `tests/`.

## 15. Report, evidence and package commits

| Commit | What it is |
|---|---|
| `5d26bbc` | **implementation baseline** — all `src/` and `tests/` changes |
| directly above it | **packaging commit** — this report, `evidence/`, and `MANIFEST.md`; no `src/` or `tests/` change |

Evidence was captured **after** `5d26bbc`, from that exact tree.
`evidence/BASELINE_COMMIT.txt`, `evidence/GIT_STATE.txt`, `MANIFEST.md` and this report all
name `5d26bbc` as the implementation baseline and describe the packaging commit the same way.
A reader can check the claim directly:

```
git diff --stat 5d26bbc..HEAD -- src tests    # empty
```

The previous package's inconsistency was real: its manifest named `b2396d9` as the packaged
tree, `BASELINE_COMMIT.txt` said `eaef376`, and the delivery message named later commits
still. It is fixed by making one commit the baseline and every artifact say so, not by
explaining the difference.

## 16. Clean Git status

`git status --porcelain` → empty at packaging. `evidence/GIT_STATE.txt` records the state at
capture time honestly: no `src/`, `tests/`, `docs/` or config file differs from the baseline,
and the evidence files themselves are shown separately as what that capture is writing.

## 17. Remaining Critical/High blockers

**None known.**

Standing limitations, unchanged:

1. 8 of 19 canonical gates are undefined — they guard Phase 4 and later stages; an undefined
   gate blocks rather than passes.
2. Learning has no cross-project store; the wall is implemented and tested.
3. Three artifact families have no owner in `32` (SF-12), recorded as enumerated exceptions.
4. The competitive chain has never completed live — the public pages carry no competitor
   data, reported as BLOCKED.
5. The 180-second per-run budget is inherited from Phase 3 and is tight for some departments.
6. Live obligation evidence is absent by model behaviour, as live routing evidence was: both
   are proved deterministically, branch by branch, with the real gateway and a fake retriever.
7. Only `ProductDecision` and `DesignDecision` are wired as proposal-ruling families, because
   they are the two `32` declares. A proposal affecting canon no enabled agent owns is an
   owner decision, which is the correct answer and is tested.

## 18. Phase 6 was NOT started

Confirmed. No VS Code UI, no dashboard, no conversational interface, no installer, no
bootstrap UX, no backup/restore, no migration UX, no disaster-recovery wizard, no release
company, no cloud operations, no QA lab, no Serva 1.0 acceptance suite.

The professional backup, restore, migration, new-machine bootstrap and automatic
requalification experience remains a required Serva 1.0 concern. It has not been forgotten
and it has not been built.
