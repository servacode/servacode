# 12 — ADMIN OPERABILITY

**Document ID:** SC-DOC-012
**Status:** BASELINE R4
**Type:** Normative / Process
**Owns:** Admin Operability Review, configuration taxonomy, protected rules, admin surface requirements.
**Does not own:** Design system (`13`), security design (`17`), operations of the product in production (`23`).

---

## 1. Mandate

`SC-POL-010` requires that operational decisions the product owner can safely change do not require developer intervention, and that security-critical, financially-critical and structurally-critical rules remain protected.

Both halves matter equally. A product where nothing is configurable is leased to its developer. A product where everything is configurable is a loaded weapon pointed at its own data.

**The output of this department is a boundary**, drawn per feature, between what the operator controls and what the system protects.

---

## 2. Who the Admin Is

In Serva Code's context the "admin" is usually the **product owner** — the same person who commissioned the product. This does not reduce the requirement; it changes its shape:

| Assumption that would be wrong | Reality |
|---|---|
| The owner understands the system's internals | They understood it at handover and will not in six months |
| The owner will not make destructive mistakes | A single operator with full rights and no guardrails is the highest-risk configuration there is |
| Audit logs are unnecessary with one user | The audit log is how the owner reconstructs what *they* did three weeks ago |
| Permissions are unnecessary with one user | Roles will exist later; retrofitting authorization is expensive and error-prone |

**Design rule:** design the admin surface for a competent operator who has forgotten the details, not for the person who just built it.

---

## 3. The Admin Operability Review

Mandatory per feature, before that feature's Implementation Gate (`SC-POL-010`, `03` §4). Owned by `SC-DEPT-027`, performed by `SC-AGENT-140` (Operability Classifier — renamed and re-typed in R2, `30` §10.4).

```
AdminOperabilityReview {
  id, feature_ref, reviewed_at, reviewer,
  answers    : Answer[]        # one per mandated question, all required
  elements   : OperationalElement[]   # what was found
  verdict    : REVIEWED | NO_OPERATIONAL_SURFACE(justification)
  proposals  : SC-PROP-####[]
}
```

### 3.1 Mandated questions

Each must be answered explicitly. `"No"` is a valid answer; silence is not.

| # | Question | If yes, produces |
|---|---|---|
| Q1 | What will the operator need to change about this in the future? | Configuration elements |
| Q2 | What here is a value, threshold, limit, rate, fee, or duration? | Candidate settings |
| Q3 | Does this need to be enabled/disabled independently? | Feature flag |
| Q4 | Does it need scheduling (start, end, recurrence, timezone)? | Schedule surface |
| Q5 | Does access to it need to differ by role? | Permission requirement |
| Q6 | Does a change to it need an audit trail? | Audit requirement |
| Q7 | Does it produce user-facing text, email, or notifications? | Template surface |
| Q8 | Will the operator need to act on many records at once? | Bulk operation |
| Q9 | Does the operator need to see how it is performing? | Reporting requirement |
| Q10 | Are the rules here likely to change often or vary by case? | Rule-engine consideration |
| Q11 | Can an operator action here be wrong, and can it be undone? | Rollback/undo requirement |
| Q12 | What is the worst thing an operator could do here by mistake? | Guardrail requirement |
| Q13 | What must the operator **never** be able to change? | Protected rules |
| Q14 | What does the operator need to know when something goes wrong here? | Observability/diagnostic surface |
| Q15 | Does this depend on external state (integration, credential, quota)? | Operational status surface |

Q11–Q15 are **DERIVED** additions to the assignment's list. Rationale: Q11/Q12 (mistake and reversal) are the difference between a usable admin panel and a dangerous one; Q13 forces the protected boundary to be stated in the same breath as the configurable one; Q14/Q15 are how the operator diagnoses failures without a developer, which is the actual purpose of `SC-POL-010`.

---

## 4. Configuration Taxonomy

Every operational element is classified into exactly one category, with a justification in both directions — why it is this class and why not the adjacent one.

