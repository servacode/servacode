# 02 — COMPANY STRUCTURE

**Document ID:** SC-DOC-002
**Status:** BASELINE R4
**Type:** Normative / Organizational
**Owns:** Department existence, tiers, authority, separation rules, RACI, merge/split rationale.
**Does not own:** Department membership and cardinality (`30` §3), individual agent contracts (`32`), decision approval mechanics (`09`).

---

## 1. What Makes a Department

A department exists in Serva Code if and only if it satisfies **all four** existence tests. This is the anti-bloat control required by the founding assignment.

| Test | Question | Fails if |
|---|---|---|
| **T1 — Unique Authority** | Is there a decision class only this department may make? | Its decisions all belong to another department |
| **T2 — Unique Refusal** | Is there something it must refuse even when asked? | It never says no to anything |
| **T3 — Distinct Failure Mode** | Is there a specific way the product fails if this responsibility is unowned? | The failure is already covered elsewhere |
| **T4 — Separation Need** | Would merging it into its nearest neighbor create a conflict of interest or a competence mismatch? | Merging is strictly better |

A responsibility that passes T1–T3 but fails T4 becomes a **function inside another department**, not a department. A responsibility that fails T1 is a **task**, and belongs to a workflow step.

**Departments are structural. Agents are executable.** A department may host one agent, several agents, or (rarely) zero standing agents, with functions performed by an agent of a parent department under an explicit hat. Which agents exist per department: `30` §4; their contracts: `32`. Some departmental duties are discharged by **runtime components** rather than agents (`30` §5) — deterministic checking is not an AI role.

---

## 2. Authority Tiers

```
┌──────────────────────────────────────────────────────────────────┐
│ TIER 0 — OWNER (human)                                           │
│   Business authority · constitutional amendment · reserved acts  │
└───────────────────────────────┬──────────────────────────────────┘
                                │
┌───────────────────────────────▼──────────────────────────────────┐
│ TIER 1 — GOVERNANCE                                              │
│   Orchestrator · Governance & Compliance                         │
│   Routes work · enforces constitution · owns gate execution      │
└───────────────────────────────┬──────────────────────────────────┘
                                │
┌───────────────────────────────▼──────────────────────────────────┐
│ TIER 2 — DEFINITION      (what should exist and why)             │
│   Product Management · Discovery · Business Analysis ·           │
│   Requirements Engineering · Market & Competitive Intelligence   │
└───────────────────────────────┬──────────────────────────────────┘
                                │
┌───────────────────────────────▼──────────────────────────────────┐
│ TIER 3 — DESIGN AUTHORITY  (how it must be shaped)               │
│   Software Architecture · Data Architecture · Security           │
│   Architecture · Infrastructure · Cost Engineering ·             │
│   UX · UI & Design System · Admin Experience                     │
└───────────────────────────────┬──────────────────────────────────┘
                                │
┌───────────────────────────────▼──────────────────────────────────┐
│ TIER 4 — PRODUCTION       (build it)                             │
│   Backend · Frontend · Mobile · Database · Integration           │
└───────────────────────────────┬──────────────────────────────────┘
                                │
┌───────────────────────────────▼──────────────────────────────────┐
│ TIER 5 — ASSURANCE        (prove it) — reports to TIER 1         │
│   Code Review · QA & Test Engineering · Security Testing ·       │
│   Performance Engineering · Acceptance                           │
└───────────────────────────────┬──────────────────────────────────┘
                                │
┌───────────────────────────────▼──────────────────────────────────┐
│ TIER 6 — OPERATION        (run it, learn from it)                │
│   Release Management · Operations · Incident Management ·        │
│   Continuous Improvement · Knowledge & Learning                  │
└──────────────────────────────────────────────────────────────────┘
```

### 2.1 Structural rules (normative)

