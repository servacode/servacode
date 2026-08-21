# 31 — RESULT AND VERDICT TAXONOMY

**Document ID:** SC-DOC-031
**Status:** BASELINE R4
**Type:** Normative / Vocabulary
**Derived:** YES — added in Audit R2 (Correction 6).
**Owns:** Every outcome vocabulary in Serva Code, their boundaries, the mapping between them, **the canonical gate-composition algorithm**, and **the canonical validity-derivation model**.
**Supersedes as authority:** verdict value lists previously stated in `16` §5, `18` §4.1, `26` §2.1 and `27` FR-6.2.

**Why this document exists:** Audit R2 found `27` claiming "all eight verdict values", `18` defining six gate verdicts, and `16` defining a further six-value evidence vocabulary. The word *verdict* was doing four different jobs. This is not a counting error — it is a modelling error, and it would have produced four incompatible state machines in implementation.

---

## 1. The Root Cause

R1 mixed **criterion-level values** into the **gate verdict** enumeration. `WAIVED` and `JUDGED` are properties of *one criterion*; `PASS` and `FAIL` are properties of *a whole gate evaluation*. Listing all eight together made the vocabulary look like one state machine when it was two.

R2 separates five distinct vocabularies, each with its own subject, producer and lifecycle.

| # | Vocabulary | Subject | Produced by | Lifetime |
|---|---|---|---|---|
| V1 | **CriterionResult** (+ basis) | One gate criterion | Gate engine | Per evaluation, immutable |
| V2 | **ValidityState** | Any validity-bearing record (Evidence, GateResult, ArtifactVerifierResult) | Derived projection | Recomputed continuously |
| V3 | **GateVerdict** | One gate evaluation | Gate engine | Per evaluation, immutable |
| V3b | **ArtifactVerifierResult** | One artifact, judged by a VERIFIER agent | VERIFIER agent | Per evaluation, immutable |
| V4 | **RunOutcome** | One agent run | Runtime | Terminal, immutable |
| V5 | **ProcessState** | Work items, workflows, stages, proposals, escalations | Orchestrator | Mutable until terminal (V5d is immutable) |

**Rule TX-1:** the term *verdict* is reserved for **V3** and **V3b**. It MUST NOT be used for V1, V2, V4 or V5.

**Rule TX-1b (R3):** `EvidenceState` is **not** a vocabulary. The name is **historical** — it appears in this set only in descriptions of the R2 defect, never as a current type. It is `ValidityState` (V2) applied to an `Evidence` record. R2 defined it as its own six-value list, which invited a second, divergent validity model for gate results — the exact defect Audit R3 found in `08`, `16` and `18`. There is one validity model (§3).

---

## 2. V1 — CriterionResult

The outcome of evaluating **one** criterion within a gate.

| Value | Meaning |
|---|---|
| `MET` | The criterion is satisfied |
| `NOT_MET` | The criterion is proven unsatisfied |
| `INDETERMINATE` | Cannot be determined — evidence absent, stale, expired, or a tool was unavailable |
| `NOT_APPLICABLE` | The criterion does not apply, with a recorded reason |
| `WAIVED` | Unsatisfied but covered by an active, unexpired waiver (`09` §9) |

Each result additionally carries a **basis**, which is a separate axis and not a value:

| Basis | Meaning | Permitted when |
|---|---|---|
| `MEASURED` | Determined from `EXECUTION`, `OBSERVATION` or `ARTIFACT` evidence (`16` §3) | Always preferred |
| `JUDGED` | Determined by a VERIFIER agent against named criteria | Only where the criterion declares no stronger class is obtainable |
| `DERIVED` | Computed from stored state by a runtime checker | Structural criteria (traceability, staleness, separation) |

**Rule TX-2:** `JUDGED` is a *basis*, never a result value. R1 treated it as a verdict, which made "judged" and "proven" indistinguishable at the point where the distinction matters most.

**Rule TX-3:** a criterion whose declared minimum evidence class is obtainable but absent yields `INDETERMINATE` with basis `MEASURED`, never `MET` with basis `JUDGED`. An agent's opinion cannot substitute for a measurement that could have been taken (`16` §3.1).

**Rule TX-3b (R3):** `INDETERMINATE` carries a mandatory `reason` from a closed set, because gate composition (§4.1) routes on it:

| `reason` | Meaning | Composes to |
|---|---|---|
| `EVIDENCE_ABSENT` | Required evidence was never produced | `NOT_VERIFIED` |
| `EVIDENCE_INVALID` | Evidence exists but its `ValidityState != VALID` (§3) | `NOT_VERIFIED` |
| `TOOL_UNAVAILABLE` | The producing runtime component could not run (`22` DG-1) | `NOT_VERIFIED` |
| `PRECONDITION_ABSENT` | The criterion could not be evaluated at all — an input artifact or upstream result does not exist | `BLOCKED` |
| `AUTHORITY_REQUIRED` | Resolution needs an authority above the gate (`09` §2, `28` §4) | `ESCALATED` |

Without this closed set, `NOT_VERIFIED`, `BLOCKED` and `ESCALATED` could not be distinguished mechanically, and the gate algorithm would need to guess.

