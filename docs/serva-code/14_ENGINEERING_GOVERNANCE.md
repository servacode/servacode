# 14 — ENGINEERING GOVERNANCE

**Document ID:** SC-DOC-014
**Status:** BASELINE R4
**Type:** Normative / Process
**Owns:** Coding standards process, SSOT register, scope discipline, dependency governance, code review criteria, traceability enforcement in code.
**Does not own:** Test strategy (`15`), security controls (`17`), design values (`13`).

---

## 1. Mandate

Implementation in Serva Code is **execution of specification**, not design-by-typing. Tier 4 departments have `EXECUTE` authority only (`06`, Tier 4 shared contract). This document defines the rules that make that boundary real and checkable.

The governing question at every point: **could an implementer have invented this, and if so, is that invention recorded as a decision?**

---

## 2. Coding Standards Are Selected, Not Assumed

There is no universal standard set, because there is no universal stack (`SC-POL-016`). Standards are selected per project after Technology Selection and recorded as a `PROCESS`-domain decision.

```
CodingStandard {
  id, project_ref, language/platform,
  formatting        : tool + configuration (automated, non-negotiable at review)
  linting           : ruleset + severity mapping
  naming            : conventions per construct
  structure         : file/module organization rules derived from ArchitectureModel
  error_handling    : how errors are raised, wrapped, logged, surfaced
  logging           : levels, what must never be logged (bound to DataClassification)
  typing            : strictness posture
  async/concurrency : rules
  testing           : structure, naming, placement
  documentation     : what must be documented and where
  security          : secure-coding rules bound to the threat model (17)
  performance       : rules where NFRs demand them
  forbidden         : patterns explicitly disallowed with reasons
  source            : community standard adopted | adapted | authored, with rationale
}
```

Rules:

- **CS-1** Formatting is automated. It is never a review finding — a human or agent arguing about formatting is wasted assurance capacity.
- **CS-2** Every rule is machine-checkable or explicitly marked `REVIEW_ONLY` with its review criterion. A standard that is neither is decoration.
- **CS-3** Standards are recorded once per project and referenced (`SC-POL-025`), never restated per task.
- **CS-4** A rule that fires constantly is re-evaluated. Standards that everyone violates are wrong standards, and the pattern is a `SC-DEPT-064` signal.

---

## 3. Scope Discipline

Every task carries a **scope boundary** declared at PLANNING (`03` §5):

```
ScopeBoundary {
  may_create[], may_modify[], may_delete[],
  must_not_touch[],           # explicit, for high-risk adjacent areas
  rationale
}
```

The runtime computes `scope_actual` from observed writes and compares (`05` §4.1). `scope_actual \ scope_declared` is a `SCOPE_VIOLATION` (`SC-POL-009`).

### 3.1 What an implementer does when the task is too small

The correct move is **never** to widen the scope. It is:

| Situation | Correct action |
|---|---|
| The fix requires touching an adjacent module | Escalate; the Orchestrator re-scopes or splits the task |
| A defect is found outside scope | Raise an `Observation` → `Defect` + Proposal; do not fix it |
| The requirement is ambiguous | Escalate to Requirements Engineering; do not choose an interpretation |
| A design state is missing | Escalate to UX; do not invent the state |
| A business rule is unclear | Escalate to Business Analysis; do not infer the rule |
| A better architecture is apparent | Raise a Proposal; implement as specified |
| A dependency would help | Request via dependency governance (§5); do not add it |

**This table is the operational core of `SC-POL-009`.** Every row describes a moment where an unconstrained AI implementer would do the helpful thing and thereby destroy traceability.

---

## 4. Single Source of Truth Register

`SC-POL-004` requires one authoritative location per truth element. The register makes it checkable.

```
SSOTRegister {
  entries: [ {
    element, category, authoritative_location,
    consumers[], derivation_mechanism,       # for derived copies
    duplication_decision_ref,                # required if duplicated
    validation_check                          # how drift is detected
  } ]
}
```

Mandatory categories (from `SC-POL-004`), each with a location or `NOT_APPLICABLE`:

`identity/branding · naming · design tokens · user-facing strings · translations · business rules · statuses & state machines · fees/commissions/financial constants · settings · permissions · roles · feature flags · templates · configuration · API contracts · validation rules · error codes & messages · routes/URLs · event names · date/time & locale handling`

The last six are **DERIVED** additions. Each is a truth element that in practice gets duplicated across layers — error messages defined in three places, validation rules implemented separately on client and server, event names typed by hand — and each duplication is a defect generator that no test suite reliably catches.

### 4.1 Legitimate duplication

Permitted where recorded (`SC-POL-004` exception): caches, denormalization for performance, generated code, client-side mirrors of server validation. Each requires: the SSOT it derives from, the generation or synchronization mechanism, and the drift-detection check. **Client-side validation mirroring server-side rules is the canonical case** — and the register must state that the server remains authoritative, so nobody later "optimizes" by trusting the client.

---

## 5. Dependency Governance

Adding a third-party dependency is a `SIGNIFICANT` decision at minimum (`09` §3). An implementer MUST NOT add one on their own initiative.