- **SR-1 · Downward specification.** A tier issues specification to the tier below. Tier N MUST NOT be redefined by Tier N+1.
- **SR-2 · Upward evidence.** Tier N+1 returns artifacts and evidence upward. Disagreement travels upward as a **Proposal** or **Escalation**, never as unilateral deviation.
- **SR-3 · Assurance independence.** Tier 5 reports to Tier 1. No Tier 3 or Tier 4 department may task, override, waive, or re-scope a Tier 5 verdict. This is the structural form of `SC-POL-006`.
- **SR-4 · No lateral commands.** Departments in the same tier cannot task each other. Cross-department work is sequenced by the Orchestrator (`04`).
- **SR-5 · Owner is not in the chain.** Tier 0 is not "the top manager who does the work". The Owner supplies business truth and approves reserved decisions (`28`). Serva Code MUST NOT route engineering questions to Tier 0 (`SC-POL-001`).
- **SR-6 · Every department has a defined escalation target.** Default is Tier 1 (Orchestrator). Tier 1's escalation target is Tier 0.

---

## 3. Department Catalogue

Identifier scheme: `SC-DEPT-###`. Names are stable; numbering never reused.

### TIER 1 — GOVERNANCE

#### SC-DEPT-001 · Orchestration (CEO / Orchestrator)
- **Unique authority:** Classify requests; select lifecycle profile; assemble department/agent set; sequence and parallelize; declare gate applicability; halt work.
- **Unique refusal:** Refuses to execute production work itself; refuses to skip a mandatory gate; refuses to resolve a policy conflict (escalates).
- **Distinct failure if absent:** Work is done in arbitrary order by whoever the prompt reached; stages skipped; no state ownership.
- **Model:** `04_ORCHESTRATOR_MODEL.md`.

#### SC-DEPT-002 · Governance & Compliance
- **Unique authority:** Interpret the constitution for a concrete case; classify violations; author Audit findings; declare a verdict revoked.
- **Unique refusal:** Refuses to grant a policy exception (only the Owner may amend); refuses to accept an unbound PASS.
- **Distinct failure if absent:** The constitution becomes decorative — the Orchestrator would be both the planner and the judge of its own plan.
- **Separation rationale (T4):** Deliberately split from Orchestration. If the entity that schedules work also rules on whether the rules were followed, throughput pressure will erode `SC-POL-005` and `SC-POL-006`. Governance is small but must be independent.
- **DERIVED:** This department was not named in the assignment. It is added because the assignment's own quality bar demands enforcement of the constitution by something other than the executor or the planner.

---

### TIER 2 — DEFINITION

#### SC-DEPT-010 · Product Management
- **Unique authority:** Product scope, prioritization, roadmap, release content, product-level trade-offs, `NO_MARKET` classification.
- **Unique refusal:** Refuses features with no traceable goal; refuses scope expansion without a CR; refuses to prioritize by novelty.
- **Distinct failure if absent:** Feature bloat and a backlog with no ordering principle.

#### SC-DEPT-011 · Discovery
- **Unique authority:** Elicit and structure the problem space: users, jobs, contexts, pains, current alternatives, success definitions. Declare Discovery sufficiency.
- **Unique refusal:** Refuses to convert an unvalidated assumption into a requirement without marking it as an assumption with a validation plan.
- **Distinct failure if absent:** The system builds a well-engineered solution to a misunderstood problem — the most expensive failure available.
- **Separation rationale (T4):** Not merged into Product Management because Discovery's job is to *widen and question* while Product's job is to *narrow and commit*. Merging biases toward premature commitment.

#### SC-DEPT-012 · Business Analysis
- **Unique authority:** Business processes, actors, roles, business rules, states and transitions, business constraints, domain glossary, financial/operational logic (fees, commissions, tiers).
- **Unique refusal:** Refuses to leave a business rule implicit in code; refuses contradictory rules without escalation.
- **Distinct failure if absent:** Business rules get invented by implementers and scattered — a direct `SC-POL-004` violation generator.

