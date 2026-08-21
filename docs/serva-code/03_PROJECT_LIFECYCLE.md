# 03 — PROJECT LIFECYCLE

**Document ID:** SC-DOC-003
**Status:** BASELINE R4
**Type:** Normative / Process
**Owns:** Stage definitions, entry/exit conditions, dependency graph, parallelism, tailoring profiles, stage ledger, the Stage Existence Test.
**Does not own:** Stage membership and cardinality (`30` §6), gate criteria detail (`18`), routing algorithm (`04`), workflow execution semantics (`07`).

**R2 note:** R1 contained thirty stages while claiming twenty-six. R2 applied the Stage Existence Test (§1.4) to all thirty and retired four (§1.5). The canonical stage set and its cardinality live in `30` §6; this document defines what each stage *does*.

---

## 1. Model

The lifecycle is a **directed graph of stages with typed dependencies**, not an ordered list. It is:

- **Tailorable** — a *profile* selects the applicable subset (`SC-POL-024`).
- **Re-entrant** — CONTINUOUS_IMPROVEMENT feeds INTAKE; any gate FAIL can force a backward transition.
- **Iterative in BUILD** — IMPLEMENTATION → CODE_REVIEW → QA cycles per feature, not once per project.
- **Accounted** — every stage in the full lifecycle has a disposition on every work item: `EXECUTED`, `SKIPPED(reason)`, `NOT_APPLICABLE(profile)`, `IN_PROGRESS`, `BLOCKED`, or `FAILED`.

### 1.1 Stage record schema

| Field | Meaning |
|---|---|
| `id` | `SC-STAGE-###` |
| `name` | Canonical name |
| `phase` | A–G |
| `owner` | Accountable department (single) |
| `participants` | Consulted departments |
| `entry` | Conditions that must hold before the stage may start |
| `exit` | Conditions that must hold for the stage to be complete |
| `artifacts` | Records/artifacts produced (typed, in `08`) |
| `gate` | Gate that evaluates the stage, or `NONE` with reason |
| `dependencies` | Upstream stages and dependency type |
| `parallel_with` | Stages that may run concurrently |
| `iteration` | `ONCE` \| `PER_FEATURE` \| `PER_RELEASE` \| `CONTINUOUS` |
| `skippable` | `NEVER` \| `BY_PROFILE` \| `BY_DECISION` |

### 1.2 Dependency types

| Type | Meaning | Example |
|---|---|---|
| `HARD` | Downstream cannot start until upstream exits | REQUIREMENTS → PLANNING |
| `SOFT` | Downstream may start on partial upstream output; must reconcile before its own exit | UX may start on draft requirements |
| `INFORM` | Upstream output is an input but not a blocker | MARKET_RESEARCH → UX |
| `FEEDBACK` | Downstream output may force upstream revision | FEASIBILITY → REQUIREMENTS |

Only `HARD` blocks. `SOFT` is the primary lever for compressing elapsed time and is why the lifecycle is not a waterfall.

### 1.3 Stage states — two distinct machines

**Clarified in R3.** A stage has a *live position* and an *appended record per attempt*. They are different machines with different mutability, and R2 conflated them (`31` §6.1).

| Machine | Vocabulary | Mutability | Answers |
|---|---|---|---|
| `StageExecutionState` (`31` V5c) | `NOT_STARTED · IN_PROGRESS · IN_GATE · REWORK · BLOCKED · COMPLETE` | Mutable live pointer | *Where is this stage right now?* |
| `StageLedgerDisposition` (`31` V5d) | `EXECUTED · IN_PROGRESS · BLOCKED · SKIPPED · NOT_APPLICABLE · FAILED · ABANDONED` | **Immutable, appended per attempt** | *What happened on each attempt?* |

`REWORK` exists only in the live machine. It is **not** a disposition, because "we are trying again" is not an outcome — the outcome of the failed attempt is `FAILED` (`31` PS-1). Gate verdict to state mapping: `31` §6.2.

The live machine:

```
      ┌──────────────┐
      │ NOT_STARTED  │
      └──────┬───────┘
             │ entry conditions satisfied
      ┌──────▼───────┐   blocked (dependency / escalation / owner input)
      │ IN_PROGRESS  │◄────────────────────────────┐
      └──────┬───────┘                             │
             │ exit conditions claimed             │
      ┌──────▼───────┐                      ┌──────┴──────┐
      │ IN_GATE      │                      │  BLOCKED    │
      └──┬────────┬──┘                      └─────────────┘
   PASS  │        │ FAIL / NOT_VERIFIED
   ┌─────▼──┐  ┌──▼────────────┐
   │COMPLETE│  │ REWORK        │──► back to IN_PROGRESS
   └────────┘  └───────────────┘

  Terminal alternatives:  SKIPPED(reason) · NOT_APPLICABLE(profile) · ABANDONED(decision)
```

Every gate evaluation appends exactly one `StageLedgerEntry` for the attempt it evaluated (`31` PS-2), whatever the live machine does next.

`ABANDONED` requires a Decision Record. There is no silent exit from a stage.

### 1.4 Stage Existence Test (SET)

