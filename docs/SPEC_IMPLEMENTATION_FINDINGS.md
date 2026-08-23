# SPEC_IMPLEMENTATION_FINDINGS

Defects and gaps in the **BASELINE R4** specification, discovered by implementing it.

Each finding was found because the implementation refused to proceed without an
answer the specification does not give. None was resolved by editing R4: the
specification is unchanged since `d528cf5` and its tree hash is unmodified. Each is
resolved in code by a **stated, total rule** in the style `32` §8.2 already uses, and
each is proposed here as an R5 amendment for owner approval.

The bar for adding a rule here was: *the specification asks for a value, the stated
resolution does not produce one for every agent, and inventing content would be worse
than deriving it from something the specification does require.*

---

## SF-1 — `responsibilities` is not resolvable for 13 of 55 contracts

**Where:** `32` §9.3 lists `responsibilities` as a per-contract `LOCAL` field verified
by `DC-29`. `32` §8.2 row 10 says `LOCAL`, "Every contract".

**Actual:** 13 contract blocks state no `Responsibilities:` line. They carry a
`Kept separate from ... because:` line instead, which is the Agent Existence Test
justification of §9.1 — a different field with a different purpose.

Affected: `SC-AGENT-060, 061, 062, 071, 082, 123, 131, 133, 170, 181, 191, 211, 271,
291` (14 blocks; 13 distinct plus 291).

**Why it matters:** the claim "every contract resolves every field" is false as
stated. A validator that trusted §9.3 would pass; one that checked would fail.

**Resolution in code (`R-RESP`):**

> Where a contract block states no `Responsibilities` line,
> `responsibilities := outputs`.

Total over `30` §4, because `DC-29`/`DC-30` require `Outputs` on every block, and all
55 have one. It invents nothing: an agent's responsibility is to produce its declared
outputs. Emitted with resolution kind `DERIVED(R-RESP)`, so the derivation is visible
in the artifact rather than hidden.

**Proposed R5:** either add the 13 missing lines, or add `R-RESP` to §8.2 row 10.

---

## SF-2 — `filesystem_scope` has no resolution for 4 contracts

**Where:** `32` §8.2 row 16 gives two resolutions: `LOCAL`, or
`INHERITED(T-PRODUCTION|T-ASSURANCE)`.

**Actual:** `SC-AGENT-110, 251, 260, 270` state no `FS:` segment and inherit no `T-`
tier block. Neither stated resolution applies, so the rule is not total — which
`CR-R3` requires it to be.

**Resolution in code (`R-FS`):**

> Where neither `LOCAL` nor a tier block supplies it, `filesystem_scope := NONE`.

`NONE` is the only safe default, and it matches `network_scope`'s inherited default in
`A-ALL`, which exists for the same reason. An over-granted scope is a capability
defect; an under-granted one is a visible escalation. Emitted as `DERIVED(R-FS)`.

**Proposed R5:** add `R-FS` to §8.2 row 16, or add the four missing `FS:` segments.

---

## SF-3 — `A-VERIFIER` does not state `review_responsibilities` under that name

**Where:** `32` §8.2 row 26: "`INHERITED(A-<ARCHETYPE>)`; `LOCAL` for verifiers —
`A-VERIFIER` defines the obligation".

**Actual:** the `A-VERIFIER` block (§3) states the obligation under
`Required output (additional):` — "what was checked, what was not checked and why,
findings with severity, evidence references, verdict with basis". No verifier contract
block carries a `Reviews:` line, so the "LOCAL for verifiers" half does not hold
either. Affects the 13 VERIFIER agents.

**Resolution in code:** `review_responsibilities` is read from where the block actually
states it — `A-VERIFIER.Required output (additional)` — and emitted as
`INHERITED(A-VERIFIER)`. No content invented.

**Proposed R5:** rename that line in `A-VERIFIER`, or amend row 26 to point at it.

---

## SF-4 — the AgentRun event vocabulary records what a run SAW but not what it COULD DO

**Where:** `05` §4.2 fixes the event type set: `RUN_CREATED`, `CONTEXT_BOUND`,
`RUN_STARTED`, `TOOL_REQUESTED`, `TOOL_DECIDED`, `TOOL_RESULT_CAPTURED`,
`EVIDENCE_CAPTURED`, `OUTPUT_RECEIVED`, `VALIDATION_RESULT`, `SCOPE_COMPUTED`,
`CONSUMPTION_SAMPLED`, and the three terminal events.

**Gap:** `CONTEXT_BOUND` makes "what did run X see?" answerable, which `19` CX-5
requires. Nothing makes **"what was run X allowed to do?"** answerable. The resolved
`ToolPolicy` is a governance decision the runtime takes *before* invocation, exactly
like the context binding, and `19` §5 makes it the primary enforcement boundary — the
one `19` §4.2 says trust marking is only defence in depth *for*. `TOOL_REQUESTED` and
`TOOL_DECIDED` record what happened afterwards, which is not the same fact: a run that
made no tool call leaves no record of what it was permitted to call.