#### SC-DEPT-013 · Requirements Engineering
- **Unique authority:** Requirement records, acceptance criteria, NFR set, requirement quality (testable, unambiguous, atomic, traceable), requirement baselining.
- **Unique refusal:** Refuses to baseline a requirement that is not testable or has no acceptance criteria; refuses to accept a solution statement disguised as a requirement.
- **Distinct failure if absent:** `SC-POL-014` is impossible — there is nothing to trace from.
- **Separation rationale (T4):** Split from Business Analysis because BA describes *the business as it is/should be* while RE specifies *what the system must do and how it will be proven*. The competence and the output schema differ, and merging tends to produce prose that cannot be tested.
- **Note:** NFRs are owned here but authored jointly with Architecture, Security Architecture, Infrastructure and Cost Engineering (see RACI §5).

#### SC-DEPT-014 · Market & Competitive Intelligence
- **Unique authority:** Market landscape, competitor analysis, feature comparison, table-stakes determination, market gaps, differentiators, Competitive Position artifact, experiment proposals.
- **Unique refusal:** Refuses to propose a feature without value/cost/risk assessment (anti-bloat); refuses to declare a differentiator without evidence.
- **Distinct failure if absent:** `SC-POL-011` unowned — the product works and loses.
- **Detail:** `11_COMPETITIVE_INNOVATION.md`.
- **Merge decision:** The assignment listed "Research", "Market Intelligence" and "Competitive Innovation" separately. **Merged into one department** because they share inputs, method, evidence type and output artifact, and splitting them creates three departments each failing T4. *General technical research* (technology evaluation) is **not** here — it belongs to the department making the decision, with a shared Research Procedure (`09` §7). Rationale: research is a *method*, not an authority; making it a department would create a body that researches without owning any decision.

---

### TIER 3 — DESIGN AUTHORITY

#### SC-DEPT-020 · Software Architecture
- **Unique authority:** System decomposition, module boundaries, interaction/integration patterns, technology selection (with Data/Security/Infra input), architectural NFR satisfaction, complexity justification, ADRs.
- **Unique refusal:** Refuses complexity without a requirement forcing it (`SC-POL-017`); refuses technology selection without evaluation (`SC-POL-016`); refuses to let implementation define boundaries.
- **Distinct failure if absent:** Structure emerges accidentally from the first file written.

#### SC-DEPT-021 · Data Architecture
- **Unique authority:** Domain data model, ownership of entities, storage strategy, consistency and transaction boundaries, data lifecycle/retention, migration strategy, data classification (with Security Architecture).
- **Unique refusal:** Refuses schema changes without a migration and rollback path; refuses to store data with no declared retention or classification.
- **Distinct failure if absent:** Data model is derived from screens; migrations become one-way doors.
- **Separation rationale (T4):** Split from Software Architecture because data outlives code. Data decisions have the longest reversal cost of any decision class, and merging them into general architecture consistently under-weights that asymmetry.

#### SC-DEPT-022 · Security Architecture
- **Unique authority:** Threat model, trust boundaries, authentication and authorization design, secrets management design, data protection, privacy design, security NFRs, security risk acceptance recommendation.
- **Unique refusal:** Refuses designs with unbounded trust; refuses to accept residual `HIGH` risk without owner acceptance; refuses to defer security to testing (`SC-POL-018`).
- **Distinct failure if absent:** Security becomes a pre-release scan that finds implementation bugs and misses design flaws.
- **Note:** Distinct from Security Testing (`SC-DEPT-052`) — design authority versus verification. Merging them would violate `SC-POL-006`.

#### SC-DEPT-023 · Infrastructure & DevOps
- **Unique authority:** Environments, build and packaging, deployment topology and strategy, configuration and secrets delivery, observability infrastructure, backup/restore mechanics, rollback mechanism.
- **Unique refusal:** Refuses a release path that cannot be rolled back where rollback is in scope; refuses secrets in code or repository.
- **Distinct failure if absent:** The product exists only on the developer's machine (`SC-POL-019`).

#### SC-DEPT-024 · Cost Engineering / FinOps
- **Unique authority:** Cost model of the product (build, run, scale, licensing, third-party), cost NFRs, cost impact of architecture and technology options, budget feasibility opinion. Also owns **Serva Code's own consumption budgets** (`SC-POL-028`).
- **Unique refusal:** Refuses architecture whose running cost is unstated; refuses vendor selection without licensing and lock-in assessment.
- **Distinct failure if absent:** Technically excellent architecture the owner cannot afford to run — invisible until the first bill.
- **Note:** Small department; may be a single agent invoked at Architecture, Technology Selection and Release. It passes T1–T4 because no other department can be trusted to argue against its own preferred design on cost grounds.

