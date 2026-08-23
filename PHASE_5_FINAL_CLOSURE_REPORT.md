# SERVA CODE — PHASE 5 FINAL CLOSURE REPORT

Nine defects were raised. All nine are closed, and closing them found **four more** of the
same class that the audit had not seen — three of those found by a check written for the
audit's own requirement, which is the strongest argument for having written it.

| | |
|---|---|
| Tests before closure | 914 |
| Tests after closure | **940** |
| `npm run verify` | PASS — format, lint, typecheck, 38 files / 940 tests, build |
| Phase 4 semantics | unchanged |
| Phase 6 | not started |

---

## 1. Owner-decision binding

**The defect was worse than reported.** `approveChange` accepted any ANSWERED decision not
answered by an agent, and that was wrong in three independent ways: an old decision about
something else satisfied it, a decision raised merely to unblock a stalled department
satisfied it, and a decision on which the owner had chosen **"No"** satisfied it — because
approval was being inferred from prose, and `"No"` reads exactly like `"Yes"` to code that
cannot read English.

Three mechanisms replace it:

- **`OptionDisposition`** — every option carries `APPROVE | REJECT | DEFER | INFORM`, and
  Serva routes on that, never on the wording.
- **`DecisionPurpose` + `targetRef`** — a decision states what it is *for* and *about*, so
  consent is a statement about one named artifact rather than a free-floating "the owner
  said yes to something".
- **`approvalRefusal`** — requires all four together: raised as a change approval, names
  this change, the recorded answer is one of the options actually offered, and that option
  is an `APPROVE`.

`requestChangeApproval` is the only way to mint change consent, and **Serva writes it**. A
department that could author an `APPROVE` option could author its own approval, so every
model-supplied option is forced to `INFORM`.

`answerOwnerDecision` now refuses an option nobody offered, and refuses an agent answer at
the point of writing. The orchestrator still re-checks on resume — a single point of
enforcement is a single point of failure for the one rule separating a governed company
from a system that asks itself for permission. A test forges an agent answer directly into
the Store to prove the second door holds.

**Regressions:** unrelated decision → refused; wrong purpose → refused; REJECT → refused;
DEFER → refused; unoffered option → refused at answer time; agent answer → refused; exact
bound APPROVE → accepted.

## 2. Readiness derives its reviews from the Store

`assessReadiness` took an optional set of completed review criteria, and **the only caller
that ever supplied one was a test**. The E2E reached READY by handing readiness the answer,
while the production CLI — which passes no such set — could never reach READY at all. The
test and the product disagreed and the test was being believed.

The parameter is gone. There is no way for a caller to contribute an opinion.

Reviews are reconstructed from the immutable `CriterionEvaluation` records the Phase 2 gate
engine already persisted. For each required review, readiness proves from disk that it was
evaluated, on a **JUDGED** basis, by the **canonical independent reviewer**, with a **MET**
verdict, under a gate that **currently holds an accepting verdict**, over artifact versions
that are **still the current ones**.

The last two make a review perishable, which it must be. Re-entry drops the gate result and
the review stops counting; a new version of the reviewed artifact makes the acceptance a
statement about something that no longer exists.

For that to be checkable, a judgement now names its **subjects**: `SC-AGENT-072 accepted
SC-ARCH-000001 at version 2`, not merely "the architecture".

## 3. Canonical output authority, enforced at the write boundary

A department no longer receives a `Transaction`. It receives a **`ScopedCanonWriter`** whose
authorised types are fixed before the persist function runs a line, which refuses anything
else **at the call**, and which has **no `commit`** on it. Overreach is not a violation that
gets caught afterwards; it is an operation that does not exist.

```
committed artifact types  ⊆  DepartmentConfig.produces  ⊆  AgentContract outputs
```

All three links enforced, the last before the mutation. `validateDepartmentAuthority` runs
at orchestrator construction, so a misconfiguration is a startup failure naming the
department rather than a refusal discovered halfway through a paid run.

**The audit named two merged authorities. The check found two more.**