| Class | Who changes it | Change mechanism | Governance |
|---|---|---|---|
| `OWNER_CONFIGURABLE` | Product owner | Admin UI | Audit log; validated; reversible |
| `ADMIN_CONFIGURABLE` | Delegated operator role | Admin UI, permission-gated | Audit log; validated; may require confirmation |
| `DEVELOPER_ONLY` | Developer | Code or deployment configuration | Normal change governance (`09`) |
| `PROTECTED_INVARIANT` | **Nobody at runtime** | Only via code change + full governance | Change requires CR + owner approval |

### 4.1 Classification criteria

An element is `PROTECTED_INVARIANT` if changing it at runtime could:

- weaken authentication, authorization, or an audit trail;
- alter financial correctness (how money is computed, recorded, or reconciled);
- break referential or structural integrity of data;
- bypass a validation that protects data consistency;
- disable a security control;
- alter the meaning of historical records retroactively;
- violate a legal or regulatory obligation.

An element is `DEVELOPER_ONLY` if it is safe but requires understanding of implementation consequences (connection settings, cache strategy, internal thresholds with non-obvious coupling).

Everything else that Q1–Q10 surfaced should be `OWNER_CONFIGURABLE` or `ADMIN_CONFIGURABLE`. **The burden of justification runs both ways**: making something configurable requires stating the guardrails; making something developer-only requires stating why the operator cannot be trusted with it. Neither default is free.

### 4.2 The Configuration Register

```
ConfigurationRegister {
  entries: [ {
    element_id, feature_ref, name, description,
    classification, justification, why_not_adjacent_class,
    data_type, valid_range | allowed_values, default_value,
    validation_rules[], side_effects[],
    requires_confirmation: bool, reversible: bool, undo_mechanism,
    audit_required: bool, permission_ref,
    takes_effect: IMMEDIATE | NEXT_REQUEST | RESTART | SCHEDULED,
    ssot_location                      # SC-POL-004
  } ]
}
```

`takes_effect` is required because an operator who changes a setting and sees no change will change it again, and again. Unstated propagation delay is a common source of operational error.

`ssot_location` binds this register to `SC-POL-004`: a configurable value must have exactly one authoritative location, and the register records it.

---

## 5. Protected Rules

```
ProtectedRule {
  id, statement, feature_refs[],
  protection_reason : SECURITY | FINANCIAL | STRUCTURAL | LEGAL | HISTORICAL_INTEGRITY,
  enforced_at       : where in the system it is enforced,
  bypass_possible   : bool,     # if true, that is a finding
  change_procedure  : CR + approval authority
}
```

Rules:

- **PR-1** A protected rule MUST be enforced in the system, not merely documented. Documentation is not a control.
- **PR-2** `bypass_possible: true` is a security finding routed to `SC-DEPT-022`.
- **PR-3** `KI-17` (`08` §7): no `PROTECTED_INVARIANT` element may appear as configurable in the register. Contradiction is a V1 integrity error.
- **PR-4** Requests to make a protected rule configurable escalate to the owner (`09` §2) and require a Security Architecture assessment. The owner may accept the risk; an agent may not.
- **PR-5** Protected rules are listed in the handover package (`23` §5), because the operator must know what they cannot change and why — otherwise they will look for a way around it.

---

## 6. Admin Surface Requirements

What the Admin Experience department specifies for the product's admin area. Scoped per project — not everything applies everywhere, but every item receives a disposition.

| Area | Requirement |
|---|---|
| **Settings** | Grouped by purpose, not by module; each with description, valid range, default, effect timing |
| **Feature flags** | Current state visible; who changed it and when; effect scope stated |
| **Business rules** | Where rules are configurable, shown in business language, with a preview of effect where possible |
| **Content/templates** | Editable with variable documentation; preview; validation that required variables are present |
| **Permissions & roles** | Role/resource matrix visible; changes audited; a role cannot grant itself more than it has |
| **Audit log** | Immutable, searchable, filterable by actor/subject/time; shows before/after values |
| **Bulk operations** | Preview of affected records, count confirmation, dry-run where feasible, and a reversal path |
| **Destructive actions** | Explicit confirmation naming the object, consequence stated, undo or backup verified first |
| **Scheduling** | Timezone explicit; next-run visible; failure of a scheduled job surfaced |
| **Reports** | Defined per business question, exportable |
| **Search** | Across the entities the operator actually needs to find |
| **Operational status** | Health of integrations, quotas, credentials expiry, background job state |
| **Diagnostics** | Enough to answer "why did this fail" without reading application logs |
| **Guardrails** | Validation before, confirmation during, audit after — for every state-changing action |