#### SC-DEPT-025 · UX
- **Unique authority:** User journeys, information architecture, flows, navigation model, state coverage (empty/loading/error/offline/partial/permission-denied), content strategy, interaction model, usability criteria.
- **Unique refusal:** Refuses flows with unspecified failure/edge states; refuses to design around a requirement it believes is wrong without raising it.
- **Distinct failure if absent:** Screens exist; journeys do not.

#### SC-DEPT-026 · UI & Design System
- **Unique authority:** Design tokens, typography scale, color system and semantic roles, spacing, grid, radius, elevation, motion, component library and component states, RTL/LTR behavior, platform conventions, design exceptions.
- **Unique refusal:** Refuses raw/arbitrary values in product code (`SC-POL-003`); refuses a component that is not defined for all its states; refuses one-off variants without a system decision.
- **Distinct failure if absent:** Visual entropy and unenforceable accessibility.
- **Merge decision:** The assignment listed "UI", "Design System" and "Accessibility" separately. **UI and Design System are merged** (identical authority surface; separate departments would fail T4). **Accessibility is a function held here with an independent verification counterpart in Tier 5** — because accessibility *design* is a design-system property, but accessibility *conformance* must be verified independently (`SC-POL-006`). See `13` §6.

#### SC-DEPT-027 · Admin Experience & Operability
- **Unique authority:** Admin Operability Review per feature (`SC-POL-010`), configuration taxonomy, protected-rule classification, admin information architecture, operational controls, audit/permission surface for the admin.
- **Unique refusal:** Refuses to make a security/financial/structural invariant freely configurable; refuses a feature whose operational surface has not been reviewed.
- **Distinct failure if absent:** Every operational change requires a developer — the failure `SC-POL-010` exists to prevent.
- **Separation rationale (T4):** Not merged into UX. UX optimizes for the end user's journey; Admin Experience optimizes for the owner's ability to *run the business*, and consistently loses when the two compete inside one department.
- **Detail:** `12_ADMIN_OPERABILITY.md`.

---

### TIER 4 — PRODUCTION

#### SC-DEPT-030 · Backend Engineering
- **Authority:** Implementation within architecture; server-side code, APIs, business-rule implementation, jobs, internal module design **within** declared boundaries.
- **Refusal:** Refuses to invent business rules (escalates to BA); refuses to alter contracts unilaterally; refuses to embed design values.
- **Failure if absent:** —

#### SC-DEPT-031 · Frontend Engineering
- **Authority:** Web implementation of UX/UI specs, client state, API consumption, responsive and RTL implementation.
- **Refusal:** Refuses arbitrary design values (`SC-POL-003`); refuses to implement flows with undefined states (returns to UX).

#### SC-DEPT-032 · Mobile Engineering
- **Authority:** Mobile implementation, platform conventions, device capabilities, offline behavior, store-readiness concerns.
- **Refusal:** Same as Frontend, plus refuses to violate platform guidelines without a recorded Design Decision.
- **Applicability:** Instantiated only when the project has a mobile target — a `NOT_APPLICABLE` department is recorded, not silently absent (`SC-POL-024`).

#### SC-DEPT-033 · Database Engineering
- **Authority:** Schema implementation, migrations, indexing, query performance, data access layer, seed/fixture data.
- **Refusal:** Refuses destructive migrations without a reversal plan and a backup verification; refuses schema drift from the Data Architecture model.
- **Separation rationale (T4):** Separate from Data Architecture (design vs. implementation) and from Backend (different competence and different failure modes; DB mistakes are often irreversible).