### 2.1 CriterionEvaluation record

The persisted form of a criterion result. Canonical entity in `08` §3.7; `T-TRACE`, immutable.

```
CriterionEvaluation {
  id                : SC-CE-<seq>
  gate_result_ref   : SC-GR-<id>
  criterion_ref     : criterion id within the gate definition
  value             : CriterionResult          # V1
  basis             : MEASURED | JUDGED | DERIVED
  reason            : INDETERMINATE reason (required iff value = INDETERMINATE)
  severity          : BLOCKING | MAJOR | ADVISORY   # from the gate definition
  evidence_refs     : SC-EV-<id>[]
  waiver_ref        : PolicyWaiver ref (required iff value = WAIVED)
  judged_by         : { role, criteria_applied[], confidence }  (required iff basis = JUDGED)
  artifact_versions_evaluated : [ {artifact_id, version, digest} ]
  evaluated_at
}
```

---

## 3. V2 — ValidityState (canonical validity model)

**One model, applied to every validity-bearing record.** R2 left three divergent versions of this concept: `EvidenceState` here, a stored `freshness` field in `16` and `18`, and an outright mutation `v.freshness := STALE` in `08` §6.3. The last two also mutated immutable `T-TRACE` records, contradicting `SC-POL-022`.

### 3.1 Subjects and values

`ValidityState` is derived for `Evidence`, `GateResult`, `ArtifactVerifierResult`, `CriterionEvaluation`, and any `T-DERIVED` view built from them.

| Value | Meaning | Applies to |
|---|---|---|
| `VALID` | Usable now | all |
| `STALE` | A covered artifact version changed (`SC-POL-031`) | all |
| `EXPIRED` | Time-bound validity elapsed | all |
| `REVOKED` | A revocation record exists | all |
| `DISPUTED` | An open dispute record exists | all |
| `INADMISSIBLE` | Provenance missing or malformed | **`Evidence` only** |

**Why one enumeration and not two** — the question Audit R3 asks explicitly. A `GateResult` and an `Evidence` record decay for exactly the same reasons: a covered artifact changed, a clock passed, or someone recorded a revocation or a dispute. Only `INADMISSIBLE` differs, and it differs by *inapplicability*, not by semantics — a `GateResult` is produced by the deterministic gate engine, which has no provenance to malform. A second enumeration would duplicate five of six values and guarantee eventual divergence, which is the defect this section exists to remove.

`INADMISSIBLE` on a non-`Evidence` subject is a store integrity error (`08` `KI-2c`).

### 3.2 Derivation — the only definition

`ValidityState` is **never stored as a mutable field**. It is computed by `SC-RTC-004` from immutable inputs:

```
validity(record) :=
    if exists Revocation(record)                          -> REVOKED
    if exists open Dispute(record)                        -> DISPUTED
    if record is Evidence and provenance incomplete       -> INADMISSIBLE     # 16 PV-2
    if record.valid_until is set and now > record.valid_until  -> EXPIRED
    if any a in record.artifact_versions_covered
       where currentVersion(a.artifact_id) != a.version    -> STALE
    if any d in record.depends_on
       where validity(d) != VALID                          -> STALE           # propagation
    else                                                   -> VALID
```

The inputs are exactly the five the audit requires: the immutable source record, artifact versions, time, revocation/dispute events, and the dependency graph.

- **VD-1** No `T-TRACE` record may carry a stored `validity`, `freshness`, `state` or equivalent mutable field. Violation is `KI-1b` (V1).
- **VD-2** Validity is recomputed on artifact change, on clock crossing, on revocation/dispute append, and before every gate evaluation (`XC-1`).
- **VD-3** Validity **propagates**: a record depending on a non-`VALID` record is itself `STALE`. This expresses the R1 staleness cascade without mutation.
- **VD-4** Only `VALID` records may support a `MET` criterion result.
- **VD-5** `FRESH` is **not** a value in this or any canonical vocabulary. It was retired in R3; `VALID` replaces it everywhere. Unrelated uses of the English word (`19` session policy) were renamed to remove the collision.

**Rule TX-4:** only `VALID` evidence may support a `MET` result. Every other state yields `INDETERMINATE` with reason `EVIDENCE_INVALID`, and the state is reported — so the owner can distinguish "never verified" from "verified, now stale" from "verified, then revoked". Three situations, three different remedies.

---

## 4. V3 — GateVerdict

The outcome of a whole gate evaluation. **This is the only vocabulary the word "verdict" names at gate level.**

| Value | Meaning | Effect |
|---|---|---|
| `PASS` | Every applicable criterion `MET` with basis `MEASURED` or `DERIVED` | Transition authorized |
| `PASS_WITH_QUALIFICATION` | Every applicable criterion `MET`, `NOT_APPLICABLE` or `WAIVED`, but at least one is `JUDGED`-basis or `WAIVED` | Authorized; qualifications propagate and appear at release |
| `FAIL` | A `BLOCKING`-severity criterion is `NOT_MET` | Rework path |
| `NOT_VERIFIED` | A `BLOCKING`-severity criterion is `INDETERMINATE` | Blocks; never rendered as PASS |
| `BLOCKED` | A precondition for evaluating the gate is absent | Resolve dependency |
| `ESCALATED` | Evaluation requires authority above the gate | Route per `09`/`28` |