**New in R2.** A stage exists only if it satisfies **both** mandatory criteria and **at least one** distinguishing criterion.

| # | Criterion | Kind |
|---|---|---|
| `SET-1` | Produces a distinct artifact class no other stage produces | Mandatory |
| `SET-2` | Has entry and exit conditions that are independently evaluable | Mandatory |
| `SET-3a` | Has a distinct accountable department | Distinguishing |
| `SET-3b` | Has its own quality gate | Distinguishing |
| `SET-3c` | Occupies a dependency-graph position that cannot be expressed as a step inside another stage | Distinguishing |
| `SET-4` | Is not reducible to a parallel step whose omission would be invisible | Mandatory |

**Rationale for the shape of this test:** an activity that shares its owner *and* its gate *and* its dependency position with another stage is a **workflow step**, not a stage. Modelling it as a stage creates a boundary the system must maintain, gate and account for, while adding no decision point — false granularity that makes the lifecycle look more rigorous than it is.

### 1.5 R2 stage retirements

Four stages failed the SET. Each failed the same way: same accountable department, same gate, no distinct dependency position. Full disposition register: `30` §10.5.

| Retired | Merged into | Failure | What was preserved |
|---|---|---|---|
| `SC-STAGE-001` IDEA | `SC-STAGE-002` INTAKE | `SET-3a/b/c` all fail — same owner, no gate, strictly-first position expressible as a step | The `Idea` record remains a mandatory, immutable INTAKE work product and an explicit `SC-GATE-INTAKE` criterion |
| `SC-STAGE-012` NFR | `SC-STAGE-011` REQUIREMENTS | Same owner (`SC-DEPT-013`), same gate, ran `SOFT`-parallel | NFR dimension coverage remains an explicit gate criterion; `SC-AGENT-051` remains a distinct agent with a distinct context |
| `SC-STAGE-014` COMPETITIVE_INNOVATION | `SC-STAGE-013` | Same owner (`SC-DEPT-014`), same gate; the internal ordering is workflow sequencing | The `CompetitivePosition` artifact and the `HARD` edge into ARCHITECTURE are unchanged (`SC-POL-011`) |
| `SC-STAGE-051` HANDOVER | `SC-STAGE-050` RELEASE | Same owner (`SC-DEPT-060`), same gate — and the handover package is composed *before* the Release Gate evaluates it, so it was never downstream | The package and its mandatory "what is not done" section remain a Release Gate criterion |

**Two stages were re-examined and kept**, because keeping them is not obvious:

- **`SC-STAGE-016` RISK** shares `SC-GATE-FEASIBILITY` with FEASIBILITY but has a **distinct accountable department** (`SC-DEPT-002`, not `SC-DEPT-020`). Merging would make the architect accountable for assessing the risk of their own architecture — a conflict of interest, not a simplification.
- **`SC-STAGE-023` TECHNOLOGY_SELECTION** shares its owner with ARCHITECTURE but has **its own gate** and a `HARD` dependency on DATA_ARCHITECTURE and SECURITY_ARCHITECTURE that ARCHITECTURE does not have. It cannot be a step inside ARCHITECTURE without breaking the dependency graph.

> **Note on the resulting number.** The test produced twenty-six stages, which happens to equal R1's incorrect claim. That is arithmetic coincidence. The four retirements rest on one consistently-applied rule; had the rule produced twenty-four or twenty-eight, `30` §6 would record that instead.

---

## 2. Phase A — FRAME

### SC-STAGE-002 · INTAKE
- **Owner:** SC-DEPT-010 · **Participants:** 011, 013, 024 · **Gate:** `SC-GATE-INTAKE`
- **Purpose:** Capture the raw idea verbatim, then convert it into a structured client-input record: problem statement, business goals, audience, constraints, budget, deadline, known commercial requirements, success definition.
- **Entry:** A project is created.
- **Exit:**
  - **An `Idea` record exists containing the original text unaltered, with capture date and source** (absorbed from retired `SC-STAGE-001`). It is immutable and is the only record of what was actually asked; every later reinterpretation is diffable against it, which is how scope drift becomes detectable rather than arguable.
  - Problem statement recorded and non-empty.
  - ≥1 business goal recorded, each with a success indicator (may be qualitative, must be stated).
  - Audience described.
  - Constraints enumerated, each typed (`TECHNICAL` / `BUSINESS` / `LEGAL` / `RESOURCE` / `TIME` / `EXISTING_SYSTEM`) with a source.
  - Budget and deadline recorded or explicitly marked `NOT_SPECIFIED`.
  - **No engineering decision has been requested from the client** (`SC-POL-001`).
  - Unknowns are recorded as `OpenQuestion` items, not guessed.
- **Artifacts:** `Idea`, `ClientInput`, `Constraint[]`, `ProjectGoal[]`, `OpenQuestion[]`.
- **Failure modes:** Client supplies a solution instead of a problem → BA/Discovery must extract the underlying problem and record the stated solution as a `Constraint` or a `Preference`, never as a requirement.