#### SC-DEPT-034 · Integration Engineering
- **Authority:** Third-party integrations, external API clients, webhooks, payment/notification/identity providers, sandbox vs. live handling, contract/version drift with external systems.
- **Refusal:** Refuses to use live credentials or live endpoints in non-production contexts; refuses integration without failure-mode handling (timeout, retry, idempotency, partial failure).
- **DERIVED:** Not named in the assignment. Added because external integrations are the most common source of production incidents, they cross Backend/Security/Ops boundaries, and their failure modes (idempotency, credentials, sandbox/live confusion) are owned by nobody in the original list.

---

### TIER 5 — ASSURANCE *(reports to Tier 1)*

#### SC-DEPT-050 · Code Review
- **Unique authority:** Verdict on implementation quality: correctness against requirement, standards conformance, SSOT conformance, design-token conformance, scope conformance, maintainability, traceability linkage.
- **Unique refusal:** Refuses to review its own department's output; refuses to PASS with unresolved blocking findings; refuses to review without the requirement and task context.
- **Detail:** `14` §7.

#### SC-DEPT-051 · QA & Test Engineering
- **Unique authority:** Test strategy and levels, test case design from requirements/acceptance criteria, test execution, defect records, QA verdict, coverage adequacy judgment.
- **Unique refusal:** Refuses to derive tests solely from the implementation (which would test what was built, not what was required); refuses PASS without executed evidence.
- **Detail:** `15`.

#### SC-DEPT-052 · Security Testing
- **Unique authority:** Security verification: dependency/vulnerability analysis, secrets scanning, authorization testing, input handling, security regression, findings severity, security verdict.
- **Unique refusal:** Refuses to close a finding on the basis of an assertion that it was fixed; refuses to downgrade severity without owner-recorded risk acceptance.

#### SC-DEPT-053 · Performance Engineering
- **Unique authority:** Performance NFR verification, load/latency/resource measurement, performance regression detection, performance verdict.
- **Unique refusal:** Refuses to declare performance acceptable without measurement against a declared target; refuses targets stated as adjectives ("fast").
- **Applicability:** Scoped per project; `NOT_APPLICABLE` is recorded with reason.

#### SC-DEPT-054 · Acceptance
- **Unique authority:** The final verdict that a Feature/Release satisfies its requirements, acceptance criteria, competitive position and operability — assembled from other verdicts plus traceability completeness. Owns the Acceptance Gate.
- **Unique refusal:** Refuses to accept with stale verdicts (`SC-POL-031`), unexplained traceability orphans, or unresolved mandatory escalations.
- **Separation rationale (T4):** Not merged into QA. QA answers "does it work as tested?"; Acceptance answers "is this the thing we agreed to build, provable end to end, and operable?" These fail differently and merging them lets test-passing masquerade as delivery.
- **DERIVED as a department** (the assignment listed ACCEPTANCE as a lifecycle stage but gave it no owner).

---

### TIER 6 — OPERATION

#### SC-DEPT-060 · Release Management
- **Unique authority:** Release readiness verdict, versioning, release content and notes, release/rollback plan, handover package composition, go/no-go recommendation to the Owner.
- **Unique refusal:** Refuses release with an unmet Release Gate; refuses to release without a rollback path where rollback is in scope; refuses to perform the release act itself where that is owner-reserved (`SC-POL-030`).

#### SC-DEPT-061 · Operations
- **Unique authority:** Runtime operability: monitoring/alerting definition, runbooks, backup/restore verification, health/SLO definition, operational documentation, environment hygiene.
- **Unique refusal:** Refuses "monitoring exists" as evidence without a demonstrated signal; refuses untested restore procedures.

#### SC-DEPT-062 · Incident Management
- **Unique authority:** Incident lifecycle: detection, classification/severity, containment, resolution, post-incident review, corrective actions, incident records.
- **Unique refusal:** Refuses to close an incident without a root cause or an explicit `ROOT_CAUSE_UNDETERMINED` record; refuses to convert a corrective action into a silent code change.
- **Separation rationale (T4):** Not merged into Operations. Incident response operates under time pressure with relaxed process (`22` §8); Operations operates under normal process. Merging them lets emergency shortcuts leak into normal work.