**Cardinality: 6.** `WAIVED` and `JUDGED` are **not** gate verdicts — that was the R1 error. A gate containing a waived criterion returns `PASS_WITH_QUALIFICATION`, and the waiver appears in the qualification list.

### 4.1 Composition — the canonical algorithm

> **This document owns executable gate-composition semantics.** `18` §4 references this algorithm and MUST NOT restate it (`SC-POL-025`). R2 maintained two divergent versions; R3 removed one; R4 closed the `MAJOR` + `INDETERMINATE` hole.

`evaluateCriterion()` returns a **`CriterionEvaluation`** (§2.1) carrying V1 value, basis, reason and severity. It never returns a `GateVerdict`. Composition is the only place gate-level values appear.

#### 4.1.1 Severity disposition table — normative

Severity and criterion value together determine the contribution. **This table is total**: every (severity, value) pair has a defined disposition. R3 left `MAJOR` + `INDETERMINATE` undefined, and it fell through to an unqualified `PASS` — the defect Audit R4 found.

| Severity | `NOT_MET` | `INDETERMINATE` | `WAIVED` | `MET` | `NOT_APPLICABLE` |
|---|---|---|---|---|---|
| `BLOCKING` | `FAIL` | `NOT_VERIFIED` | qualifies | contributes `PASS` | inert |
| `MAJOR` | `FAIL` (unless waived) | **`PASS_WITH_QUALIFICATION` + `UNVERIFIED_ASPECT`** | qualifies | contributes `PASS` | inert |
| `ADVISORY` | finding only — no verdict change | finding only — no verdict change | qualifies | contributes `PASS` | inert |

**Why `MAJOR` + `INDETERMINATE` is not `FAIL`.** Absence of evidence is not proof of non-compliance. Rendering it `FAIL` would blame the artifact for a gap in verification, and would make "we could not check" indistinguishable from "we checked and it is broken" — destroying the very distinction `NOT_VERIFIED` exists to preserve (`SC-POL-005`).

**Why it is not an unqualified `PASS` either.** A `MAJOR` criterion is one whose failure would matter. Not knowing whether it holds is a material gap, and it must travel with the verdict, appear at release, and be visible to the owner (TX-7, TX-8).

**The one case where absence *is* failure:** a criterion that explicitly tests for existence — "a threat model exists", "a rollback test was executed" — declares `tests_existence: true` and `on_missing_evidence: NOT_MET` (`18` §2.1). For those, absent evidence *is* the proven negative, and the criterion resolves `NOT_MET`, not `INDETERMINATE`. This is the sole exception, and it is a property of the criterion definition, never a run-time judgement.

#### 4.1.2 Algorithm

```
composeGateVerdict(gate, scope) -> (GateVerdict, Qualification[]):

    E := [ evaluateCriterion(c, scope) for c in gate.applicableCriteria(scope) ]
         # each e in E is a CriterionEvaluation {value, basis, reason, severity}
    Q := []                                          # accumulated qualifications

    # 1. Precondition failure: the gate could not be run at all
    if any e in E where e.value = INDETERMINATE and e.reason = PRECONDITION_ABSENT:
        return (BLOCKED, Q)

    # 2. Authority escalation outranks substantive outcomes
    if any e in E where e.value = INDETERMINATE and e.reason = AUTHORITY_REQUIRED:
        return (ESCALATED, Q)

    # 3. Proven failure of a blocking criterion
    if any e in E where e.value = NOT_MET and e.severity = BLOCKING:
        return (FAIL, Q)

    # 4. Unverifiability of a blocking criterion -- never softened
    if any e in E where e.value = INDETERMINATE and e.severity = BLOCKING:
        return (NOT_VERIFIED, Q)

    # 5. Unwaived major failure
    if any e in E where e.value = NOT_MET and e.severity = MAJOR:
        return (FAIL, Q)

    # 6. R4 -- major criterion that could not be verified.
    #    Not FAIL (absence is not proof) and never a clean PASS.
    for e in E where e.value = INDETERMINATE and e.severity = MAJOR:
        Q += Qualification{ kind: UNVERIFIED_ASPECT,
                            criterion_ref: e.criterion_ref,
                            detail: e.reason }

    # 7. Waivers and judged bases also qualify
    for e in E where e.value = WAIVED:
        Q += Qualification{ kind: ACTIVE_WAIVER, criterion_ref: e.criterion_ref,
                            detail: e.waiver_ref }
    for e in E where e.basis = JUDGED:
        Q += Qualification{ kind: JUDGED_BASIS, criterion_ref: e.criterion_ref,
                            detail: e.judged_by }

    # 8. ADVISORY criteria contribute findings only -- never Q, never the verdict.

    if Q is non-empty:  return (PASS_WITH_QUALIFICATION, Q)
    return (PASS, Q)
```

