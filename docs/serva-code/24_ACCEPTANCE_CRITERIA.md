# 24 — ACCEPTANCE CRITERIA

**Document ID:** SC-DOC-024
**Status:** BASELINE R4
**Type:** Normative / Acceptance Specification
**Owns:** Definition of Done at every level, and the definition of Serva Code 1.0 Ready.
**Does not own:** Gate mechanics (`18`), evidence classes (`16`).

---

## 1. Two Kinds of Acceptance

| Kind | Question | Sections |
|---|---|---|
| **Product acceptance** | Is the client product done? | §2–§8 |
| **Serva Code acceptance** | Is Serva Code 1.0 itself ready? | §9–§11 |

Both use the same evidence discipline (`16`). Serva Code is built under its own constitution (`SC-POL-034`), so its acceptance is not a lighter standard.

---

## 2. Definition of Done — Task

A Task is Done when **all** hold:

| # | Criterion | Evidence |
|---|---|---|
| 1 | Deliverables produced per the task definition | Artifacts |
| 2 | Changed-artifact set within the declared scope | Runtime scope diff |
| 3 | Build succeeds | S1 build output |
| 4 | Static analysis passes: standards, tokens, strings, secrets, configurable values | S1 scan outputs |
| 5 | Unit tests per strategy, executed | S1 test run |
| 6 | Traceability links written | Deterministic check |
| 7 | `self_review` and `observations` present | Schema validation |
| 8 | Assumptions recorded | Schema validation |
| 9 | Escalations raised where required, not worked around | Run record |
| 10 | Consumption within budget or escalated | Consumption record |

**Not required at this level:** correctness verdict. A task being Done means the work was performed within its contract — not that it is right. That determination belongs to Review.

---

## 3. Definition of Done — Feature

| # | Criterion | Evidence |
|---|---|---|
| 1 | All constituent tasks Done | Task states |
| 2 | Admin Operability Review complete (`SC-POL-010`) | Review record |
| 3 | Code Review PASS; no open `BLOCKING` findings | Gate result |
| 4 | Test cases derived from acceptance criteria, executed | S1 test runs |
| 5 | Every acceptance criterion covered by ≥1 passing case | Coverage report |
| 6 | Business rules in scope tested (positive, negative, boundary) | Test results |
| 7 | All defined UX states implemented and verified | State coverage results |
| 8 | Accessibility obligations verified per scope | Automated + traversal evidence |
| 9 | RTL/i18n verified where applicable | Per-locale evidence |
| 10 | Security dimension reviewed; sensitive surfaces tested | Review + security evidence |
| 11 | Performance verified where an NFR applies | Measurements |
| 12 | Traceability closed; no unexplained orphans | Traceability matrix |
| 13 | Configurable elements registered and tested at boundaries | Register + test results |
| 14 | Protected rules non-bypassable | Bypass-attempt test results |
| 15 | Documentation updated per standard | Artifacts |
| 16 | Observations triaged | Triage records |
| 17 | Acceptance verdict by an actor that did not produce the work | `SC-POL-006` binding |
| 18 | Every constituent `ArtifactVerifierResult` derives to `VALID` (`31` §3.2) | Validity derivation |

---

## 4. Definition of Done — Requirement

| # | Criterion |
|---|---|
| 1 | Implemented, traceable to artifacts |
| 2 | Every acceptance criterion has ≥1 passing, fresh test result |
| 3 | Negative and boundary behavior verified where meaningful |
| 4 | No open `CRITICAL`/`MAJOR` defect against it |
| 5 | Any qualification (assumption, waiver, unverified aspect) recorded and visible |

---

## 5. Definition of Done — Release

Per `23` §4 Release Gate. Summarized: fresh acceptance for all included work; operational readiness fully dispositioned and evidenced; rollback and restore **tested**; no open `CRITICAL` security finding or defect; competitive position current; handover package complete; waivers listed; cross-cutting criteria satisfied.

---

## 6. Definition of Done — Project