#### SC-DEPT-063 · Continuous Improvement
- **Unique authority:** Post-release analysis, improvement backlog, technical-debt register, metric-driven improvement proposals, periodic health review of the product.
- **Unique refusal:** Refuses improvements without a measured or clearly-argued problem.

#### SC-DEPT-064 · Knowledge & Organizational Learning
- **Unique authority:** Lessons Learned capture and curation, reusable pattern registry, failed-approach registry, applicability assessment interface across projects (`SC-POL-021`).
- **Unique refusal:** Refuses to export raw project data across project boundaries; refuses to publish a lesson as a decision (only as a `CANDIDATE`).
- **DERIVED:** The assignment required organizational learning but assigned it to no department. Given `SC-POL-021`'s "no blind reuse" constraint and the project-isolation requirement in `21` §8, this needs a single owner with a controlled interface — otherwise cross-project leakage happens ad hoc.

---

## 4. Summary Table

| ID | Department | Tier | Standing? | Applicability |
|---|---|---|---|---|
| SC-DEPT-001 | Orchestration | 1 | Always | Always |
| SC-DEPT-002 | Governance & Compliance | 1 | Always | Always |
| SC-DEPT-010 | Product Management | 2 | Always | Always |
| SC-DEPT-011 | Discovery | 2 | Per profile | New product / major feature |
| SC-DEPT-012 | Business Analysis | 2 | Per profile | Any business logic |
| SC-DEPT-013 | Requirements Engineering | 2 | Always | Always |
| SC-DEPT-014 | Market & Competitive Intelligence | 2 | Per profile | Any product with alternatives |
| SC-DEPT-020 | Software Architecture | 3 | Always | Always |
| SC-DEPT-021 | Data Architecture | 3 | Per profile | Any persistent data |
| SC-DEPT-022 | Security Architecture | 3 | Always | Always (depth scaled) |
| SC-DEPT-023 | Infrastructure & DevOps | 3 | Per profile | Any deployed product |
| SC-DEPT-024 | Cost Engineering / FinOps | 3 | Per profile | Any recurring cost or budget |
| SC-DEPT-025 | UX | 3 | Per profile | Any human interface |
| SC-DEPT-026 | UI & Design System | 3 | Per profile | Any visual interface |
| SC-DEPT-027 | Admin Experience & Operability | 3 | Per profile | Any product with an operator |
| SC-DEPT-030 | Backend Engineering | 4 | Per profile | — |
| SC-DEPT-031 | Frontend Engineering | 4 | Per profile | — |
| SC-DEPT-032 | Mobile Engineering | 4 | Per profile | — |
| SC-DEPT-033 | Database Engineering | 4 | Per profile | — |
| SC-DEPT-034 | Integration Engineering | 4 | Per profile | External systems present |
| SC-DEPT-050 | Code Review | 5 | Always | Any code change |
| SC-DEPT-051 | QA & Test Engineering | 5 | Always | Any behavior change |
| SC-DEPT-052 | Security Testing | 5 | Per profile | Depth by risk class |
| SC-DEPT-053 | Performance Engineering | 5 | Per profile | Performance NFRs present |
| SC-DEPT-054 | Acceptance | 5 | Always | Any feature or release |
| SC-DEPT-060 | Release Management | 6 | Per profile | Any release |
| SC-DEPT-061 | Operations | 6 | Per profile | Any operated product |
| SC-DEPT-062 | Incident Management | 6 | On demand | Incidents |
| SC-DEPT-063 | Continuous Improvement | 6 | Per profile | Post-release |
| SC-DEPT-064 | Knowledge & Learning | 6 | Always | Always |

Every department passes T1–T4; the merge and derivation decisions above are the audit trail for why the set is not larger. **Membership and cardinality: `30` §3** (`CAT-2` — this document states no count).

---

## 5. RACI — Cross-Cutting Concerns

Concerns that would otherwise be orphaned or duplicated. `R` = responsible, `A` = accountable (single), `C` = consulted, `I` = informed.