The last four rows are **DERIVED**. They exist because the assignment's admin list covers *configuration* thoroughly but *diagnosis* not at all — and an operator who cannot diagnose must call a developer, which is exactly the outcome `SC-POL-010` exists to prevent.

---

## 7. Interaction with Other Governance

| Concern | Interaction |
|---|---|
| **Security (`17`)** | Every configurable element is an input surface: validated, authorized, audited. Configuration is an attack surface and is threat-modeled as one. |
| **SSOT (`SC-POL-004`)** | A configurable value has one authoritative location; code reads it from there, never duplicates a default. |
| **Business rules (`SC-DEPT-012`)** | A rule that is configurable is still a `BusinessRule` record; the register points to it. |
| **Data (`SC-DEPT-021`)** | Configuration changes that affect historical interpretation (e.g. changing a fee) must not retroactively alter past records — this is `HISTORICAL_INTEGRITY` protection. |
| **Design (`13`)** | Admin UI uses the same design system; admin is not a second-class surface with improvised styling. |
| **Testing (`15`)** | Configurable elements are tested at their boundary values and in their invalid ranges; protected rules are tested for non-bypassability. |
| **Operations (`23`)** | Runbooks reference admin controls by name; a runbook step that requires a developer is an operability defect. |

### 7.1 The retroactivity trap

The most commonly missed operability defect: an owner changes a fee, a rate, a tax percentage or a status definition, and the system recomputes historical records with the new value. Financial and legal correctness both break, silently, and the error is discovered months later.

**Rule (DERIVED):** any configurable value that participates in a recorded transaction or a historical computation MUST be versioned with an effective date, and historical records MUST bind to the value in effect at their time. The Admin Operability Review MUST identify such values (Q2 combined with Q13) and the Configuration Register MUST record `HISTORICAL_INTEGRITY` protection for them.

---

## 8. Verification

| Gate | Checks |
|---|---|
| `SC-GATE-DESIGN` | Design-level review complete; register initialized; protected rules identified |
| `SC-GATE-IMPLEMENTATION` | Per-feature review exists (`SC-POL-010`); no unregistered configurable value in code |
| `SC-GATE-QA` | Configurable elements tested at boundaries; protected rules tested for non-bypassability; audit entries produced for admin actions |
| `SC-GATE-SECURITY` | Configuration surface authorized, validated, audited; no privilege escalation via configuration |
| `SC-GATE-ACCEPTANCE` | Every feature has a review; register complete and consistent with code (`KI-17`) |
| `SC-GATE-RELEASE` | Handover documents every configurable element and every protected rule |

Evidence for "no unregistered configurable value in code" is a static analysis check: magic numbers and hard-coded operational values in business logic are findings, in the same way hard-coded design values are (`SC-POL-003`). This is the mechanical enforcement that keeps `SC-POL-010` from being aspirational.

---

## 9. Failure Modes

| ID | Failure | Countermeasure |
|---|---|---|
| `AO-1` | Everything hard-coded; owner needs a developer for any change | Mandatory per-feature review before Implementation Gate |
| `AO-2` | Everything configurable; unsafe and unusable | Four-way classification with two-directional justification |
| `AO-3` | Protected rule documented but not enforced | `PR-1`, `PR-2`; security testing verifies non-bypassability |
| `AO-4` | Configuration change silently retroactive | §7.1 effective-dating rule |
| `AO-5` | Admin action with no audit trail | Q6 mandatory; gate check at QA |
| `AO-6` | Destructive bulk operation with no preview or reversal | Q8/Q11/Q12; admin surface requirements |
| `AO-7` | Setting exists but its effect timing is unclear | `takes_effect` mandatory in register |
| `AO-8` | Operator cannot diagnose a failure | Diagnostics and operational status requirements (§6) |
| `AO-9` | Admin UI diverges from the design system | Design governance applies equally (`13`) |
| `AO-10` | Register drifts from the code over time | Static analysis at Implementation Gate; consistency check at Acceptance |