**Resolution in code:** one event type added, `CAPABILITY_BOUND`, carrying the allow
list, deny list, filesystem scope, network scope, call ceiling and the rationale.
Appended immediately after `CONTEXT_BOUND`.

**This is the one place Phase 3 extends a closed R4 vocabulary.** It is recorded here
rather than absorbed silently, because a closed set that quietly grows is no longer a
closed set.

**Proposed R5:** add `CAPABILITY_BOUND` to the `05` §4.2 type list.

---

## SF-5 — section headings in `32` are not in numeric order

**Where:** `32_AGENT_CONTRACT_CATALOG.md` orders its headings §1–§5, §8, §9, §6, §7.

**Why it matters:** minor, but it is a live trap for any generator. A parser that
bounds the contract section by searching forward for `## 6.` swallows §8 and §9 into
the last contract block — which is exactly what happened here, and it produced a
contract that silently absorbed the resolution matrix. The generator now bounds on the
next `## ` heading and does not depend on the ordering.

**Proposed R5:** reorder the headings, a documentation-control fix (`29`).

---

## Non-findings

Two things looked like defects and were not, and are recorded so the next reader does
not re-open them:

- **`RunOutcome` has no `TIMEOUT`, `ABORTED` or `BUDGET_EXCEEDED`.** That is correct.
  `05` §7 folds all three into `FAILED` ("execution error (engine, tool, timeout)"),
  and `05` §4.2 keeps the cause visible through the distinct terminal events
  `RUN_TIMEOUT` and `RUN_ABORTED`. Outcome and cause are two axes on purpose; the
  implementation maps to both rather than inventing a tenth outcome.
- **`30` §3 has six tiers, not five.** An early schema capped `tier` at 5. The
  specification is right; the schema was wrong and is fixed.

---

# Phase 5 findings

Six more, found the same way: the implementation of company intelligence refused to
proceed without an answer R4 does not give. As before, none was resolved by editing the
specification.

---

## SF-6 — `03` §7 states lifecycle profiles in prose the stage table cannot express

**Where:** `03_PROJECT_LIFECYCLE.md` §7 gives each profile a stage selection, and two
entries are not stage lists: `045 + root-cause record` names a stage AND an obligation,
and `013 or targeted research` names an alternative.

**Why it matters:** a generator that keeps only the parseable stage numbers silently
drops both. The obligation disappears, the alternative becomes a single fixed choice,
and the profile means less than the specification says while looking complete.

**Resolution in code:** `resolveApplicability` returns a TOTAL plan — every one of the
26 stages carries a disposition, never an omission — and the unparsed prose terms are
surfaced as `proseObligations` on the plan rather than discarded. The catalogue
generator records them in `unparsedStageTerms`.

**Proposed R5:** give the two prose entries a structured form — an `obligations` column
and an `alternatives` column — so a profile is machine-readable without losing what it
says.

---

## SF-7 — a stage may be selected by a profile with no department able to run it

**Where:** `03` §4 defines 26 stages; `06` defines the departments. Nothing in R4
states what happens when a profile selects a stage the build cannot execute.

**Why it matters:** the tempting behaviour is to skip it and continue, which lets a
lifecycle report COMPLETE while stages the profile selected never ran. That is the
"looks finished, was not" failure the ledger exists to prevent.

**Resolution in code:** an unwired stage BLOCKS, with a reason naming the stage and the
profile that selected it. The orchestrator does not treat "nobody implemented this" as
"this did not apply".

**Proposed R5:** state the rule in `03` §4 — a selected stage with no executor is a
BLOCKED lifecycle, not a SKIPPED stage.

---

## SF-8 — `31` §4 does not say whether a gate evaluates when its stage failed

**Where:** the gate vocabulary defines `NOT_VERIFIED`, and `03` makes gates follow
stages. R4 does not say what happens to the gate when the stage before it could not
produce its evidence.

**Why it matters:** blocking before the gate leaves no verdict in the record at all, so
"the evidence says no" and "there was no evidence" become indistinguishable — and
readiness, which blocks on gate verdicts, has nothing to block on.

**Resolution in code:** the gate evaluates either way. A department that could not
produce its evidence has not made the gate irrelevant; it has given the gate its
answer, and the answer is `NOT_VERIFIED`. The department's own reason is recorded
alongside the verdict: the verdict says what is missing, the reason says why.

**Proposed R5:** state in `31` §4 that a gate guarding a failed stage is evaluated and
returns `NOT_VERIFIED` rather than being skipped.

---

## SF-9 — `SC-POL-013` mandates impact dimensions but not which stage owns each

**Where:** `SC-POL-013` requires every change to be assessed against fourteen
dimensions. `03` §6 requires re-entry at the earliest affected stage. Neither states the
mapping between them.