| # | Criterion |
|---|---|
| 1 | All `MUST` requirements Done, or explicitly deferred by owner decision |
| 2 | All `ProjectGoal`s covered by delivered requirements, or explicitly not pursued |
| 3 | Competitive position current and defensible (`SC-POL-011`) |
| 4 | Product operable by its owner (`SC-POL-019`, `SC-POL-010`) |
| 5 | Handover complete, including the "what is not done" section |
| 6 | Open risks, waivers and assumptions listed with owner disposition |
| 7 | Lessons captured (`SC-POL-021`) |
| 8 | Store complete, consistent and backed up |

---

## 7. Definition of Done — Decision

Per `09` §4: drivers non-empty, ≥2 real alternatives with specific rejection reasons, rationale derived from drivers, consequences and risks stated, reversal cost assessed, **re-evaluation trigger present**, authority correct, prior art assessed for applicability where cited.

## 8. Definition of Done — Proposal

Per `10` §6: terminal state reached with `outcome_reason`; if approved, converted to the appropriate governed artifact; if deferred, a re-evaluation trigger exists; if implemented, linked to the work item and its acceptance verdict.

---

## 9. Serva Code 1.0 Ready — Criteria

The executive form is `00` §16 (R1–R15). This section is the verifiable form: each criterion states its evidence. A criterion without evidence is `NOT_VERIFIED` and 1.0 is not Ready.

### R1 — Governance is real

| # | Criterion | Evidence |
|---|---|---|
| R1.1 | Every policy catalogued in `30` §9 has ≥1 binding `policy_refs` in a gate criterion, a schema constraint, or a runtime check | Policy-to-enforcement coverage report (`18` §2) |
| R1.2 | The count of `ADVISORY`-enforcement policies is declared and justified | Constitution `01` §6 |
| R1.3 | Violations produce Audit Events by severity | Test evidence |
| R1.4 | No agent can write an Audit Event | Tool allowlist audit |

### R2 — The Orchestrator can classify and route

| # | Criterion | Evidence |
|---|---|---|
| R2.1 | Every request class in `26` §2.7 produces a classification, profile, department set, agent set, sequence, parallel plan and gate set | Executed scenarios with recorded plans |
| R2.2 | The plan is explainable from stored state, with no engine invocation | Query output |
| R2.3 | Missing foundational artifacts force stage insertion (`04` §5.1) | Scenario evidence |
| R2.4 | `CANNOT_SEPARATE_ROLES` halts rather than merging roles | Scenario evidence |

### R3 — Truth survives everything

| # | Criterion | Evidence |
|---|---|---|
| R3.1 | State survives session end, process kill, machine restart, engine failure mid-run | Executed interruption tests |
| R3.2 | Interrupted runs are recorded and their artifacts quarantined | Test evidence |
| R3.3 | Store corruption is detected, not silently tolerated | Fault-injection evidence |
| R3.4 | Backup and **restore** executed and verified | S1 restore evidence |
| R3.5 | Workspace divergence is detected and classified | Reconciliation test |

### R4 — PASS is falsifiable

| # | Criterion | Evidence |
|---|---|---|
| R4.1 | The store structurally rejects a `PASS` with no bound evidence | Negative test |
| R4.2 | `EXECUTION` evidence cannot be authored by an agent | Tool allowlist + negative test |
| R4.3 | A claimed-but-absent evidence item produces `EVIDENCE_VIOLATION` | Negative test |
| R4.4 | All six `GateVerdict` values are producible and distinct; `JUDGED` appears only as a criterion **basis**, never as a verdict; `WAIVED` appears only as a `CriterionResult` (`31`) | Verdict and `CriterionEvaluation` samples |
| R4.6 | The composition algorithm reproduces every acceptance vector in `31` §4.2, including rows 14–17 (`MAJOR`/`ADVISORY` + `INDETERMINATE`) | Executed composition test vectors |
| R4.8 | No (severity, `CriterionResult`) pair is undefined; no path yields an unqualified `PASS` from a `MAJOR` `INDETERMINATE` | `DC-37`, `DC-38` |
| R4.9 | The V3b→V1 mapping is total and reproduces vectors M1–M9 (`31` §4.4) | `DC-39` |
| R4.10 | A `NOT_VERIFIED` or `BLOCKED` `ArtifactVerifierResult` always carries a `cause`, and the criterion inherits it verbatim | `31` MV-3, MV-4 |
| R4.7 | An `ArtifactVerifierResult` never carries `ESCALATED` (`31` AV-1) | Negative test |
| R4.5 | Tool unavailability yields `NOT_VERIFIED`, never `PASS` | Negative test (`22` DG-1) |

