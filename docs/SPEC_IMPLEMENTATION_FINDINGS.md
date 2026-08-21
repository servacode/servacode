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