**Rule TX-5:** `NOT_VERIFIED` outranks `PASS_WITH_QUALIFICATION`. Missing verification of a blocking criterion is never softened into a qualified pass.

**Rule TX-5b:** branch order is normative. `BLOCKED` and `ESCALATED` precede substantive outcomes because a gate that could not be evaluated has produced no finding about the work — returning `FAIL` there would blame the artifact for a missing precondition.

**Rule TX-5c (R4):** the severity disposition table (§4.1.1) is **total**. An implementation that reaches a (severity, value) pair with no defined contribution is non-conformant. There is no fall-through to `PASS`.

**Rule TX-5d (R4):** `ADVISORY` criteria never enter `Q`. An advisory criterion that is `NOT_MET` or `INDETERMINATE` produces a finding and leaves the verdict untouched — otherwise "advisory" would silently become "qualifying", and every gate would drift to `PASS_WITH_QUALIFICATION`.

### 4.2 Acceptance examples

Normative test vectors. An implementation disagreeing with any row is non-conformant.

| # | Criterion evaluations | Verdict | Qualifications | Branch |
|---|---|---|---|---|
| 1 | all `MET`, all basis `MEASURED` | `PASS` | none | 8 |
| 2 | all `MET`; one basis `JUDGED` | `PASS_WITH_QUALIFICATION` | `JUDGED_BASIS` | 7 |
| 3 | one `WAIVED` (active waiver), rest `MET`/`MEASURED` | `PASS_WITH_QUALIFICATION` | `ACTIVE_WAIVER` | 7 |
| 4 | one `NOT_MET`, `BLOCKING` | `FAIL` | — | 3 |
| 5 | one `INDETERMINATE` (`EVIDENCE_ABSENT`), `BLOCKING` | `NOT_VERIFIED` | — | 4 |
| 6 | one `INDETERMINATE` (`PRECONDITION_ABSENT`), any severity | `BLOCKED` | — | 1 |
| 7 | one `INDETERMINATE` (`AUTHORITY_REQUIRED`), any severity | `ESCALATED` | — | 2 |
| 8 | one `INDETERMINATE` (`TOOL_UNAVAILABLE`), `BLOCKING` | `NOT_VERIFIED` | — | 4 — `22` DG-1 |
| 9 | one `NOT_MET`, `MAJOR`, unwaived | `FAIL` | — | 5 |
| 10 | one `NOT_MET`, `MAJOR`, **waived** | `PASS_WITH_QUALIFICATION` | `ACTIVE_WAIVER` | value becomes `WAIVED` (`18` GW-2), then 7 |
| 11 | one `NOT_MET`, `ADVISORY`; rest `MET`/`MEASURED` | `PASS` | none | finding only (TX-5d) |
| 12 | one `NOT_MET` `BLOCKING` **and** one `INDETERMINATE` `PRECONDITION_ABSENT` | `BLOCKED` | — | 1 precedes 3 |
| 13 | all criteria `NOT_APPLICABLE` | `PASS` | none | inert |
| **14** | **one `INDETERMINATE` (`EVIDENCE_ABSENT`), `MAJOR`; rest `MET`/`MEASURED`** | **`PASS_WITH_QUALIFICATION`** | **`UNVERIFIED_ASPECT(EVIDENCE_ABSENT)`** | **6 — R4** |
| **15** | **one `INDETERMINATE` (`EVIDENCE_INVALID`), `MAJOR`** | **`PASS_WITH_QUALIFICATION`** | **`UNVERIFIED_ASPECT(EVIDENCE_INVALID)`** | **6 — R4** |
| **16** | **one `INDETERMINATE` (`TOOL_UNAVAILABLE`), `MAJOR`** | **`PASS_WITH_QUALIFICATION`** | **`UNVERIFIED_ASPECT(TOOL_UNAVAILABLE)`** | **6 — R4** |
| **17** | **one `INDETERMINATE`, `ADVISORY`; rest `MET`/`MEASURED`** | **`PASS`** | **none** | **finding only (TX-5d)** |
| 18 | criterion with `tests_existence: true`, evidence absent, `MAJOR` | `FAIL` | — | `on_missing_evidence: NOT_MET` → branch 5 |
| 19 | one `MAJOR` `INDETERMINATE` **and** one `BLOCKING` `NOT_MET` | `FAIL` | — | 3 precedes 6 |

**Rows 14–17 are the R4 correction.** Under R3 rows 14–16 composed to an unqualified `PASS`, meaning a material criterion that nobody could verify would ship with a clean gate record. Row 18 shows the deliberate exception: where a criterion tests for existence, absence *is* the proven negative and `FAIL` is correct.

### 4.3 V3b — ArtifactVerifierResult

**Formalized in R3.** R2 said artifact verdicts use "the same V3 vocabulary minus `BLOCKED` and `ESCALATED` where they do not apply" — a conditional subset, which is not a vocabulary an implementation can validate against.

```
ArtifactVerifierResult  ⊂  GateVerdict
                        =  { PASS, PASS_WITH_QUALIFICATION, FAIL, NOT_VERIFIED, BLOCKED }
```