### R5 — Executor never accepts its own work

| # | Criterion | Evidence |
|---|---|---|
| R5.1 | The store refuses an acceptance whose actor equals the producer | Negative test |
| R5.2 | Executor and reviewer runs never share an engine session | Run records |
| R5.3 | The conflict-of-interest matrix (`02` §6) is enforced, not documented | Negative tests per pair |

### R6 — Traceability closes

| # | Criterion | Evidence |
|---|---|---|
| R6.1 | The chain is walkable in both directions | Query output |
| R6.2 | Every orphan class in `08` §5.1 is detectable | Detection tests |
| R6.3 | `ARTIFACT_UNREQUESTED` blocks Acceptance | Negative test |

### R7 — The system knows what it does not know

| # | Criterion | Evidence |
|---|---|---|
| R7.1 | `EXPERT_REVIEW_REQUIRED` is producible with all five fields | Escalation samples |
| R7.2 | Mandatory-expert domains (`17` §8) cannot pass a gate without a resolved escalation or owner risk acceptance | Negative tests |
| R7.3 | The system never auto-resolves its own escalation | Design + negative test |
| R7.4 | `RESEARCH_UNAVAILABLE` is recorded rather than a landscape being invented | Scenario evidence |

### R8 — Improvements are never lost

| # | Criterion | Evidence |
|---|---|---|
| R8.1 | Every observation reaches terminal triage | Store invariant `KI-12` |
| R8.2 | Every proposal reaches a terminal state with a reason | `KI` check |
| R8.3 | Approved major changes cannot be implemented without approval | Negative test |
| R8.4 | Flood controls (`10` §7) never discard; they only re-present | Design review + test |

### R9 — The product can be operated by its owner

| # | Criterion | Evidence |
|---|---|---|
| R9.1 | Admin Operability Review enforced per feature | Gate evidence |
| R9.2 | Configuration register consistent with code (`KI-17`, `12` §8) | Static analysis |
| R9.3 | Operational readiness dispositions complete with evidence | Readiness record |
| R9.4 | Rollback and restore tested | S1 evidence |

### R10 — The product has a stated reason to win

| # | Criterion | Evidence |
|---|---|---|
| R10.1 | Competitive Position required before Architecture Gate | Gate evidence |
| R10.2 | Currency enforced at Acceptance and Release | Gate evidence |
| R10.3 | Claim marking enforced; `INFERRED` cannot alone support a differentiator | Negative test |

### R11 — The owner is never confused about authority

| # | Criterion | Evidence |
|---|---|---|
| R11.1 | Owner-reserved actions (`28` §3) are rejected by the runtime regardless of contract or configuration | Negative tests per action |
| R11.2 | Approval is captured explicitly, never inferred | Interface design + test |
| R11.3 | Attribution is displayed for every action (`20` UX-1) | Interface evidence |
| R11.4 | Ungoverned direct edits appear as divergence, not as governed work (`20` UX-3) | Scenario evidence |

### R12 — Serva Code can explain itself

| # | Criterion | Evidence |
|---|---|---|
| R12.1 | Every query obligation in `08` §8 answerable from the store with no engine running | Query outputs with the engine disabled |
| R12.2 | `nextAction()` returns a defined action or an explicit `DIAGNOSE` | Scenario coverage |
| R12.3 | The interface is fully usable in read mode without the engine (`20` DG-1) | Interface evidence |

### R13 — The system does not overstate its own enforcement *(R2)*

