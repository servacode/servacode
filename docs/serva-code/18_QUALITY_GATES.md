# 18 — QUALITY GATES

**Document ID:** SC-DOC-018
**Status:** BASELINE R4
**Type:** Normative / Component Specification
**Owns:** Gate definition schema, gate catalogue, gate governance, waiver and escalation mechanics, gate integrity.
**Does not own:** **Outcome vocabularies and the composition algorithm (`31`)**, evidence classes (`16`), criteria content owned by other documents (referenced, not restated).

**R3 note:** R2 left a second, divergent composition algorithm here that evaluated criteria using gate-level values. `31` §4.1 is now the single owner of executable composition semantics; this document references it.

---

## 1. What a Gate Is

A **Quality Gate** is a deterministic evaluation of stored state and evidence against declared criteria, producing a verdict that authorizes or blocks a transition.

A gate is explicitly **not**:

- a prompt asking an agent whether the work is done;
- a checklist an agent self-reports against;
- a summary of what an agent believes it accomplished.

> **A gate evaluates the store. It does not interview the worker.**

This is the mechanical form of `SC-POL-005`. Where a criterion genuinely requires judgment, the gate does not evaluate it directly — it consumes an `ArtifactVerifierResult` (`31` §4.3) from a designated independent verifier role, and the resulting `CriterionEvaluation` carries basis `JUDGED` (`31` §2). `JUDGED` is a **basis**, never a verdict.

### 1.1 Who runs, who evaluates, who audits

| Function | Actor | Why separated |
|---|---|---|
| Runs the gate | Orchestrator (`SC-DEPT-001`) | It owns sequencing |
| Evaluates criteria | Gate engine (deterministic, non-AI) | Removes throughput pressure from evaluation |
| Supplies judged-basis inputs | Designated verifier agents (Tier 5), as `ArtifactVerifierResult` (`31` V3b) | `SC-POL-006` |
| Audits gate correctness | Governance (`SC-DEPT-002`) | The Orchestrator does not audit itself (`04` §1) |

The Orchestrator **cannot** produce a verdict. This is enforced structurally, not by instruction.

---

## 2. Gate Definition Schema

```
QualityGate {
  id               : SC-GATE-<NAME>
  name, version
  applies_to       : { stages[], profiles[], request_classes[] }
  blocking         : bool                       # false = advisory gate, records but does not block
  criteria         : Criterion[]
  invalidation_set : artifact classes whose change makes this gate's result STALE (31 §3.2)
  verdict_rules    : how criteria combine into a verdict (§4)
  on_fail          : FailurePath (07 §5)
  waivable         : bool + authority (09 §9)
  evaluator        : DETERMINISTIC
  escalation       : conditions that route to owner
}

Criterion {
  id, statement,
  evaluation       : STORE_QUERY(query) | EVIDENCE_CHECK(EvidenceRequirement) |
                     VERIFIER_RESULT(role, criteria) | COMPOSITE(children)
                     # VERIFIER_RESULT consumes an ArtifactVerifierResult (31 V3b)
                     # and maps it to a CriterionEvaluation by 31 §4.4.
                     # Basis is DERIVED FROM the result's basis_summary (MV-7),
                     # not fixed at JUDGED.
  required_class   : minimum evidence class (16 §3)
  independence     : bool                        # producer must differ from claimant
  severity         : BLOCKING | MAJOR | ADVISORY # drives composition, 31 §4.1.1
  tests_existence  : bool                        # R4 — see §2.1
  on_missing_evidence : INDETERMINATE | NOT_MET  # R4 — V1 values, default INDETERMINATE
  policy_refs      : SC-POL-###[]                # which policy this enforces
  applicability    : condition | ALWAYS
}
```

### 2.1 `on_missing_evidence` and `tests_existence` (R4)

R3 carried `on_absent : NOT_VERIFIED | FAIL | BLOCKED` — a criterion-level field typed in **gate-level** values. A criterion cannot produce a `GateVerdict` (`31` TX-1), so the field was unimplementable as written. R4 replaces it with a field typed in V1 values, and the composition table (`31` §4.1.1) turns that into a verdict.

| `tests_existence` | `on_missing_evidence` | Meaning |
|---|---|---|
| `false` (default) | `INDETERMINATE` (only permitted value) | Evidence is absent, so **we do not know**. Composition treats it per severity |
| `true` | `NOT_MET` (only permitted value) | The criterion **is** an existence test — "a threat model exists", "a rollback was executed", "no secret is present". Absence *is* the proven negative |