### SC-STAGE-003 · DISCOVERY
- **Owner:** SC-DEPT-011 · **Participants:** 012, 014, 025 · **Gate:** `SC-GATE-DISCOVERY`
- **Purpose:** Understand the problem space: users and segments, jobs to be done, current alternatives and workarounds, pains, context of use, environmental constraints, assumptions.
- **Entry:** INTAKE complete (`HARD`).
- **Exit:**
  - User segments identified with their goals.
  - Current alternative (including "manual process" / "do nothing") documented — **mandatory**, because `SC-POL-011` cannot be satisfied without knowing what is being displaced.
  - Assumptions explicitly listed, each with `validated | unvalidated | invalidated` and a validation approach for unvalidated ones.
  - Discovery sufficiency declared by the owner department with reasoning.
- **Artifacts:** `UserSegment[]`, `JobToBeDone[]`, `Assumption[]`, `DiscoveryFindings`.
- **Skippable:** BY_PROFILE (bug fixes, small changes to an already-discovered product).

### SC-STAGE-004 · PRODUCT_VALIDATION
- **Owner:** SC-DEPT-010 · **Participants:** 011, 014, 024 · **Gate:** `SC-GATE-PRODUCT_VALIDATION`
- **Purpose:** Decide whether the product concept is worth building, and in what form. Explicitly permits the outcome "do not build this" or "build something narrower".
- **Entry:** DISCOVERY complete (`HARD`); MARKET_RESEARCH partial (`SOFT`).
- **Exit:**
  - Problem/solution fit argued, with the reasoning recorded.
  - Value hypothesis stated.
  - Riskiest assumptions identified and ranked.
  - A recommendation recorded: `PROCEED` / `PROCEED_REDUCED` / `PIVOT` / `DO_NOT_BUILD`, with rationale.
  - **Owner decision recorded** — this is a Tier-0 business decision, not a Serva decision (`SC-POL-001`).
- **DERIVED emphasis:** The assignment lists this stage; Phase 1 adds that `DO_NOT_BUILD` must be a permitted, non-exceptional outcome. A system that structurally cannot recommend against building is a system that always builds.

---

## 3. Phase B — DEFINE

### SC-STAGE-010 · BUSINESS_ANALYSIS
- **Owner:** SC-DEPT-012 · **Participants:** 010, 013, 027 · **Gate:** included in `SC-GATE-REQUIREMENTS`
- **Purpose:** Model the business: actors, roles, processes, business rules, entity states and transitions, financial logic, domain glossary.
- **Entry:** DISCOVERY complete (`HARD`).
- **Exit:**
  - Actors and roles enumerated with their permissions in business terms.
  - Business processes modeled end to end, including exception paths.
  - Business rules recorded individually and identified (`SC-BR-###`), each with source and rationale.
  - State machines defined for every entity that has a lifecycle, with all transitions and their guards.
  - Domain glossary established — one term, one meaning (`SC-POL-004` for language).
  - Contradictions between rules resolved or escalated; **no unresolved contradiction may exit**.
- **Artifacts:** `BusinessRule[]`, `Actor[]`, `ProcessModel[]`, `StateMachine[]`, `Glossary`.

### SC-STAGE-011 · REQUIREMENTS
- **Owner:** SC-DEPT-013 · **Participants:** 010, 012, 025, 027 · **Gate:** `SC-GATE-REQUIREMENTS`
- **Purpose:** Produce testable, traceable functional requirements with acceptance criteria.
- **Entry:** BUSINESS_ANALYSIS complete (`HARD`); DISCOVERY complete (`HARD`).
- **Exit — each requirement:**
  - Has an ID, a statement of *what*, not *how*.
  - Has ≥1 acceptance criterion in a verifiable form.
  - Is atomic (one obligation), unambiguous, and non-contradictory with the set.
  - Traces upward to ≥1 `ProjectGoal` or `Constraint` or `BusinessRule`.
  - Has a priority (`MUST` / `SHOULD` / `COULD` / `WON'T_NOW`).
  - Has a source.
- **Exit — the set:**
  - Every `ProjectGoal` is covered by ≥1 requirement, or explicitly deferred with a record.
  - No requirement contradicts another (checked, not assumed).
  - Requirement baseline created and versioned.
- **Exit — non-functional coverage** (absorbed from retired `SC-STAGE-012`; participants for this work product: 020, 021, 022, 023, 024, 025, 026, 053, 061). NFRs are elicited alongside functional requirements, not after. Each dimension carries a measurable target or an explicit `NOT_APPLICABLE(reason)`:
  performance/latency · throughput/capacity · scalability expectation · availability expectation · security (per `17`) · privacy/data protection · accessibility conformance target · internationalization/RTL · compatibility (browsers/devices/OS) · usability targets · observability · maintainability · portability · cost ceilings · compliance/regulatory · data retention · backup/recovery objectives (RPO/RTO where applicable).
  - **Rule:** an NFR expressed as an adjective ("fast", "secure", "scalable") MUST NOT exit. Either it becomes measurable or it becomes `NOT_APPLICABLE(reason)`. Enforced by `SC-AGENT-051`, which remains a distinct agent with a distinct context precisely so that this discipline survives the stage merge.