| # | Criterion | Evidence |
|---|---|---|
| R13.1 | Enforcement class is detected accurately on each substrate | `QR-14` |
| R13.2 | Below `HARD`, governance state is `DEGRADED` with reason `CAPABILITY_ENFORCEMENT` | Interface evidence |
| R13.3 | Every verdict produced under `SOFT` carries a `DEGRADED_ENFORCEMENT` qualification, and it propagates | Verdict samples |
| R13.4 | No document claims L1 enforcement for a boundary the substrate does not provide | Spec consistency check `DC-14` |
| R13.7 | `DEGRADED_ENFORCEMENT` qualifications propagate through `31` TX-7 into every dependent gate result | Propagation test |
| R13.5 | Qualification requirements `QR-01`…`QR-16` are executed, with each result recorded as `PASS`, `FAIL` or `NOT_VERIFIED` | Qualification results (`33` §6) |
| R13.6 | Where `QR-09` fails, the evidence-model claim is amended rather than retained | Amendment record (`33` QG-3) |

### R14 — Catalogues have one source *(R2)*

| # | Criterion | Evidence |
|---|---|---|
| R14.1 | Every catalogue's membership and cardinality resolves to `30` | `DC-3`, `DC-8` |
| R14.2 | No document outside `30` states a catalogue count (`CAT-2`) | Spec scan |
| R14.3 | Every agent in `32` appears in `30` §4 and vice versa | `AC-V12` |
| R14.4 | Every enumeration value used anywhere appears in `26` §2, `31`, or a `30` catalogue, and every governed vocabulary has exactly one owner (`26` §2.0) | `DC-8`, `DC-26` |
| R14.6 | No document outside `31` defines or restates an outcome vocabulary or the composition algorithm | `DC-23`, `DC-27` |
| R14.5 | Every contract validates against `32` §7 | Contract validation |
| R14.7 | The `05` §2 field set equals the `32` §8.2 row set exactly, and every canonical agent resolves all 29 fields | `DC-40`, `DC-41` |
| R14.8 | No normative `EvidenceState` vocabulary remains | `DC-42` |

### R15 — History cannot be rewritten *(R2)*

| # | Criterion | Evidence |
|---|---|---|
| R15.1 | No `T-TRACE` entity carries a mutable lifecycle field | `KI-1b` |
| R15.2 | Every live projection matches a replay of its event log | `KI-1c` |
| R15.3 | No record stores `superseded_by`; the reverse index is derived | `KI-1d` |
| R15.6 | No record stores `validity`, `freshness` or an equivalent mutable state field; every `ValidityState` is derived per `31` §3.2 | `KI-1b`, `DC-25` |
| R15.7 | Validity propagates through `depends_on` without any write to the depended-on record | `31` VD-3 test |
| R15.4 | Event digest chains verify; a retroactive edit is detected | Fault-injection test |
| R15.5 | A run interrupted at any point is reconstructible from its event log | Interruption test |

---

## 10. Serva Code 1.0 — Non-Criteria

Explicitly **not** required for 1.0, so that scope does not expand by assumption:

- Multi-tenancy, cloud deployment, or remote access to Serva Code.
- Automatic production deployment (permanently excluded, `SC-POL-030`).
- Support for more than one AI engine simultaneously (the adapter must exist; a second implementation need not).
- A visual editor for workflows, gates or contracts.
- Automatic project generation without owner interaction.
- Predictive scheduling or effort estimation beyond recorded-basis estimates.
- Cross-project analytics beyond the learning interface (`21` §8.1).

---

## 11. Assessment of Readiness

Serva Code 1.0 Ready is itself a verdict, subject to this specification's own rules:

- Assessed by a role that did not build the component under assessment (`SC-POL-006`).
- Each readiness criterion is evaluated as a `CriterionEvaluation` — value in `MET`/`NOT_MET`/`INDETERMINATE`/`NOT_APPLICABLE`/`WAIVED`, with basis `MEASURED`/`JUDGED`/`DERIVED` — and the assessment as a whole composes to a `GateVerdict` per `31` §4.1.
- `PASS_WITH_QUALIFICATION` is permitted and its qualifications are listed (`31` §8). Any `JUDGED`-basis criterion or active waiver forces it — an unqualified `PASS` requires every criterion `MET` on a `MEASURED` or `DERIVED` basis.
- The result is recorded, versioned and auditable.

**A readiness assessment that declares itself ready without evidence is precisely the failure this entire system was built to prevent.** If Serva Code cannot pass its own criteria, the correct outcome is a recorded `NOT_VERIFIED`, not a lowered bar.