- **CR-EX1** `on_missing_evidence: NOT_MET` is permitted **only** when `tests_existence: true`. Any other combination is a gate-definition defect (`SD-16`).
- **CR-EX2** `tests_existence: true` requires the criterion statement to be phrased as an existence or absence claim. This is what keeps `SC-POL-005`'s "absence of evidence is not proof of failure" intact while still letting "the backup was never tested" be a genuine failure.
- **CR-EX3** Changing a criterion from `tests_existence: false` to `true` strengthens the gate and follows §9's add-rigor path; the reverse requires owner approval.

**Removed in R4: `QualityGate.on_not_verified`.** R3 let a gate declare `BLOCK | PROCEED_WITH_QUALIFICATION | ESCALATE` for unverified criteria. That duplicated — and could contradict — the severity disposition table, and it was a per-gate lever for downgrading `NOT_VERIFIED`, which is precisely the erosion `SC-POL-005` exists to prevent. Composition is now fully determined by criterion severity (`31` §4.1.1); gate-level breadth is expressed by `blocking` and by the criteria a gate chooses to carry, not by re-interpreting their outcomes.

`policy_refs` is the traceability link from the constitution to enforcement. `24` R1 requires that every policy is enforced somewhere; this field is how that is checked mechanically rather than argued.

---

## 3. Gate Catalogue

Criteria content is owned by the referenced documents; this table is the binding index, not a restatement (`SC-POL-025`).

Gate membership and cardinality: `30` §7. Criteria content is owned by the referenced documents.

| Gate | After stage | Blocking | Criteria source | Key policies |
|---|---|---|---|---|
| `SC-GATE-INTAKE` | INTAKE (incl. Idea capture) | Yes | `03` §2 SC-STAGE-002 exit | 001 |
| `SC-GATE-DISCOVERY` | DISCOVERY | Yes | `03` §2 SC-STAGE-003 exit | 011, 012 |
| `SC-GATE-PRODUCT_VALIDATION` | PRODUCT_VALIDATION | Yes | `03` §2 SC-STAGE-004 exit | 001, 011 |
| `SC-GATE-REQUIREMENTS` | BUSINESS_ANALYSIS + REQUIREMENTS (incl. NFR) | Yes | `03` §3 exits | 013, 014, 018 |
| `SC-GATE-COMPETITIVE` | MARKET_AND_COMPETITIVE_INTELLIGENCE | Yes | `11` §6.2 | 011 |
| `SC-GATE-FEASIBILITY` | FEASIBILITY + RISK | Yes | `03` §3 exits | 017 |
| `SC-GATE-ARCHITECTURE` | ARCHITECTURE + DATA + SEC_ARCH | Yes | `03` §4, `06` SC-DEPT-020/021 | 002, 004, 015, 017, 018 |
| `SC-GATE-SECURITY_DESIGN` | SECURITY_ARCHITECTURE | Yes | `17` §11 | 018, 012 |
| `SC-GATE-TECHNOLOGY` | TECHNOLOGY_SELECTION | Yes | `03` §4, `09` §7 | 016, 002, 015, 017 |
| `SC-GATE-DESIGN` | UX + DESIGN_SYSTEM + ADMIN(design) | Yes | `13` §9, `03` §4 | 003, 004, 010 |
| `SC-GATE-PLAN` | PLANNING | Yes | `03` §5 exit | 014, 024, 028 |
| `SC-GATE-IMPLEMENTATION` | IMPLEMENTATION | Yes | `14` §10, `03` §6 | 003, 004, 009, 010, 014 |
| `SC-GATE-CODE_REVIEW` | CODE_REVIEW | Yes | `14` §7 | 006, 009, 003, 004 |
| `SC-GATE-QA` | QA | Yes | `15` §8.1 | 005, 006, 014 |
| `SC-GATE-SECURITY` | SECURITY_TESTING | Yes | `17` §11 | 018, 005 |
| `SC-GATE-PERFORMANCE` | PERFORMANCE | Conditional | `06` SC-DEPT-053 | 005, 019 |
| `SC-GATE-ACCEPTANCE` | ACCEPTANCE | Yes | `03` §6 SC-STAGE-045 | 005, 006, 011, 014, 031 |
| `SC-GATE-RELEASE` | RELEASE | Yes | `23` §4 | 019, 030, 031 |
| `SC-GATE-INCIDENT_CLOSURE` | INCIDENT | Yes | `23` §6 | 022, 012 |

### 3.1 Cross-cutting criteria present in every blocking gate

Applied uniformly, defined once here (`SC-POL-025`):