- **Artifacts:** `Requirement[]`, `AcceptanceCriterion[]`, `NFR[]`, `RequirementBaseline`.

### SC-STAGE-013 · MARKET_AND_COMPETITIVE_INTELLIGENCE
- **Owner:** SC-DEPT-014 · **Participants:** 010, 025 · **Gate:** `SC-GATE-COMPETITIVE`
- **Renamed in R2**, absorbing retired `SC-STAGE-014` COMPETITIVE_INNOVATION.
- **Purpose:** Establish the competitive landscape, determine table stakes, and produce the **Competitive Position** (`SC-POL-011`).
- **Entry:** INTAKE complete (`HARD`), DISCOVERY (`SOFT`). **Runs in parallel with BUSINESS_ANALYSIS and REQUIREMENTS.**
- **Internal ordering (workflow sequencing, not a stage boundary):** research → comparison and table stakes → differentiation and position. The second half has a `HARD` dependency on the first; that is `SC-WF-003`-style step ordering inside one stage.
- **Exit:**
  - Competitor set identified with inclusion and exclusion justified; feature comparison produced; table-stakes list derived; gaps identified.
  - Findings carry sources and a `valid_until` (`SC-POL-016` freshness).
  - Competitive Position artifact exists, naming alternatives, the table-stakes coverage plan, and ≥1 justified differentiator with an argued reason a user would choose this product.
  - All resulting feature ideas raised as **Proposals**, not requirements (`SC-POL-009`).
- **Artifacts:** `CompetitorProfile[]`, `FeatureComparison`, `TableStakes[]`, `MarketGap[]`, `ResearchFinding[]`, `Differentiator[]`, `CompetitivePosition`, `Proposal[]`.
- **Detail:** `11`.

### SC-STAGE-015 · FEASIBILITY
- **Owner:** SC-DEPT-020 · **Participants:** 021, 022, 023, 024, 010 · **Gate:** `SC-GATE-FEASIBILITY`
- **Purpose:** Determine whether the requirements + NFRs are achievable within the constraints, and at what cost.
- **Entry:** REQUIREMENTS and NFR complete (`HARD`); MARKET research (`INFORM`).
- **Exit:**
  - Technical feasibility assessed per requirement class.
  - Cost estimate produced (build + run) with a stated confidence and its basis.
  - Schedule feasibility assessed against any deadline constraint.
  - Infeasible or high-cost requirements identified and returned to REQUIREMENTS (`FEEDBACK` dependency) with options: reduce, defer, change approach, accept cost.
  - Verdict: `FEASIBLE` / `FEASIBLE_WITH_CHANGES` / `NOT_FEASIBLE`.
- **Artifacts:** `FeasibilityAssessment`, `CostModel`.

### SC-STAGE-016 · RISK
- **Owner:** SC-DEPT-002 · **Participants:** 020, 022, 024, 010 · **Gate:** `SC-GATE-FEASIBILITY`
- **Purpose:** Identify, assess and plan for project risks.
- **Entry:** FEASIBILITY in progress (`SOFT`).
- **Exit:** risk register populated; each risk has category, probability, impact, exposure, mitigation, owner, trigger and a status; risks above the project's threshold have an owner-visible mitigation or an owner-recorded acceptance.
- **Artifacts:** `Risk[]`.
- **Continues:** risk register is `CONTINUOUS` after this stage — new risks are added throughout.

---

## 4. Phase C — DESIGN

### SC-STAGE-020 · ARCHITECTURE
- **Owner:** SC-DEPT-020 · **Participants:** 021, 022, 023, 024, 013 · **Gate:** `SC-GATE-ARCHITECTURE`
- **Entry:** REQUIREMENTS + NFR complete (`HARD`); FEASIBILITY complete (`HARD`); COMPETITIVE_INNOVATION complete (`HARD`, per `SC-POL-011`).
- **Exit:**
  - System decomposition with named modules and explicit responsibilities.
  - Module boundaries and interaction contracts defined.
  - Cross-cutting concerns placed (auth, logging, error handling, i18n, configuration, feature flags).
  - Each NFR mapped to the architectural mechanism that satisfies it, or flagged unsatisfied.
  - **Complexity Justification** for every flagged pattern (`SC-POL-017`).
  - **SSOT Register** established (`SC-POL-004`) naming each truth element and its location.
  - ADRs recorded for every significant decision (`SC-POL-002`, `SC-POL-015`).
- **Artifacts:** `ArchitectureModel`, `ADR[]`, `SSOTRegister`, `ComplexityJustification[]`.

### SC-STAGE-021 · DATA_ARCHITECTURE
- **Owner:** SC-DEPT-021 · **Participants:** 022, 012, 033 · **Gate:** `SC-GATE-ARCHITECTURE`
- **Parallel with:** ARCHITECTURE, SECURITY_ARCHITECTURE (mutually `SOFT`, reconciled before the shared gate).
- **Exit:** domain data model; entity ownership; storage strategy per data class; consistency and transaction boundaries; **data classification** (with 022); retention and deletion policy per class; migration and evolution strategy; identifier strategy; audit-data strategy.
- **Artifacts:** `DataModel`, `DataClassification[]`, `RetentionPolicy[]`, `MigrationStrategy`.