| Value | Meaning for an artifact |
|---|---|
| `PASS` | Every dimension in scope checked and met, on measured or derived basis |
| `PASS_WITH_QUALIFICATION` | Met, but with judged-basis dimensions or active waivers |
| `FAIL` | A blocking finding exists |
| `NOT_VERIFIED` | A dimension in scope could not be checked |
| `BLOCKED` | The artifact or a required input was unavailable |

**`cause` field (R4).** A verifier result whose value is `NOT_VERIFIED` or `BLOCKED` MUST carry a `cause` drawn from the same closed set as `CriterionEvaluation.reason` (§2, TX-3b):

```
ArtifactVerifierResult.cause : EVIDENCE_ABSENT | EVIDENCE_INVALID | TOOL_UNAVAILABLE
                               | PRECONDITION_ABSENT
                               # required iff value in {NOT_VERIFIED, BLOCKED}
                               # NOT_VERIFIED may not carry PRECONDITION_ABSENT
                               # BLOCKED carries PRECONDITION_ABSENT only
```

Without it the V3b→V1 mapping (§4.4) would lose the distinction between "we had no evidence", "the evidence was stale" and "the tool would not run" — three situations with three different remedies (`31` TX-4).

- **AV-1** `ESCALATED` is **excluded by definition**. If a verifier must escalate, that is a `RunOutcome` (V4) and **no** `ArtifactVerifierResult` is produced. Emitting both would let an escalation masquerade as an evaluation.
- **AV-2** An `ArtifactVerifierResult` is an **input to** a gate criterion; it is never itself a `GateVerdict`.
- **AV-3** It is `T-TRACE` and immutable; its `ValidityState` is derived per §3.
- **AV-4** It MUST record `dimensions_checked` and `dimensions_not_checked` with reasons (`32` `A-VERIFIER`).
- **AV-5** Its qualifications propagate into any gate criterion that consumes it (TX-7).

**Conforming consumers:** `14` §7.3 (Code Review), `15` §8.1 (QA), `17` §11 (Security), `06` Tier 5 contracts, `32` `A-VERIFIER`.

---

### 4.4 V3b → V1 — canonical mapping (R4)

`18` binds `VERIFIER_RESULT` criteria to an `ArtifactVerifierResult`. That binding needs a total, deterministic mapping into `CriterionEvaluation`; R3 asserted the binding without defining it.

```
mapVerifierResult(avr : ArtifactVerifierResult, crit : Criterion)
        -> CriterionEvaluation:

    basis := JUDGED    if avr.basis_summary.judged   is non-empty
          else MEASURED if avr.basis_summary.measured is non-empty
          else DERIVED

    qualifications := avr.qualifications          # always propagate (AV-5)

    match avr.value:
      PASS                     -> value  := MET
      PASS_WITH_QUALIFICATION  -> value  := MET
      FAIL                     -> value  := NOT_MET
      NOT_VERIFIED             -> value  := INDETERMINATE
                                  reason := avr.cause      # EVIDENCE_ABSENT
                                          #  | EVIDENCE_INVALID | TOOL_UNAVAILABLE
                                  qualifications += UNVERIFIED_ASPECT(avr.cause)
      BLOCKED                  -> value  := INDETERMINATE
                                  reason := PRECONDITION_ABSENT
      # ESCALATED is not a member of V3b (AV-1); it cannot occur here.

    return CriterionEvaluation{
        value, basis, reason, qualifications,
        severity      := crit.severity,           # from the gate definition, not the verifier
        evidence_refs := avr.evidence_refs,
        judged_by     := avr.actor + avr.criteria_applied   if basis = JUDGED
    }
```

**Mapping rules — normative:**

| ID | Rule |
|---|---|
| `MV-1` | The mapping is **total**: every V3b value maps, and `ESCALATED` cannot arise (AV-1) |
| `MV-2` | `FAIL` MUST NEVER map to `MET`. There is no path from a failing verifier result to a satisfied criterion |
| `MV-3` | `NOT_VERIFIED` maps to `INDETERMINATE` carrying the verifier's `cause` verbatim — the reason is preserved, never re-derived or defaulted |
| `MV-4` | `BLOCKED` maps to `INDETERMINATE` with reason `PRECONDITION_ABSENT`, preserving the missing-precondition distinction so composition branch 1 still fires |
| `MV-5` | Qualifications propagate from the verifier result into the criterion evaluation and onward (TX-7) |
| `MV-6` | **Severity comes from the gate definition, not from the verifier.** A verifier judges the artifact; the gate decides how much that matters. Letting a verifier set severity would let it choose whether its own finding blocks |
| `MV-7` | Basis is derived from `basis_summary`, not fixed at `JUDGED`. A verifier result resting entirely on measured dimensions yields a `MEASURED`-basis criterion and does **not** force `PASS_WITH_QUALIFICATION` |
| `MV-8` | The mapping is executable without interpretation: every branch is a literal match on a closed vocabulary |

**Mapping test vectors — normative:**