| ID | Criterion | Policy | Severity |
|---|---|---|---|
| `XC-1` | No verdict this gate depends on is `STALE`, `EXPIRED` or `REVOKED` | 031 | BLOCKING |
| `XC-2` | No unresolved mandatory escalation in scope | 012 | BLOCKING |
| `XC-3` | Every observation from in-scope runs has reached terminal triage | 008 | MAJOR |
| `XC-4` | Every stage in scope has a ledger disposition | 024 | MAJOR |
| `XC-5` | No `SCOPE_VIOLATION` or `EVIDENCE_VIOLATION` unresolved | 009, 023 | BLOCKING |
| `XC-6` | Store integrity check clean for in-scope records | 022 | BLOCKING |
| `XC-7` | Workspace reconciled; no unaccounted divergence | 032 | BLOCKING |
| `XC-8` | Consumption within budget, or an owner decision recorded | 028 | MAJOR |
| `XC-9` | Producer ≠ verifier for every verdict consumed | 006 | BLOCKING |
| `XC-10` | Active waivers in scope are listed and unexpired | 009 §9 | MAJOR |
| `XC-11` | Load-bearing unvalidated assumptions are surfaced as qualifications | 016 §5.2 | MAJOR |

`XC-7` deserves emphasis: **evaluating a gate against a workspace that has drifted from the store produces a verdict about a system that does not exist.** Reconciliation before evaluation is not hygiene; it is a precondition for the verdict meaning anything.

---

## 4. Verdict Rules

**Owned by `31`.** Criterion results (V1 + basis + reason), gate verdicts (V3), artifact verifier results (V3b) and the composition algorithm are defined in `31` §2–§4. This document does not restate them (`SC-POL-025`).

### 4.1 What this document contributes

| Concern | Owner |
|---|---|
| `CriterionResult` values, bases, `INDETERMINATE` reasons | `31` §2 |
| `composeGateVerdict()` algorithm and branch order | `31` §4.1 |
| Acceptance examples for composition | `31` §4.2 |
| `ArtifactVerifierResult` vocabulary | `31` §4.3 |
| **Which criteria a gate has, at what severity, with what evidence requirement** | **this document, §2–§3** |
| **Waiver mechanics, gate governance, gate integrity** | **this document, §6–§9** |

The gate engine evaluates each criterion into a `CriterionEvaluation` and calls `composeGateVerdict()`. It contains no verdict logic of its own.

**Severity, declared per criterion in the gate definition (§2), is an input to composition.** The complete, total disposition table is `31` §4.1.1 and is not restated here. The one point worth stating at gate-definition time:

> Choosing `MAJOR` rather than `BLOCKING` does **not** mean an unverified criterion disappears. A `MAJOR` criterion that cannot be verified caps the gate at `PASS_WITH_QUALIFICATION` and attaches an `UNVERIFIED_ASPECT` qualification that travels to release (`31` §4.1.1, branch 6). It never yields a clean `PASS`.

That was the R3 defect: `MAJOR` + `INDETERMINATE` had no defined disposition and fell through to `PASS`.

### 4.2 Verdict record

```
GateResult {
  id                 : SC-GR-<id>
  gate_ref           : SC-GATE-<NAME> @ version
  scope              : work item | feature | release
  verdict            : GateVerdict                    # 31 V3
  criterion_evals    : SC-CE-<seq>[]                  # 31 §2.1 — one per applicable criterion
  evidence_refs      : SC-EV-<id>[]
  artifact_versions_evaluated : [ {artifact_id, version, digest} ]
  qualifications     : Qualification[]                # 31 §8
  findings           : Finding[]
  evaluated_at, evaluator, store_version
  depends_on         : GateResult | ArtifactVerifierResult refs   # for validity propagation
}
```

**No `freshness` field.** `GateResult` is `T-TRACE` and immutable; its `ValidityState` is **derived** by `SC-RTC-004` from `artifact_versions_evaluated`, `depends_on`, time, and any revocation or dispute record (`31` §3.2, `VD-1`). R2 stored a mutable `freshness` here, which contradicted `SC-POL-022`.

`T-TRACE`, immutable. Re-evaluation appends a new result; it never edits the old one (`SC-POL-022`). The history of a gate — including every failure — remains readable, which is what makes the loop breaker (`04` §8.3) and `SC-DEPT-064` learning possible.

Each evaluation also appends exactly one `StageLedgerEntry` for the attempt (`31` PS-2), and drives the four process state machines per `31` §6.2.

---

## 5. Failure Handling