### SC-STAGE-022 · SECURITY_ARCHITECTURE
- **Owner:** SC-DEPT-022 · **Participants:** 020, 021, 023, 034 · **Gate:** `SC-GATE-ARCHITECTURE` + `SC-GATE-SECURITY_DESIGN`
- **Exit:** project security risk classification; threat model with trust boundaries and abuse cases; authentication design; authorization model mapped to the BA role model; secrets management design; data protection design (at rest, in transit, in logs); privacy design; input-handling and output-encoding strategy; security NFRs mapped to mechanisms; residual risks recorded.
- **Artifacts:** `ThreatModel`, `TrustBoundary[]`, `AuthDesign`, `SecurityDecision[]`.
- **Detail:** `17`.

### SC-STAGE-023 · TECHNOLOGY_SELECTION
- **Owner:** SC-DEPT-020 · **Participants:** 021, 022, 023, 024 · **Gate:** `SC-GATE-TECHNOLOGY`
- **Entry:** ARCHITECTURE + DATA_ARCHITECTURE + SECURITY_ARCHITECTURE sufficiently defined (`HARD`).
- **Rule:** `SC-POL-016` applies fully. No default stack.
- **Exit:** for each technology decision — candidates identified (≥2 unless a Constraint fixes it); evaluation criteria declared **before** scoring; research findings with sources and `valid_until`; scored comparison; decision recorded with rejection reasons, risks, lock-in assessment, licensing assessment, cost assessment and a re-evaluation trigger.
- **Artifacts:** `TechnologyEvaluation[]`, `TechnologyDecision[]` (ADR class).

### SC-STAGE-024 · UX
- **Owner:** SC-DEPT-025 · **Participants:** 010, 013, 026, 027 · **Gate:** `SC-GATE-DESIGN`
- **Entry:** REQUIREMENTS complete (`HARD`); ARCHITECTURE (`SOFT`); MARKET research (`INFORM`).
- **Exit:** user journeys per segment; information architecture; navigation model; flow per requirement cluster; **complete state coverage** for every screen/flow: default, empty, loading, partial, error, offline (where applicable), permission-denied, success; form and validation behavior; content/microcopy strategy; RTL/LTR behavioral implications; usability criteria per journey.
- **Rule:** a flow with an undefined state MUST NOT exit. This is the most common source of downstream implementation invention.
- **Artifacts:** `UserJourney[]`, `Flow[]`, `InformationArchitecture`, `StateCoverage[]`.

### SC-STAGE-025 · DESIGN_SYSTEM
- **Owner:** SC-DEPT-026 · **Participants:** 025, 031, 032 · **Gate:** `SC-GATE-DESIGN`
- **Entry:** UX (`SOFT`), brand/product strategy from INTAKE/Product (`HARD` for tokens).
- **Exit:** design tokens defined and centralized (color incl. semantic roles, typography scale, spacing scale, radius, elevation, motion, breakpoints, z-index); component inventory with **all states per component**; composition rules; layout/grid; RTL mirroring rules; accessibility rules bound to tokens (contrast, target size, focus visibility); the enforcement rule that raw values are forbidden in product code (`SC-POL-003`).
- **Artifacts:** `DesignTokenSet`, `ComponentSpec[]`, `AccessibilitySpec`, `DesignDecision[]`.
- **Detail:** `13`.

### SC-STAGE-026 · ADMIN_OPERABILITY
- **Owner:** SC-DEPT-027 · **Participants:** 012, 022, 020 · **Gate:** `SC-GATE-DESIGN` + per-feature at `SC-GATE-IMPLEMENTATION`
- **Entry:** BUSINESS_ANALYSIS complete (`HARD`); REQUIREMENTS (`HARD`).
- **Exit:** an Admin Operability Review per feature (`12` §3) answering the mandated questions; a Configuration Register classifying each operational element as `OWNER_CONFIGURABLE`, `ADMIN_CONFIGURABLE`, `DEVELOPER_ONLY`, or `PROTECTED_INVARIANT` with justification; admin information architecture; audit/permission requirements for admin actions.
- **Artifacts:** `AdminOperabilityReview[]`, `ConfigurationRegister`, `ProtectedRule[]`.
- **Iteration:** `PER_FEATURE` — this stage runs once at design level and again per feature.

---

## 5. Phase D — PLAN

### SC-STAGE-030 · PLANNING
- **Owner:** SC-DEPT-001 · **Participants:** 010, 020, 013, 024 · **Gate:** `SC-GATE-PLAN`
- **Entry:** ARCHITECTURE, TECHNOLOGY_SELECTION, DESIGN (UX + Design System) complete (`HARD`); ADMIN_OPERABILITY design-level complete (`HARD`).
- **Exit:**
  - Features derived from requirements, each tracing to ≥1 requirement.
  - Tasks derived from features, each with a **declared scope boundary** (`SC-POL-009`), inputs, expected outputs, required evidence, assigned department, and gate set.
  - Dependency graph between tasks; parallelizable sets identified.
  - Sequencing that respects architecture (contracts before consumers, schema before access, tokens before UI).
  - Test strategy defined at level (`15`).
  - Budget allocation per feature (`SC-POL-028`).
  - Definition of Done per level attached (`24`).