| # | `ArtifactVerifierResult` | Criterion severity | → `CriterionEvaluation` | → gate contribution |
|---|---|---|---|---|
| M1 | `PASS`, all dimensions measured | `BLOCKING` | `MET` / `MEASURED` | `PASS` |
| M2 | `PASS`, one dimension judged | `BLOCKING` | `MET` / `JUDGED` | `PASS_WITH_QUALIFICATION` |
| M3 | `PASS_WITH_QUALIFICATION` (active waiver inside) | `MAJOR` | `MET` / `JUDGED` + waiver qualification | `PASS_WITH_QUALIFICATION` |
| M4 | `FAIL` | `BLOCKING` | `NOT_MET` | `FAIL` |
| M5 | `FAIL` | `MAJOR`, unwaived | `NOT_MET` | `FAIL` |
| M6 | `NOT_VERIFIED`, `cause = EVIDENCE_ABSENT` | `BLOCKING` | `INDETERMINATE` / reason `EVIDENCE_ABSENT` | `NOT_VERIFIED` |
| M7 | `NOT_VERIFIED`, `cause = TOOL_UNAVAILABLE` | `MAJOR` | `INDETERMINATE` / reason `TOOL_UNAVAILABLE` | `PASS_WITH_QUALIFICATION` + `UNVERIFIED_ASPECT` |
| M8 | `NOT_VERIFIED`, `cause = EVIDENCE_INVALID` | `ADVISORY` | `INDETERMINATE` / reason `EVIDENCE_INVALID` | `PASS`, finding only |
| M9 | `BLOCKED`, `cause = PRECONDITION_ABSENT` | any | `INDETERMINATE` / reason `PRECONDITION_ABSENT` | `BLOCKED` |

## 5. V4 — RunOutcome

The terminal outcome of one agent run. Owned in detail by `05` §7; enumerated here for canonical reference.

`COMPLETED · PARTIAL · BLOCKED · ESCALATED · REFUSED · FAILED · INVALID_OUTPUT · SCOPE_VIOLATION · EVIDENCE_VIOLATION`

**Cardinality: 9.**

**Rule TX-6:** a run outcome is never a verdict. `COMPLETED` means the run finished within contract — it says nothing about whether the work is correct. Conflating the two would reintroduce self-certification through the back door.

---

## 6. V5 — ProcessState

Mutable positions in a lifecycle. **None of these are verdicts.** R3 splits what R2 called "stage state" into two genuinely different machines, because R2 mapped `FAIL` to a stage disposition value (`REWORK`) that the disposition enumeration did not contain.

| Sub | Subject | Values | Owner | Mutability |
|---|---|---|---|---|
| **V5a** | `WorkItemState` | `RECEIVED · CLASSIFIED · PLANNED · EXECUTING · GATING · ADVANCING · REWORK · AWAITING_OWNER · AWAITING_EXPERT · AWAITING_APPROVAL · BLOCKED · HALTED · COMPLETED · CANCELLED · REJECTED · SUPERSEDED` | `04` §8.1 | Mutable |
| **V5b** | `WorkflowRunState` | `PENDING · RUNNING · WAITING · GATING · REWORK · COMPLETED · FAILED · ABORTED · SUPERSEDED` | `07` §6 | Mutable projection over an immutable event log |
| **V5c** | `StageExecutionState` | `NOT_STARTED · IN_PROGRESS · IN_GATE · REWORK · BLOCKED · COMPLETE` | `03` §1.3 | Mutable — the *live* position of a stage |
| **V5d** | `StageLedgerDisposition` | `EXECUTED · IN_PROGRESS · BLOCKED · SKIPPED · NOT_APPLICABLE · FAILED · ABANDONED` | `03` §10 | **Immutable, appended per attempt** |
| **V5e** | `ProposalState` | 18 values | `10` §6 | Mutable |
| **V5f** | `EscalationState` | `OPEN · ANSWERED · WITHDRAWN · SUPERSEDED` | `05` §9 | Mutable |
| **V5g** | `ChangeRequestState` | `DRAFT · ASSESSING · AWAITING_APPROVAL · APPROVED · REJECTED · IMPLEMENTING · COMPLETED · WITHDRAWN · SUPERSEDED` | `09` §5 | Mutable |
| **V5h** | `GovernanceState` | `ACTIVE · INACTIVE · DEGRADED · SUSPENDED · UNKNOWN` | `20` §2 | Derived |

### 6.1 Why V5c and V5d are different machines

`StageExecutionState` answers *where is this stage right now?* — it is a live, mutable pointer, and `REWORK` is a legitimate transient position in it.

`StageLedgerDisposition` answers *what happened on each attempt?* — it is an immutable record appended per attempt (`SC-POL-022`, `SC-POL-024`). `REWORK` is **not** a disposition, because "we are trying again" is not an outcome; the outcome of the failed attempt is `FAILED`.

Conflating them is what produced the R2 defect. A ledger that could be set to `REWORK` would either be mutated in place (violating immutability) or would record a non-outcome as an outcome.