Assessment required before adoption:

| Dimension | Question |
|---|---|
| Necessity | Does this replace code we would otherwise write, and how much? |
| Maintenance | Active? Release cadence? Bus factor? |
| Security | Known vulnerabilities? Transitive surface? |
| License | Compatible with the product's intended use and distribution? |
| Size/cost | Bundle, runtime, or operational cost impact |
| Lock-in | Exit cost if it is abandoned |
| Alternatives | What else was considered, including writing it |

Rules:

- **DEP-1** Transitive dependencies count. A small package pulling a large tree is a large dependency.
- **DEP-2** Dependency additions are visible in Code Review as a distinct finding class, never buried in a diff.
- **DEP-3** A dependency for a trivial function is refused by default (`SC-POL-017`).
- **DEP-4** Version pinning and update policy are recorded decisions, not defaults.
- **DEP-5** Dependency inventory and vulnerability status are Security Testing evidence (`06` SC-DEPT-052) and expire (`08` §6.3) — a clean scan from six months ago is not current evidence.

---

## 6. Implementation Rules

| ID | Rule | Enforced by |
|---|---|---|
| `IM-1` | No hard-coded design values (`SC-POL-003`) | Static analysis (`13` §7) |
| `IM-2` | No hard-coded user-facing strings | Static analysis |
| `IM-3` | No hard-coded operational values that should be configuration (`SC-POL-010`) | Static analysis + `12` §8 |
| `IM-4` | No business rule implemented without a `BusinessRule` link | Code Review + traceability |
| `IM-5` | No secret, credential, token or key in code or repository | Secrets scan (blocking) |
| `IM-6` | No writing outside the declared scope | Runtime scope diff |
| `IM-7` | No change to a module contract without an approved decision | Code Review + contract diff |
| `IM-8` | No schema change outside Database Engineering | Code Review |
| `IM-9` | No new dependency without an approved decision | Dependency diff at review |
| `IM-10` | Every implementation artifact links to its task and requirement | Traceability check |
| `IM-11` | Error handling per the standard; no silently swallowed errors | Static analysis + review |
| `IM-12` | Nothing classified sensitive is logged (`DataClassification`) | Static analysis + review |
| `IM-13` | Public interfaces documented per the standard | Review |
| `IM-14` | No commented-out code, dead code, or `TODO` without an issue link | Static analysis |
| `IM-15` | No weakening of a security control without a Security decision | Security review |
| `IM-16` | Idempotency where the operation may be retried (integrations, jobs, webhooks) | Review + failure-path tests |

`IM-16` is **DERIVED**. Retry-driven duplication (double charges, duplicate records, repeated notifications) is one of the most damaging and least-tested defect classes in real systems, and it is invisible in a happy-path test suite.

---

## 7. Code Review

Owned by `SC-DEPT-050`. Reviewer MUST NOT be the implementer (`SC-POL-006`), enforced by actor binding (`05` §8, L2).

### 7.1 Review dimensions

| # | Dimension | Question | Determinism |
|---|---|---|---|
| 1 | **Requirement satisfaction** | Does this do what the requirement says, including its acceptance criteria? | JUDGMENT |
| 2 | **Scope conformance** | Is every change within the declared boundary? | DETERMINISTIC |
| 3 | **Correctness** | Logic, edge cases, boundaries, null/empty, ordering, concurrency | JUDGMENT |
| 4 | **Error handling** | Are failures handled, surfaced and logged appropriately? | JUDGMENT |
| 5 | **Standards conformance** | Lint, naming, structure | DETERMINISTIC |
| 6 | **SSOT conformance** | Is truth duplicated? | DETERMINISTIC + JUDGMENT |
| 7 | **Design conformance** | Tokens, component specs, states | DETERMINISTIC |
| 8 | **Security** | Input validation, authz checks, injection surfaces, secrets, sensitive logging | JUDGMENT + DETERMINISTIC |
| 9 | **Data** | Schema conformance, migration safety, query patterns | JUDGMENT |
| 10 | **Test adequacy** | Do tests cover the acceptance criteria and the failure paths? | JUDGMENT |
| 11 | **Traceability** | Are links present? | DETERMINISTIC |
| 12 | **Dependencies** | Any added? Approved? | DETERMINISTIC |
| 13 | **Maintainability** | Complexity, duplication, naming clarity, coupling | JUDGMENT |
| 14 | **Operability** | Configurable values registered; diagnostics adequate (`12`) | JUDGMENT |
| 15 | **Performance** | Only where an NFR applies; otherwise not a review dimension | JUDGMENT |

**Rule:** deterministic dimensions are checked by tooling before a judgment reviewer is invoked. Spending a judgment review on lint findings wastes the scarcest assurance capacity, and it trains the review toward superficial findings.

### 7.2 Finding severities

| Severity | Definition | Effect |
|---|---|---|
| `BLOCKING` | Requirement unmet, incorrect, unsafe, or policy-violating | Gate FAIL |
| `MAJOR` | Real defect or significant quality issue | Fix, or waive with authority (`09` §9) |
| `MINOR` | Genuine but low-impact | Fix or record as debt |
| `SUGGESTION` | Preference; not actionable as a requirement | Optional; never blocks |