- **Artifacts:** `Feature[]`, `Task[]`, `DependencyGraph`, `TestStrategy`, `Plan`.

---

## 6. Phase E–G — BUILD, ASSURE, DELIVER

### SC-STAGE-040 · IMPLEMENTATION
- **Owner:** Tier 4 department per task · **Gate:** `SC-GATE-IMPLEMENTATION` · **Iteration:** PER_FEATURE
- **Entry:** Task exists with scope boundary; upstream design artifacts baselined; Admin Operability Review for the feature complete.
- **Exit:** code satisfies the task; changed-artifact set ⊆ declared scope; no raw design values; SSOT respected; standards conformance; unit tests as required by strategy; traceability links written (`Task ↔ Implementation`); self-review and observations recorded (`SC-POL-007`); build succeeds with captured evidence.
- **Forbidden in this stage:** inventing business rules, changing contracts, changing schema without the DB department, expanding scope, resolving requirement ambiguity silently (must escalate).

### SC-STAGE-041 · CODE_REVIEW
- **Owner:** SC-DEPT-050 · **Gate:** `SC-GATE-CODE_REVIEW` · **Iteration:** PER_FEATURE
- **Entry:** IMPLEMENTATION claims exit; **reviewer ≠ implementer** (`SC-POL-006`).
- **Exit:** findings recorded with severity; all `BLOCKING` findings resolved or waived by proper authority; conformance verdicts on requirement satisfaction, standards, SSOT, tokens, scope, security-sensitive patterns, traceability.
- **Detail:** `14` §7.

### SC-STAGE-042 · QA
- **Owner:** SC-DEPT-051 · **Gate:** `SC-GATE-QA` · **Iteration:** PER_FEATURE / PER_RELEASE
- **Entry:** CODE_REVIEW passed for the scope under test.
- **Exit:** tests derived from requirements and acceptance criteria (not from the implementation); executed with captured evidence; defects recorded and dispositioned; coverage against acceptance criteria reported; regression executed for the affected surface; accessibility verification where applicable.
- **Detail:** `15`.

### SC-STAGE-043 · SECURITY_TESTING
- **Owner:** SC-DEPT-052 · **Gate:** `SC-GATE-SECURITY` · **Parallel with:** QA, PERFORMANCE
- **Exit:** scope per project risk class executed (dependency analysis, secrets scan, authz tests, input handling, security regression); findings with severity; `HIGH`+ resolved or owner-accepted; evidence captured.

### SC-STAGE-044 · PERFORMANCE
- **Owner:** SC-DEPT-053 · **Gate:** `SC-GATE-PERFORMANCE` · **Parallel with:** QA, SECURITY_TESTING
- **Exit:** each performance NFR measured against its target with captured measurement evidence; regressions identified; `NOT_APPLICABLE` recorded where scoped out.

### SC-STAGE-045 · ACCEPTANCE
- **Owner:** SC-DEPT-054 · **Gate:** `SC-GATE-ACCEPTANCE`
- **Entry:** CODE_REVIEW, QA, SECURITY_TESTING, PERFORMANCE verdicts exist and are **non-stale** (`SC-POL-031`).
- **Exit:**
  - Every `MUST` requirement in scope verified with evidence.
  - Traceability closed both directions; orphans explained (`SC-POL-014`).
  - Competitive Position current (`SC-POL-011`).
  - Admin Operability Reviews complete for all features in scope (`SC-POL-010`).
  - No unresolved mandatory escalation.
  - No stale verdicts.
  - Acceptance verdict recorded by a role that did not produce the work (`SC-POL-006`).

### SC-STAGE-050 · RELEASE
- **Owner:** SC-DEPT-060 · **Participants:** 061, 027, 064 · **Gate:** `SC-GATE-RELEASE`
- **Absorbed retired `SC-STAGE-051` HANDOVER in R2.** The handover package is composed *before* the Release Gate evaluates it (gate criterion 9), so it was never a downstream stage — it is a release work product.
- **Exit:**
  - Operational Readiness satisfied per `SC-POL-019` scoping; version assigned; release notes including qualifications, waivers and accepted risks; rollback plan **tested** where in scope; backup and restore verified where applicable.
  - **Handover package complete** — architecture summary, decisions and their rationale, operational runbooks, admin/configuration guide with what is protected and why, known limitations, open risks, recovery procedures, credentials *handling instructions* (never credential values, `28` R-14), where the project truth lives, and the mandatory **"what is not done"** section (`23` HO-1).
  - Go/no-go recommendation prepared.
- **The act of releasing to production is owner-reserved** (`SC-POL-030`); Serva prepares, stages, verifies and recommends.
- **Handover applies even when the owner is the sole operator**, because the owner's future self has none of this context.
- **Detail:** `23`.