- **PS-1** `REWORK` MUST NOT appear in `StageLedgerDisposition`.
- **PS-2** Every gate evaluation appends exactly one `StageLedgerEntry` for the attempt it evaluated.
- **PS-3** `STALLED` is not a state in any of these sets. It is a **visibility flag** on a non-terminal item past a threshold (`SC-POL-033`); it does not replace the item's state.

### 6.2 Gate outcome → process state (the R3 mapping)

Three machines advance together on every gate evaluation. This is the mapping R2 lacked.

| `GateVerdict` | V5d `StageLedgerDisposition` (appended) | V5c `StageExecutionState` | V5a `WorkItemState` | V5b `WorkflowRunState` |
|---|---|---|---|---|
| `PASS` | `EXECUTED` | `COMPLETE` | `ADVANCING` | `RUNNING` |
| `PASS_WITH_QUALIFICATION` | `EXECUTED` (+ qualifications) | `COMPLETE` | `ADVANCING` | `RUNNING` |
| `FAIL` | `FAILED` | `REWORK` → `IN_PROGRESS` | `REWORK` | `REWORK` |
| `NOT_VERIFIED` | `FAILED` | `REWORK` → `IN_PROGRESS` | `REWORK` | `REWORK` |
| `BLOCKED` | `BLOCKED` | `BLOCKED` | `BLOCKED` | `WAITING` |
| `ESCALATED` | `BLOCKED` | `BLOCKED` | `AWAITING_OWNER` \| `AWAITING_APPROVAL` \| `AWAITING_EXPERT` | `WAITING` |

**Read the `FAIL` row carefully — it is the correction.** The ledger records `FAILED` for the attempt that just failed; the stage's live position becomes `REWORK` and then `IN_PROGRESS` for a **new** attempt; the work item and workflow enter `REWORK`. Four distinct facts, four distinct machines, one deterministic mapping.

**`NOT_VERIFIED` maps to the same states as `FAIL` but to different work** (`18` §5): `FAIL` produces rework on the *artifact*; `NOT_VERIFIED` produces a task to *produce the missing evidence*. The state machines agree; the dispatched work does not.

---

## 7. Mapping Between Vocabularies

```
 Evidence record (immutable)
   └─ V2 ValidityState (derived, §3.2)
        └─ feeds ─► V1 CriterionEvaluation (value + basis + reason + severity)
                      │
                      ├─ may consume ◄─ V3b ArtifactVerifierResult (from a VERIFIER agent)
                      │
                      └─ composes (§4.1) ─► V3 GateVerdict
                                            └─ maps (§6.2) ─► V5c StageExecutionState
                                                              ─► V5d StageLedgerDisposition
                                                              ─► V5a WorkItemState
                                                              ─► V5b WorkflowRunState

 Agent run
   └─ V4 RunOutcome ──► accepted? ──► artifacts + evidence claims
                                        └─ verified by runtime ─► Evidence records
```

| From | To | Rule |
|---|---|---|
| `ValidityState != VALID` | `CriterionResult` | forces `INDETERMINATE` with reason `EVIDENCE_INVALID` |
| `ArtifactVerifierResult` value | `CriterionEvaluation` | per the total mapping in §4.4 |
| `CriterionResult = INDETERMINATE` (MAJOR) | `GateVerdict` | caps at `PASS_WITH_QUALIFICATION` with `UNVERIFIED_ASPECT` (R4) |
| `CriterionResult` any value (ADVISORY) | `GateVerdict` | no effect — finding only (TX-5d) |
| `CriterionResult = NOT_MET` (BLOCKING) | `GateVerdict` | forces `FAIL` |
| `CriterionResult = INDETERMINATE` (BLOCKING) | `GateVerdict` | forces `NOT_VERIFIED` |
| `CriterionResult` basis `JUDGED` or value `WAIVED` | `GateVerdict` | caps at `PASS_WITH_QUALIFICATION` |
| `GateVerdict ∈ {PASS, PASS_WITH_QUALIFICATION}` | V5c / V5d / V5a / V5b | per §6.2 — ledger `EXECUTED` |
| `GateVerdict = FAIL` | V5c / V5d / V5a / V5b | per §6.2 — ledger `FAILED`, live states `REWORK` |
| `GateVerdict = NOT_VERIFIED` | V5c / V5d / V5a / V5b | per §6.2 — same states as `FAIL`, different dispatched work |
| `GateVerdict ∈ {BLOCKED, ESCALATED}` | V5c / V5d / V5a / V5b | per §6.2 |
| `ArtifactVerifierResult` | `CriterionEvaluation` | consumed as criterion input; qualifications propagate (AV-5) |
| `RunOutcome ∈ {SCOPE_VIOLATION, EVIDENCE_VIOLATION}` | work item | forces `HALTED` + V1 violation |
| `RunOutcome = COMPLETED` | any verdict | **no implication whatsoever** |

The last row is the important one. It is written as a rule so that no implementation can quietly treat a finished run as a passed check.

---

## 8. Qualifications

A qualification is a caveat attached to a `PASS_WITH_QUALIFICATION` verdict or to an artifact verdict.