**Why it matters:** without a mapping, re-entry can only be "everything from here
onward" — which re-runs market research because the requirements changed, and bills a
second project to the same client. With an unstated mapping, two implementations
disagree about what a change costs.

**Resolution in code:** an explicit `DIMENSION_STAGES` table, plus a validation that an
affected dimension may not name a stage EARLIER than the re-entry point — which would
mean affected canon that never gets re-derived. Stages Serva computes rather than
reasons about (risk) are always re-derived, because doing so is free and not doing so
leaves a register describing a product that has since changed.

**Proposed R5:** publish the dimension→stage mapping in `SC-POL-013`.

---

## SF-10 — the canonical id pattern excludes digits from a prefix

**Where:** `08` §3 fixes the id form as `SC-<PREFIX>-<SUFFIX>` with an alphabetic
prefix.

**Why it matters:** it is right, and it is worth recording that it was tested. The
accessibility artifact wanted `SC-A11Y-…`, which the pattern rejects. Widening the
pattern to admit it would have made every id harder to recognise as canon for the sake
of one abbreviation.

**Resolution in code:** the prefix is `SC-ACCESS`. The pattern is unchanged.

**Proposed R5:** none. This is the specification working.

---

## SF-11 — R4 gives research no retriever, and Serva needs exactly one

**Where:** `11` and `16` require external research to be captured, hashed and expiring.
`19` gives agents no network. Nothing states where retrieval actually happens.

**Why it matters:** the gap is load-bearing. If retrieval belongs to the agent, the
agent needs a network tool, and `19`'s `NEVER_AVAILABLE` becomes a fiction. If it
belongs to Serva, some component has to open the connection and R4 does not name one.

**Resolution in code:** a single retriever behind the research gateway
(`research/http.ts`). Agents keep `network: NONE` in their granted policy — including
the Market Researcher, whose contract declares network scope purely to authorise Serva
to retrieve on its behalf. It refuses redirects to another host, because a redirect is
the approved host asking us to consult one nobody approved.

**Proposed R5:** name the research gateway as the sole egress point in `11`, and state
that a contract's network scope authorises Serva's retrieval rather than the agent's.

---

## SF-12 — three artifact families have no owner in `32`

**Where:** `32` states each contract's `outputs` as a human list. Cross-referencing every
Phase 5 department against those lists leaves three groups that no contract claims.

**Why it matters:** the implementation now enforces *committed types ⊆ declared outputs ⊆
contract outputs* at the write boundary, so an artifact nobody is authorised to produce is
an artifact that cannot be written. Three families would have made the whole upstream
lifecycle unrunnable:

- **the intake framing artifacts** — `ClientInput`, `ProjectGoal`, `Constraint`,
  `OpenQuestion`. Every later stage depends on them, and no contract lists them.
  `SC-AGENT-020`'s outputs begin at `ProductScope`.
- **`Feature`** — `SC-AGENT-020` is authorised for `ProductScope` (the scope a feature sits
  in) and `FeaturePriority[]` (the priority it carries), but not for the feature itself.
- **`Risk`** — only `ResidualRisk` appears, under `SC-AGENT-090`. The risk register Serva
  aggregates from persisted canon is not agent output at all: no model call produces it.

**Resolution in code:** `DepartmentConfig.producesBeyondContract`, an explicit list where
each entry states why. It is not a loophole: an entry with no reason is refused, an entry
for something the contract *does* authorise is refused, and a catalogue test enumerates the
whole set — so it can grow, but only in a diff somebody has to read.

**Proposed R5:** add the framing artifacts to whichever contract owns stage 002, name
`Feature` in `SC-AGENT-020`'s outputs, and state that Serva-computed aggregates such as the
risk register are `SYSTEM`-authored rather than belonging to any agent.

---

## SF-13 — `SC-AGENT-071` cannot record the decision it evaluates

**Where:** `32` gives `TechnologyEvaluation[]` to `SC-AGENT-071` and `ADR[]` to
`SC-AGENT-070`.

**Why it matters:** found by the write-authority check rather than by reading, which is the
point of having the check. The technology department was running as `SC-AGENT-071` and
writing both — the same defect the audit identified in `140`/`141` and `210`/`211`, in a
third place nobody had looked.

It is also the right rule. An evaluation compares candidates against criteria fixed before
scoring. An ADR commits the system to one and states what reversing it will cost. One actor
doing both means the comparison and the commitment happen in the same breath, and nothing
independently asks whether the winner on points is right for *this* architecture — a
different question, and the one an architect exists to answer.

**Resolution in code:** `DEPT-ARCH-DECISION`, a second governed run at stage 023 by
`SC-AGENT-070`, reading the persisted evaluations. It may choose a candidate that did not
score highest provided it says why, because a stated reason to override the scores is a
decision and an unstated one turns the evaluation into theatre.

**Proposed R5:** none. The specification was right and the implementation was wrong.