| Split | Was | Now |
|---|---|---|
| `140` / `141` | one run wrote classifications **and** the admin experience | 140 classifies what an operator may change; 141 designs how they change it |
| `210` / `211` | one run wrote the strategy **and** the cases | 210 says what must be verified; 211 writes the cases, with no implementation in context |
| `071` / `070` | the evaluator wrote the architect's ADRs | 071 compares candidates; 070 commits and states the reversal cost |
| `280` / `290` | *(my error)* the analyst wrote the curator's knowledge artifacts | 280 proposes improvements; 290 publishes cross-project knowledge |

The 071/070 split is the one worth reading twice. An evaluation compares candidates against
criteria fixed before scoring; an ADR commits the system to one and states what reversing
it costs. One actor doing both means the comparison and the commitment happen in the same
breath, and nothing independently asks whether the winner on points is right for *this*
architecture — a different question, and the one an architect exists to answer. `070` may
now choose a candidate that did not score highest, provided it says why: a stated reason to
override the scores is a decision, an unstated one turns the evaluation into theatre.

Each split narrowed the upstream output schema too, rather than leaving fields the runner
would ignore. A schema that keeps asking for something the department may not persist trains
the model to produce it and wastes the tokens producing it.

**The adversarial test** writes one authorised artifact and then one belonging to another
agent. The transaction commits **neither**, and a reopened Store shows no partial mutation.

## 4. A change cannot become IMPLEMENTED by claim

`completeChange` required only `state === APPROVED`. Since `outstandingChanges` ignores
IMPLEMENTED, approve-then-complete removed the readiness block while every artifact the
change invalidated was still standing — unrewritten, and now unguarded.

Re-entry is **recorded on the change** when applied: the work item, the entry stage, the
stages obliged, the gates invalidated. The process that applies re-entry is not the process
that later asks whether it happened, so the obligation has to be durable.

`completionRefusal` then proves all three from persisted state — re-entry applied, every
obliged stage completed again, every invalidated gate accepting the **new** evidence. That
last clause matters most: re-running a stage produces new artifacts, and the gate is what
says they are acceptable. A change that re-ran its stages and failed their gates has not
been carried through; it has been attempted.

## 5. Proposal acceptance resolves the owning authority

The rule was `acceptedBy !== origin`, which the security architect satisfies for a UX
designer's proposal — any passing agent could enlarge the product.

A proposal now names the canon family it would change, and the owning authority is resolved
from **the same contract output table the write boundary uses**: the agent whose contract
declares a family owns decisions about it. That is not a new rule invented for proposals —
it is the rule already enforced on every write, asked from the other direction.

A family no contract claims is **owner-reserved** rather than unowned. Somebody still has to
decide, and the somebody is the person paying.

## 6. Organizational learning on the governed substrate

`280`, `290` and `291` are now three departments on the same substrate as everything else,
so the runner enforces independence, provenance, context minimisation and write scope for
them too. **The wall does not move**: `leakageRefusal` still runs on every field at persist
time, because a governed run is still a model, and a model asked to generalise will
sometimes generalise a client's name into a shorter version of the client's name.

The write-authority check corrected my reading of the catalogue for the fourth time. I had
`280` producing lessons and failed approaches; `32` gives all three knowledge artifacts to
`290` and gives `280` `Proposal[]`. That division is better than mine — the analyst proposes
improvements to *this* project, which belong in the proposal lifecycle where an owning
authority must accept them.

The tests used `SC-AGENT-280` as the curator: the right behaviour under the wrong role.
Fixed. `patternUsageRefusal` now requires the assessment to come from `SC-AGENT-291` **and**
from someone other than the pattern's curator — a curator judging its own pattern is not a
second opinion.

## 7. Partial-stage restart

Progress was tracked by **stage**, which is too coarse for a stage with several departments.
When the requirements author completed and the NFR specialist timed out, the stage was
neither complete nor un-run, so a resume re-ran the author, wrote its canon a second time
and spent the money again. **The live suite had already produced that timeout**, so this had
a reproduction rather than a hypothesis.

`completedDepartments` is persisted the moment a department completes, not at the end of the
stage — a process that dies mid-stage must leave behind what it actually finished. Re-entry
clears the entries for stages it re-runs, resolved from the registered configuration rather
than a naming convention.

**Resume authority** is now defined. Three blockages look identical in the record and are
not: a transient failure, which retrying fixes; a refusal — not enabled, independence,
output authority — which will refuse identically and needs a configuration change; and a
gate FAIL, which needs different canon rather than another attempt. Retrying a refusal in a
loop is how an operator learns to ignore the reason.