```
Qualification {
  kind   : JUDGED_BASIS | ACTIVE_WAIVER | UNVALIDATED_ASSUMPTION |
           UNVERIFIED_ASPECT | DEGRADED_ENFORCEMENT | RESEARCH_UNAVAILABLE
  subject, detail, criterion_ref, expires_at?
}
```

**Rule TX-7:** qualifications **propagate**. A verdict depending on a qualified verdict inherits its qualifications. Without this, a chain of individually reasonable passes launders an unvalidated assumption into apparent certainty.

**Rule TX-8:** every qualification on a release-scope verdict appears in the release notes and the handover package (`23` §3.1 RL-2, §5).

`DEGRADED_ENFORCEMENT` is new in R2: it marks a verdict produced while capability enforcement was running on an unsupported isolation substrate (`33` §5). It is how the platform limitation becomes visible in the record rather than silently weakening every claim above it.

---

## 9. Prohibited Vocabulary Reuse

| Prohibited | Use instead |
|---|---|
| "verdict" for a run outcome | `RunOutcome` (V4) |
| "verdict" for a criterion result | `CriterionResult` (V1) |
| `JUDGED` as a gate verdict | `PASS_WITH_QUALIFICATION` with `JUDGED` basis on the criterion |
| `WAIVED` as a gate verdict | `PASS_WITH_QUALIFICATION` with a `WAIVED` criterion |
| `PASS` for an unverified item | `NOT_VERIFIED` |
| `FAIL` for an unverified item | `NOT_VERIFIED` |
| "status" as a generic outcome word | The specific vocabulary V1–V5 |
| `FRESH` anywhere | `VALID` (V2); `FRESH` retired in R3 (VD-5) |
| `EvidenceState` as a current vocabulary name | `ValidityState` (V2) applied to `Evidence` (TX-1b). The R2 term is historical only |
| A gate criterion reached with no defined disposition | Severity disposition table is total (TX-5c) |
| `ADVISORY` criterion contributing a qualification | Findings only (TX-5d) |
| A verifier setting the severity of the criterion it feeds | Severity comes from the gate definition (MV-6) |
| A stored `freshness` field on any record | Derived `ValidityState` (VD-1) |
| `REWORK` as a stage ledger disposition | `FAILED` in V5d; `REWORK` in V5c/V5a/V5b (PS-1) |
| `ESCALATED` as an `ArtifactVerifierResult` | `RunOutcome` `ESCALATED`, with no verifier result emitted (AV-1) |
| A verifier result typed as `GateVerdict` | `ArtifactVerifierResult` (V3b) |

---

## 10. Corrections Applied Elsewhere

| Document | R1 statement | R2 correction |
|---|---|---|
| `27` FR-6.2 | "Produce all eight verdict values" | Rewritten against V1/V2/V3 with `ValidityState` naming (R3, corrected again in R4) |
| `31` §4.1 | `MAJOR` + `INDETERMINATE` undefined, fell through to `PASS` | Severity disposition table made total; branch 6 added (R4) |
| `18` | `VERIFIER_RESULT` binding with no mapping | Total mapping in §4.4 (R4) |
| `18` | `Criterion.on_absent` typed in gate-level values | Replaced by `on_missing_evidence` in V1 values (R4) |
| `18` | `QualityGate.on_not_verified` | Removed — composition is fully determined by severity (R4) |
| `18` §4.1 | Six-value table including `WAIVED`, `JUDGED` | Six-value `GateVerdict` table per §4 here; criterion values moved to V1 |
| `16` §5 | `Verdict` with 6 values incl. `WAIVED`, `JUDGED` | Artifact verdicts use V3; evidence uses V2; `JUDGED` becomes a basis |
| `26` §2.1 | "Verdicts" enumeration of 8 | References this document for all five vocabularies |
| `08` | `Verdict.freshness` stored; `v.freshness := STALE` mutation | `ValidityState` derived per §3.2; no mutation (R3) |
| `08` | `KI-2` allowed `NOT_VERIFIED`/`JUDGED` as verdict values | Rewritten against V1/V3/V3b (R3) |
| `08` | Relations referenced non-entities `Verdict`, `StageTransition` | Replaced with `CriterionEvaluation`, `ArtifactVerifierResult`, `GateResult`, `StageLedgerEntry` (R3) |
| `00` | R4 listed `PASS \| FAIL \| BLOCKED \| NOT_VERIFIED \| WAIVED` | Rewritten against V3 (R3) |
| `01` | `SC-POL-005` referred to a "`JUDGED` verdict" | Rewritten as a `JUDGED`-basis criterion (R3) |
| `14`, `15` | Verifier results typed `PASS \| FAIL \| NOT_VERIFIED` | Typed `ArtifactVerifierResult` (V3b) (R3) |
| `16`, `18` | Stored `freshness : FRESH \| STALE \| EXPIRED \| REVOKED` | Derived `ValidityState`; `FRESH` retired (R3) |
| `18` §4 | Second, divergent composition algorithm | References §4.1; single owner (R3) |
| `24` §11 | "criterion resolves to PASS/FAIL/NOT_VERIFIED/JUDGED" | Rewritten against V1 + basis (R3) |