### SC-STAGE-052 · OPERATIONS
- **Owner:** SC-DEPT-061 · **Iteration:** CONTINUOUS · **Gate:** NONE (continuous; measured by health review)
- **Exit:** N/A (continuous). Produces `HealthReview[]`, `OperationalMetric[]`, `Runbook[]`.

### SC-STAGE-053 · CONTINUOUS_IMPROVEMENT
- **Owner:** SC-DEPT-063 · **Participants:** 064, 010, 014 · **Iteration:** CONTINUOUS
- **Purpose:** Post-release analysis → improvement proposals → back to INTAKE. Also triggers `SC-DEPT-064` lessons capture.
- **Loop-closing rule:** proposals from here enter the same governance path as any other (`10`), and re-enter the lifecycle at the stage appropriate to their class, not automatically at IMPLEMENTATION.

### SC-STAGE-054 · INCIDENT *(DERIVED stage)*
- **Owner:** SC-DEPT-062 · **Iteration:** ON_DEMAND · **Gate:** `SC-GATE-INCIDENT_CLOSURE`
- **Why derived:** The assignment lists Incident Management as a responsibility but not as a lifecycle stage. Incidents follow a *different* path with compressed process and retroactive records (`22` §8); without an explicit stage, incident work would either be blocked by normal gates or would bypass governance entirely.
- **Exit:** severity classified; containment recorded; resolution recorded; root cause or explicit `ROOT_CAUSE_UNDETERMINED`; corrective actions raised as governed work items; retroactive records completed for any process relaxations taken during response.

---

## 7. Lifecycle Profiles

A **profile** is a named, versioned selection of stages, gates and departments. Profiles are `T-CANON` records. The Orchestrator selects one per work item (`04` §5); the selection and all omissions are recorded (`SC-POL-024`).

| Profile | Applies to | Stages executed | Notes |
|---|---|---|---|
| `PRF-NEW-PRODUCT` | New project from an idea | All applicable | The full lifecycle |
| `PRF-MAJOR-FEATURE` | Significant addition to an existing product | 002(delta), 003(delta), 010–016(delta), 020–026(delta), 030, 040–045, 050 | Delta = scoped to the change |
| `PRF-FEATURE` | Ordinary feature | 011(delta), 024–026(delta), 030, 040–045 | Discovery skipped by profile |
| `PRF-SMALL-CHANGE` | Small, bounded change | 030(light), 040, 041, 042, 045 | Requires no new requirement |
| `PRF-BUG-FIX` | Defect repair | 040, 041, 042, 045 + root-cause record | Regression test mandatory |
| `PRF-SECURITY-FIX` | Security defect | 022(assess), 040, 041, 043, 045, 050 | Expedited path, `17` §9 |
| `PRF-ARCHITECTURE-CHANGE` | Structural change | 013(re-check), 015, 016, 020–023, 030, 040–045 | Mandatory Impact Analysis |
| `PRF-DESIGN-CHANGE` | Design system / UX change | 024, 025, 030, 040, 041, 042 | Token change → impact across all consumers |
| `PRF-RESEARCH` | Investigation only | 013 or targeted research | Produces findings + proposals; **produces no code** |
| `PRF-RELEASE` | Release of accepted work | 045(verify), 050 | No new implementation; 050 includes handover |
| `PRF-INCIDENT` | Production incident | 054 (+ fix path afterwards) | Compressed; retroactive records mandatory |
| `PRF-OPERATIONAL-CHANGE` | Config/operational change | 026(review), 040(config only), 045 | May require zero code |
| `PRF-DOCUMENTATION` | Docs only | 040(docs), 041 | No QA unless docs are product surface |

### 7.1 Profile rules (normative)

- **PR-1** Profiles MUST NOT omit `SC-GATE-CODE_REVIEW` for any change to product code, or `SC-GATE-ACCEPTANCE` for any change that alters product behavior.
- **PR-2** Profiles MUST NOT omit security assessment for changes touching authentication, authorization, secrets, payments, personal data, file upload, deserialization, or external input.
- **PR-3** A profile MAY be **upgraded** mid-flight if the work is found to be larger than classified. Downgrading requires a Decision (`09`). Upgrade is the default direction under uncertainty.
- **PR-4** Every omitted stage is recorded as `SKIPPED(reason)` or `NOT_APPLICABLE(profile)` on the work item's stage ledger.
- **PR-5** A profile is a `T-CANON` record with a version; changing a profile definition is a governed change.

---

## 8. Dependency Graph (consolidated)