| Concern | A | R | C |
|---|---|---|---|
| Non-Functional Requirements | SC-DEPT-013 | 013 | 020, 021, 022, 023, 024, 025, 053 |
| Threat model | SC-DEPT-022 | 022 | 020, 021, 023, 034 |
| Data classification & retention | SC-DEPT-021 | 021 | 022, 012 |
| Technology selection | SC-DEPT-020 | 020 | 021, 022, 023, 024, 013 |
| Complexity justification | SC-DEPT-020 | 020 | 002, 024 |
| Accessibility design | SC-DEPT-026 | 026 | 025, 013 |
| Accessibility verification | SC-DEPT-051 | 051 | 026 |
| RTL / internationalization | SC-DEPT-026 | 026, 031, 032 | 025, 012 |
| Business rules | SC-DEPT-012 | 012 | 013, 020, 027 |
| Configuration vs. protected rules | SC-DEPT-027 | 027 | 022, 012, 020 |
| Competitive position | SC-DEPT-014 | 014 | 010, 025 |
| Cost model | SC-DEPT-024 | 024 | 020, 023 |
| Observability | SC-DEPT-061 | 061, 023 | 020, 062 |
| Backup & restore | SC-DEPT-061 | 061, 023, 033 | 021 |
| Rollback capability | SC-DEPT-023 | 023, 060 | 033, 020 |
| Traceability integrity | SC-DEPT-054 | 054 | 013, 001, 002 |
| Evidence integrity | SC-DEPT-002 | 002 | all Tier 5 |
| Serva consumption budget | SC-DEPT-024 | 024 | 001 |
| Untrusted-content handling | SC-DEPT-022 | 022 | 001, 002 |
| Lessons learned | SC-DEPT-064 | 064 | all |

**Rule:** every row has exactly one `A`. A concern with two accountable departments is a structural defect and must be resolved by splitting the concern or reassigning it.

---

## 6. Conflict of Interest Matrix

Pairs that MUST NOT be performed by the same agent instance within the same work item.

| Role A | Role B | Reason |
|---|---|---|
| Any Tier 4 producer | Code Review of that artifact | `SC-POL-006` |
| Any producer | Acceptance of that artifact | `SC-POL-006` |
| QA test author | Implementation of the code under test | Tests would encode the implementation |
| Security Architecture | Security Testing of that design | Design authority verifying itself |
| Orchestration | Governance verdict on its own routing | Planner judging its own plan |
| Proposal author | Sole approver of that proposal | `SC-POL-009` |
| Incident responder | Sole author of the post-incident review's root cause | Self-exoneration bias |

Enforcement: the runtime binds `actor_id` to every record and refuses to write a verdict whose actor conflicts per this matrix (`05` §8, `18` §7).

---

## 7. Department Contract Requirement

Every department in §3 MUST have a contract in `06_DEPARTMENT_CONTRACTS.md` specifying: mission, authority level, decisions it may make alone, decisions it must propose, decisions it must escalate, inputs, outputs, required evidence, refusal surface, escalation triggers, and applicability rules. Its **agents** are catalogued in `30` §4 with contracts in `32`.

A department listed here without a contract in `06` is a **specification defect** (`SD-4`, detected by `DC-3`).

---

## 8. Scaling Down: the Minimal Company

Not every work item convenes the full department set (`30` §3). The Orchestrator instantiates a **department set** from the lifecycle profile (`03` §7, `04` §5). Illustrative minimum sets:

| Work class | Departments engaged |
|---|---|
| Typo / copy fix | 001, 013 (string SSOT), 050, 002 |
| Bug fix (non-security) | 001, 012 (if rule-related), 030/031, 050, 051, 054 |
| Small feature | 001, 010, 013, 020(light), 025/026, 027, 03x, 050, 051, 054 |
| Major feature | + 011, 012, 014, 021, 022, 024, 053 |
| New project | All applicable |
| Security issue | 001, 022, 052, 03x, 050, 002, 060 |
| Incident | 062, 061, 03x, 050, 002 |

These are illustrations, not the algorithm. The binding profile definitions are in `03` §7 and the selection logic is in `04` §5.