**Rule:** a reviewer that returns only `SUGGESTION` findings on a substantial change must state what it checked and found sound. "Looks good" is an invalid verifier output (`05` §13, AF-14).

### 7.3 Review output

`CodeReviewResult` is an **`ArtifactVerifierResult`** (`31` V3b, schema in `16` §5) with `role = CODE_REVIEW`. It is not a separate record type and does not have its own vocabulary.

```
CodeReviewResult : ArtifactVerifierResult {
  role                   = CODE_REVIEW
  subject                : artifact refs @ versions
  value                  : PASS | PASS_WITH_QUALIFICATION | FAIL | NOT_VERIFIED | BLOCKED
  dimensions_checked     : from §7.1
  dimensions_not_checked : [ {dimension, reason} ]     # mandatory
  findings               : severity per §7.2
  basis_summary          : which dimensions were MEASURED / DERIVED / JUDGED
}
```

`BLOCKED` applies when the diff or a required input (requirement, contract, standard) is unavailable. `ESCALATED` is **not** available — a reviewer that must escalate produces a `RunOutcome` of `ESCALATED` and no review result (`31` AV-1).

`dimensions_not_checked` is mandatory (`31` AV-4). A review that silently skipped the security dimension while reporting `PASS` is more dangerous than no review, because it produces false confidence with a governance record behind it. A dimension checked on a judged basis puts the result at `PASS_WITH_QUALIFICATION`, never `PASS`.

---

## 8. Traceability in Code

`SC-POL-014` requires the chain to close. In practice:

| Link | How it is established |
|---|---|
| Task ↔ Artifact | Runtime records artifacts written by each run (`05` §4.1) |
| Requirement ↔ Task | Established at PLANNING |
| Requirement ↔ Test | Test cases derive from acceptance criteria (`15`) |
| Artifact ↔ Test | Test execution records what it exercised |
| BusinessRule ↔ Artifact | Declared by the implementer, verified at review |

Links live in the store, not primarily in code comments — comments drift and cannot be queried. Where a code-level marker is used, the store remains authoritative and drift is detected at reconciliation (`SC-POL-032`).

**Orphan detection** runs at QA and Acceptance (`08` §5.1). `ARTIFACT_UNREQUESTED` is the finding that catches unrequested work, and it is checked on every change — not only at release.

---

## 9. Refactoring

Refactoring is behavior-preserving change. It is governed because AI implementers refactor readily and refactoring destroys review boundaries when mixed with functional change.

- **RF-1** Refactoring and functional change MUST NOT be combined in one task. Mixed changes make review unable to distinguish intended behavior change from accident.
- **RF-2** Refactoring requires characterization tests that pass before and after with identical results.
- **RF-3** Refactoring beyond the scope boundary is a Proposal (`HYGIENE` class), not an action.
- **RF-4** Large refactors are `M3`+, requiring impact analysis.

---

## 10. Build and Static Analysis Evidence

Required for every implementation task (`SC-POL-023` — runtime-captured, never asserted):

| Evidence | Content |
|---|---|
| Build result | Command, exit code, output, artifact digests, timestamp |
| Lint/format result | Command, exit code, findings |
| Type check | Where applicable |
| Test run | `15`, with per-test outcomes |
| Security scan | Secrets, dependencies |
| Design scan | Token conformance, literals, logical properties |
| Scope diff | Computed by runtime |
| Traceability check | Links present |

An implementation task whose build evidence is missing yields an `INDETERMINATE` criterion (reason `EVIDENCE_ABSENT`) and therefore a `NOT_VERIFIED` gate verdict — never `PASS`, regardless of how confident the implementing agent's report is (`31` §4.2 example 5).

---

## 11. Failure Modes

| ID | Failure | Countermeasure |
|---|---|---|
| `EG-1` | Implementer invents a business rule | IM-4 + review dimension 1 + BA source marking |
| `EG-2` | Implementer resolves ambiguity silently | §3.1 escalation table + mandatory `assumptions_made` (`05` §6.1) |
| `EG-3` | Silent scope expansion | Runtime scope diff (L3 enforcement) |
| `EG-4` | Dependency added casually | DEP-1..DEP-5; review dimension 12 |
| `EG-5` | Truth duplicated across layers | SSOT register + review dimension 6 |
| `EG-6` | Secret committed | Blocking secrets scan; never waivable |
| `EG-7` | Refactor mixed with feature work | RF-1 |
| `EG-8` | Review that checks style and misses correctness | Deterministic checks run first; `dimensions_not_checked` mandatory |
| `EG-9` | Traceability links omitted | IM-10; deterministic check at review |
| `EG-10` | Training-data patterns conflicting with this project's architecture | Review dimension 1 + architecture conformance; context bundle carries `ModuleContract` |
| `EG-11` | Retry duplication in integrations/jobs | IM-16 + mandatory failure-path tests (`06` SC-DEPT-034) |
| `EG-12` | Sensitive data in logs | IM-12 + `DataClassification` in the context bundle |