## 8. Live proof obligations

The live suite contained `if (captures.length === 0) return;` while the case reported PASS.
A run where the network was down and a run where retrieval silently returned nothing
produced the same green tick — and the second is a defect the suite existed to catch.

Every obligation now records **PROVEN / BLOCKED / NOT_RUN**, and the ledger prints at the
end whatever happened. A suite may legitimately finish BLOCKED; it may not finish with an
obligation that was never classified, which is asserted.

The competitive chain is its own obligation (`RS-6`) and reports **BLOCKED**: the public
pages carry no competitor data, so the analyst produces nothing to build on and innovation
is refused for want of a prerequisite. Correct behaviour, and not a proof of the chain.

## 9. Git and report consistency

Addressed by construction: evidence is captured **after** the implementation commit, the
report names the actual baseline, and the package is built from a clean tree. See §14–15.

## 10. Required closure tests

| | Where |
|---|---|
| A. owner authority (7 cases) | `tests/intel.governance.test.ts` |
| B. readiness durability, no injected set | `tests/intel.restart.test.ts` |
| C. output authority + atomicity + restart | `tests/intel.writeauthority.test.ts` |
| D. separate 141 / 211 / 070 runs | `tests/intel.writeauthority.test.ts` |
| E. change completion (5 cases) | `tests/intel.governance.test.ts` |
| F. proposal authority (4 cases) | `tests/intel.governance.test.ts` |
| G. 290 curator, 291 assessor, self-assessment refused | `tests/intel.governance.test.ts` |
| H. partial-stage restart | `tests/intel.restart.test.ts` |

## 11. Acceptance

- `npm run verify` — **38 files, 940 tests**, green.
- The four deterministic E2E scenarios (A–D) — green.
- **The production CLI path, in a separate process**: the built CLI is invoked with only a
  directory on disk and produces READY and a Phase 4 handoff. No injection, no test-only
  path.

That last one found a real behaviour on its first run: five STALE blockers, because the
in-process tests read the Store with the same fixed clock that wrote it while the CLI uses
the system clock. The freshness rule was right and the fixture had rotted.

## 12–13. Verify

```
format:check  PASS
lint          PASS
typecheck     PASS
test          38 files, 940 tests
build         PASS
```

## 14–15. Baseline and Git state

See `evidence/BASELINE_COMMIT.txt` and `evidence/GIT_STATE.txt`. Working tree clean.

## 16. Remaining Critical/High issues

**None known.** Every defect found during closure was closed during closure, including the
four the audit had not seen.

Standing limitations, unchanged in kind from the Phase 5 report:

1. **8 of 19 canonical gates are undefined** — they guard Phase 4 and later stages. An
   undefined gate blocks rather than passes, so this is visible.
2. **Learning has no cross-project store.** The wall is implemented and tested; the shared
   library is a Phase 6 concern.
3. **Three artifact families have no owner in `32`** (SF-12) — the intake framing artifacts,
   `Feature`, and the computed `Risk` register. Recorded as explicit exceptions, each with a
   stated reason, enumerated by a test so the list can only grow deliberately.
4. **The competitive chain has never completed end to end against real sources** — reported
   as `RS-6 BLOCKED` rather than passing quietly.
5. **The 180-second per-run budget** is inherited from Phase 3 and is tight for some
   departments. Handled correctly when it fires; left alone because one observation is not
   enough evidence to choose a better number.

## 17. Phase 6 was NOT started

Confirmed. No VS Code UI, no dashboard, no conversational interface, no installer, no
bootstrap UX, no backup/restore, no migration UX, no disaster-recovery wizard, no release
company, no cloud operations, no QA lab, no Serva 1.0 acceptance suite.

The professional backup, restore, migration, new-machine bootstrap and automatic
requalification experience remains a required Serva 1.0 concern. It has not been forgotten
and it has not been built.

---

## Appendix — new specification findings

- **SF-12** — three artifact families have no owner in `32`.
- **SF-13** — `SC-AGENT-071` cannot record the decision it evaluates. The specification was
  right and the implementation was wrong.

Both in `docs/SPEC_IMPLEMENTATION_FINDINGS.md`. Neither was resolved by editing R4.

## Appendix — live result

Filled in below from the run made after these fixes.