State transitions for every verdict are given once in `31` §6.2. What differs per verdict is the **work dispatched**:

| Verdict | Ledger (V5d) | Work dispatched |
|---|---|---|
| `FAIL` | `FAILED` | Findings become rework tasks on the **artifact**, routed to the owning department; loop breaker counts the `(gate, root_cause)` pair |
| `NOT_VERIFIED` | `FAILED` | Missing evidence becomes a task to **produce the evidence**. **Not rework of the artifact** — the artifact may be fine; the verification is absent. Distinguishing these prevents pointless code churn in response to a measurement gap |
| `BLOCKED` | `BLOCKED` | Dependency chain reported (`04` §9); no work dispatched against the blocked item |
| `ESCALATED` | `BLOCKED` | Routed per `09`/`28`; work item enters the matching `AWAITING_*` state |

**Rule:** a gate that has failed N times on the same root cause halts the work item and escalates (`04` §8.3). Repeated identical failure is a signal that the specification, not the implementation, is wrong.

---

## 6. Waivers and Overrides

Waivers are governed in `09` §9. Gate-specific rules:

- **GW-1** A waiver is scoped to a specific criterion on a specific subject. There is no gate-level waiver.
- **GW-2** Waiving converts a `FAIL` criterion to `WAIVED`, which yields `PASS_WITH_QUALIFICATION`, never `PASS`.
- **GW-3** Never waivable: evidence fabrication findings, `SC-POL-030` boundaries, `SC-POL-006` separation, `T-TRACE` immutability, secrets-scan findings, `CRITICAL` security findings in a live system, `CRITICAL` defects.
- **GW-4** Active waivers appear in the gate result, in the release package, and in the owner's view. A waiver the owner cannot see is not consent.
- **GW-5** Expired waivers re-block automatically.

**There is no override mechanism.** The owner may waive a specific criterion with a recorded justification; the owner may not declare a gate passed. The distinction matters: a waiver records *what was accepted*, an override records nothing.

---

## 7. Gate Integrity

Governance (`SC-DEPT-002`) audits:

| Check | Detects |
|---|---|
| Verdict without bound evidence | `SC-POL-005` violation (V1) |
| Producer = verifier in a consumed verdict | `SC-POL-006` violation (V1) |
| `PASS` where a criterion admitted stronger evidence than was used | `SC-POL-023` strength violation |
| Gate criteria weakened without governance | Erosion (`07` §9 asymmetry) |
| Rising `PASS_WITH_QUALIFICATION` rate | Standards eroding under throughput pressure |
| Rising `JUDGED`-basis share of criteria per gate | Gates drifting from measurement toward assessment (`SC-OQ-018`) |
| Rising waiver count/age | Same |
| Gates consistently skipped by profile | Tailoring abuse (`SC-POL-024`) |
| Policies with no `policy_refs` binding in any gate | Unenforced policy (`24` R1) |
| Verdicts evaluated against an unreconciled workspace | `XC-7` bypass |

The last three are the **erosion detectors**. The most probable long-term failure of Serva Code is not a dramatic breach — it is gradual, individually-reasonable relaxation of gates under time pressure until the governance is ceremonial. These metrics exist to make that trend visible while it is still reversible.

---

## 8. Advisory Gates

Some gates are non-blocking by design: they record a verdict and surface findings without stopping work. Used where blocking would be disproportionate — for example a documentation-quality gate on a `PRF-SMALL-CHANGE`.

- **AG-1** Advisory status is declared in the gate definition, never decided at evaluation time.
- **AG-2** An advisory gate's `FAIL` still produces findings and, where appropriate, proposals.
- **AG-3** A gate enforcing a `PROTECTIVE`-tier policy (`01` §1.2) MUST NOT be advisory.

---

## 9. Gate Governance

Gate definitions are `T-CANON`. Changes follow the same asymmetry as workflows (`07` §9):

| Change | Governance |
|---|---|
| Add a criterion, or raise a severity | Decision Record |
| Set `tests_existence: true` on a criterion | Decision Record (strengthens) |
| Set `tests_existence: false`, or lower a severity | Decision + Impact Analysis + **owner approval** |
| Raise a required evidence class, or a criterion severity | Decision Record |
| Remove a criterion, lower a severity, lower an evidence class | Decision + Impact Analysis + **owner approval** |
| Make a blocking gate advisory | Decision + Impact Analysis + **owner approval** |
| Change `invalidation_set` | Decision + Impact Analysis |

Strengthening is cheap; weakening requires the owner. This asymmetry is the primary structural defense against the erosion failure mode in §7.