```
INTAKE  (includes Idea capture)
  ├HARD→ DISCOVERY ─HARD→ PRODUCT_VALIDATION
  │        ├HARD→ BUSINESS_ANALYSIS ─HARD→ REQUIREMENTS  (functional + NFR)
  │        └INFORM→ UX
  └HARD→ MARKET_AND_COMPETITIVE_INTELLIGENCE   (research → comparison → position)

   REQUIREMENTS ─HARD→ FEASIBILITY ─SOFT↔ RISK
        │                  └FEEDBACK→ REQUIREMENTS
        │
        └HARD→ ARCHITECTURE ─SOFT↔ DATA_ARCH ─SOFT↔ SECURITY_ARCH
                     └HARD→ TECHNOLOGY_SELECTION   (HARD on DATA_ARCH + SECURITY_ARCH)
   REQUIREMENTS ─HARD→ UX ─SOFT→ DESIGN_SYSTEM
   BUSINESS_ANALYSIS ─HARD→ ADMIN_OPERABILITY
   MARKET_AND_COMPETITIVE_INTELLIGENCE ─HARD→ ARCHITECTURE        (SC-POL-011)

   {ARCHITECTURE, TECH_SELECTION, UX, DESIGN_SYSTEM, ADMIN_OPERABILITY} ─HARD→ PLANNING
                                                                          └HARD→ IMPLEMENTATION
                                                                                  └HARD→ CODE_REVIEW
                                                                                          └HARD→ {QA ∥ SECURITY_TESTING ∥ PERFORMANCE}
                                                                                                    └HARD→ ACCEPTANCE
                                                                                                            └HARD→ RELEASE  (includes handover)
                                                                                                                     └→ OPERATIONS ─→ CONTINUOUS_IMPROVEMENT ─→(INTAKE)
   INCIDENT ──(any time)──→ containment → fix path (PRF-SECURITY-FIX | PRF-BUG-FIX) → CONTINUOUS_IMPROVEMENT
```

### 8.1 Parallelism map

| Group | Stages that may run concurrently | Reconciliation point |
|---|---|---|
| P1 | MARKET_AND_COMPETITIVE_INTELLIGENCE ∥ BUSINESS_ANALYSIS ∥ REQUIREMENTS(draft) | `SC-GATE-REQUIREMENTS` |
| P2 | ARCHITECTURE ∥ DATA_ARCHITECTURE ∥ SECURITY_ARCHITECTURE | `SC-GATE-ARCHITECTURE` |
| P3 | UX ∥ (ARCHITECTURE at `SOFT`) | `SC-GATE-DESIGN` |
| P4 | Independent tasks within PLANNING's dependency graph | per-task gates |
| P5 | QA ∥ SECURITY_TESTING ∥ PERFORMANCE | `SC-GATE-ACCEPTANCE` |
| P6 | Documentation ∥ IMPLEMENTATION | `SC-GATE-RELEASE` |

**Reconciliation rule:** stages that ran in parallel MUST be reconciled at their shared gate — contradictions between concurrent outputs are a gate FAIL, not a merge decision made by whichever finished last.

---

## 9. Backward Transitions

Every backward transition follows `31` §6.2: the ledger records `FAILED` for the attempt, the stage's live state becomes `REWORK` then `IN_PROGRESS`, and the work item and workflow enter `REWORK`.

| Trigger | Returns to | Required record |
|---|---|---|
| Requirements Gate FAIL | REQUIREMENTS | Gate result + findings |
| Feasibility says `NOT_FEASIBLE` | REQUIREMENTS / PRODUCT_VALIDATION | FeasibilityAssessment |
| Architecture Gate FAIL | ARCHITECTURE | Gate result |
| Ambiguous requirement found during IMPLEMENTATION | REQUIREMENTS (escalation) | Escalation record |
| Missing UX state found during IMPLEMENTATION | UX | Escalation record |
| Code Review FAIL | IMPLEMENTATION | Findings |
| QA FAIL | IMPLEMENTATION | Defect records |
| Security finding `HIGH`+ | SECURITY_ARCHITECTURE or IMPLEMENTATION per root cause | Finding + classification |
| Performance target missed | ARCHITECTURE or IMPLEMENTATION per root cause | Measurement evidence |
| Acceptance FAIL | the stage owning the deficiency | Acceptance findings |
| Approved Change Request | the stage where the change originates | CR + Impact Analysis |
| Incident root cause = design defect | ARCHITECTURE / SECURITY_ARCHITECTURE | Post-incident review |

**Rule:** a backward transition MUST NOT silently discard downstream artifacts. Downstream results **derive** to `STALE` (`31` §3.2) and are re-verified, not deleted — no field is written on them.

---

## 10. Stage Ledger

Every work item carries a **Stage Ledger**: for each stage in the full lifecycle, a disposition, a timestamp, an actor, and a reason where applicable. The ledger is the mechanical implementation of `SC-POL-024` and is what makes "we didn't skip anything" a checkable statement rather than a claim.

| Field | Values |
|---|---|
| `stage_id` | `SC-STAGE-###` |
| `disposition` | `StageLedgerDisposition` (`31` V5d). **`REWORK` is not a member** (`31` PS-1) |
| `reason` | required for `SKIPPED`, `NOT_APPLICABLE`, `ABANDONED`, `BLOCKED` |
| `profile_ref` | profile that authorized the disposition |
| `gate_result_ref` | for `EXECUTED` / `FAILED` |
| `decided_by` | actor |
| `at` | timestamp |

**Invariant:** the union of dispositions covers the full stage set. A stage with no ledger entry is a store integrity error (`21` §6). Entries are **immutable and appended**; a stage attempted three times has three entries, not one that was edited twice.
