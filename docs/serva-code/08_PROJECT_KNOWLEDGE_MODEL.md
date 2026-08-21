# 08 — PROJECT KNOWLEDGE MODEL

**Document ID:** SC-DOC-008
**Status:** BASELINE R4
**Type:** Normative / Data Model
**Owns:** Entity catalogue, relations, durability tiers, invariants, integrity rules, versioning and staleness semantics.
**Does not own:** Physical storage layout (`21`), evidence semantics (`16`), decision process (`09`).

---

## 1. Purpose

The Project Knowledge Store is **the project**. Code is an artifact of it. If the store and the code disagree, the system must detect the disagreement (`SC-POL-032`) — it must never silently prefer either.

Three requirements shape the whole model:

1. **`SC-POL-020`** — no truth depends on an AI session.
2. **`SC-POL-022`** — history is append-only; corrections supersede, never overwrite.
3. **`SC-POL-014`** — traceability must be walkable in both directions.

---

## 2. Durability Tiers

| Tier | Contents | Mutability | Deletion |
|---|---|---|---|
| **T-CANON** | Baselined truth | New **versions** only; prior versions retained and immutable | Never (superseded/retired instead) |
| **T-WORKING** | In-flight artifacts and **live projections** | Mutable; never authoritative over `T-TRACE` | Marked `ABANDONED`, retained |
| **T-TRACE** | **Immutable events and terminal snapshots** of what happened | **Append-only. Never edited.** | Never (owner-authorized pruning only, `21` §7) |
| **T-DERIVED** | Computed views (matrices, reports, indexes, reverse links, states) | Regenerated at will | Freely — must be reconstructible from the other tiers |

**T-DERIVED is DERIVED (Phase 1):** without it, expensive computed views like the traceability matrix would either be recomputed constantly or cached as if they were truth. Marking them regenerable-and-never-authoritative prevents a cached view becoming a second source of truth (`SC-POL-004`).

### 2.1 The R2 immutability repair

Audit R2 found that R1 placed **lifecycle-bearing entities** in `T-TRACE` while also declaring `T-TRACE` immutable. An entity created before an operation and completed afterwards is mutable by definition; an entity later "marked superseded" is edited by definition. The contradiction was not confined to `AgentRun` — it applied to every `T-TRACE` entity with a lifecycle.

**The general rule adopted in R2:**

> `T-TRACE` contains **only** immutable events and immutable terminal snapshots.
> Anything with a lifecycle is modelled as three parts: a `T-WORKING` live projection, a `T-TRACE` event log, and a `T-DERIVED` state projection.
> **The event log is the authority. The projection is a cache.**

| Entity | R1 (contradictory) | R2 (coherent) |
|---|---|---|
| `AgentRun` | Mutable record in `T-TRACE` | `AgentRunEvent[]` (TRACE) + live projection (WORKING) + `AgentRunRecord` snapshot (TRACE) — `05` §4 |
| `WorkflowRun` | Mutable state, ledger, checkpoints in `T-TRACE` | `WorkflowRunEvent[]` (TRACE) + live projection (WORKING) + terminal snapshot (TRACE) |
| `Handoff` | `accepted_by`/`acceptance` written later | `HandoffOffered` + `HandoffAccepted`/`HandoffRejected` events (TRACE); `Handoff` is a `T-DERIVED` view |
| `ToolCallRecord` | Single record covering request and result | `TOOL_REQUESTED` / `TOOL_DECIDED` / `TOOL_RESULT_CAPTURED` events, so a crash mid-call is reconstructible and denials are permanent |
| `Evidence` | Mutable `state` field | Content and provenance immutable; `ValidityState` is `T-DERIVED` (`31` §3); revocation and dispute are **appended records** |
| `GateResult` / verdicts | Mutable `freshness` field | Immutable result; freshness derived by `SC-RTC-004` |
| `Incident` | Mutable record | `IncidentEvent[]` (TRACE) + `Incident` canon record versioned at closure |
| `StageLedgerEntry` | Ledger mutated per stage | Each entry immutable and appended; the ledger is a `T-DERIVED` view |

**Nothing was lost by this change.** Crash reconstruction improves (the log records intent before action), evidence provenance is unchanged, auditability improves (the digest chain makes edits detectable rather than merely forbidden), and no history is rewritten.

---

## 3. Entity Catalogue

Every entity carries the **common envelope**:

```
id · type · project_id · version · created_at · created_by · tier ·
digest · supersedes · links[] · trust · source
```

**Changed in R2:** `superseded_by` is removed from the envelope — it required editing an old record to point at its successor. It is now a `T-DERIVED` reverse index built from forward `supersedes` links (§6.2). `state` is removed from immutable-tier entities; where an entity has a lifecycle, its state is a projection (§2.1).

`source` is one of `OWNER_STATED | DERIVED | RESEARCHED(citation) | INFERRED | SYSTEM`. This single field is what keeps hallucinated content distinguishable from established fact throughout the system — it is used by gates, by acceptance, and by owner-facing views.

### 3.1 Project & Framing

| Entity | Tier | Key fields | Notes |
|---|---|---|---|
| `Project` | CANON | name, created, profile, risk_class, budgets, governance_state | Root |
| `Idea` | CANON | raw_text, captured_at | Immutable origin (`03` §2) |
| `ClientInput` | CANON | problem, audience, success_definition, commercial_requirements | |
| `ProjectGoal` | CANON | statement, success_indicator, priority | Traceability root |
| `Constraint` | CANON | type, statement, source, negotiable | `TECHNICAL/BUSINESS/LEGAL/RESOURCE/TIME/EXISTING_SYSTEM` |
| `Assumption` | CANON | statement, status, validation_approach, load_bearing | Blocks unqualified PASS if load-bearing and unvalidated |
| `OpenQuestion` | WORKING | question, blocks[], asked_of, state | |

### 3.2 Discovery & Market

| Entity | Tier | Key fields |
|---|---|---|
| `UserSegment` | CANON | name, description, goals, context |
| `JobToBeDone` | CANON | statement, segment_ref, current_solution |
| `CurrentAlternative` | CANON | description, why_used, weaknesses | mandatory per segment |
| `Pain` | CANON | statement, severity, segment_ref |
| `CompetitorProfile` | CANON | name, positioning, features[], sources[], valid_until |
| `FeatureComparison` | DERIVED | matrix over competitors × dimensions |
| `TableStakes` | CANON | capability, evidence_refs |
| `MarketGap` | CANON | description, evidence, confidence |
| `Differentiator` | CANON | statement, basis, defensibility, competitor_coverage |
| `CompetitivePosition` | CANON | why_chosen, alternatives[], table_stakes_plan, differentiators[], valid_until |
| `ResearchFinding` | CANON | question, finding, sources[], confidence, valid_until |

### 3.3 Business & Requirements

| Entity | Tier | Key fields |
|---|---|---|
| `Actor` / `Role` | CANON | name, description, permissions_business_terms |
| `BusinessRule` | CANON | id, statement, rationale, source, owner_confirmed |
| `ProcessModel` | CANON | steps, actors, exceptions |
| `StateMachine` | CANON | entity_ref, states[], transitions[] with guards |
| `Glossary` | CANON | term → definition (one meaning per term) |
| `Requirement` | CANON | statement, priority, source, rationale, traces_to[] |
| `AcceptanceCriterion` | CANON | requirement_ref, criterion, verification_method |
| `NFR` | CANON | dimension, target (measurable), measurement_method, applicability |
| `RequirementBaseline` | CANON | requirement_versions[], baselined_at, by |

### 3.4 Design Authority

| Entity | Tier | Key fields |
|---|---|---|
| `ArchitectureModel` | CANON | modules[], responsibilities, interactions |
| `ModuleContract` | CANON | interface, invariants, owner_module |
| `SSOTRegister` | CANON | truth_element → location, consumers[], derivation |
| `ComplexityJustification` | CANON | pattern, forcing_requirement, simpler_option_rejected |
| `NFRMapping` | DERIVED | NFR → mechanism → verification |
| `DataModel` | CANON | entities, relations, ownership |
| `DataClassification` | CANON | data_element, class, handling_rules |
| `RetentionPolicy` | CANON | data_class, retention, deletion_method |
| `MigrationStrategy` | CANON | approach, reversibility, testing_requirement |
| `ThreatModel` | CANON | boundaries[], threats[]→mitigations[], abuse_cases[] |
| `TrustBoundary` | CANON | between, controls |
| `AuthorizationModel` | CANON | role × resource × action matrix |
| `ResidualRisk` | CANON | risk, severity, owner_disposition |
| `EnvironmentModel` | CANON | environments, purposes, data policy |
| `RollbackSpec` / `BackupSpec` | CANON | mechanism, tested_at, evidence_ref |
| `CostModel` | CANON | build_cost, run_cost, basis, confidence |
| `UserJourney` / `Flow` | CANON | steps, segment_ref, requirement_refs |
| `StateCoverage` | CANON | screen/flow → states defined | mandatory completeness |
| `DesignTokenSet` | CANON | tokens by category, semantic roles |
| `ComponentSpec` | CANON | anatomy, variants, states, a11y rules, RTL rules |
| `DesignException` | CANON | scope, reason, approver, expiry |
| `AdminOperabilityReview` | CANON | feature_ref, answers to mandated questions |
| `ConfigurationRegister` | CANON | element → classification + justification |
| `ProtectedRule` | CANON | rule, protection_reason (security/financial/structural) |

### 3.5 Planning & Execution

| Entity | Tier | Key fields |
|---|---|---|
| `Feature` | CANON | name, requirement_refs[], state |
| `Task` | WORKING | feature_ref, department, scope_boundary, inputs, expected_outputs, required_evidence, state, budget |
| `Dependency` | WORKING | from, to, type (HARD/SOFT/INFORM/FEEDBACK) |
| `WorkItem` | WORKING | request, classification, profile, stage_ledger, state |
| `StageLedgerEntry` | TRACE | stage, disposition, reason, actor, at |
| `Plan` | WORKING | tasks, graph, parallel sets, gate bindings |
| `WorkflowRunEvent` | TRACE | append-only; per `07` §6 |
| `WorkflowRun` (live) | WORKING | projection over `WorkflowRunEvent` |
| `WorkflowRunRecord` | TRACE | terminal snapshot |
| `HandoffOffered` / `HandoffAccepted` / `HandoffRejected` | TRACE | append-only; per `07` §3.2 |
| `Handoff` | DERIVED | view composed from the handoff events |
| `AgentRunEvent` | TRACE | append-only, digest-chained; per `05` §4.2 |
| `AgentRun` (live) | WORKING | projection; never authoritative (`RI-8`) |
| `AgentRunRecord` | TRACE | terminal snapshot; per `05` §4.3 |
| `ToolCallEvent` | TRACE | `TOOL_REQUESTED` / `TOOL_DECIDED` / `TOOL_RESULT_CAPTURED`, including denials |
| `Artifact` | CANON/WORKING | path or record ref, digest, produced_by_run, version |

### 3.6 Governance

| Entity | Tier | Key fields |
|---|---|---|
| `Decision` | CANON | class, context, options[], chosen, rationale, rejected_reasons, consequences, risks, authority, date, **reevaluation_trigger** |
| `ADR` | CANON | Decision specialization for architecture/technology |
| `DesignDecision` | CANON | Decision specialization for design |
| `SecurityDecision` | CANON | Decision specialization; may carry residual risk |
| `ChangeRequest` | WORKING→CANON | origin, description, magnitude, impact_analysis_ref, approval, state |
| `ImpactAnalysis` | CANON | per-dimension AFFECTED/NOT_AFFECTED (no UNKNOWN), resulting tasks |
| `Proposal` | WORKING→CANON | per `10` §2 |
| `Escalation` | WORKING→CANON | per `05` §9 |
| `Risk` | WORKING | category, probability, impact, exposure, mitigation, owner, trigger, state |
| `Issue` | WORKING | description, severity, state, resolution |
| `Defect` | WORKING | reproduction, expected, actual, severity, root_cause, fix_ref, regression_test_ref |
| `AuditEvent` | TRACE | actor, action, subject, outcome, policy_ref | **runtime-written only** (`SC-POL-029`) |
| `ViolationRecord` | TRACE | policy_ref, severity, subject, response |
| `PolicyWaiver` | CANON | policy_ref, scope, authority, expiry, justification |

### 3.7 Verification

| Entity | Tier | Key fields |
|---|---|---|
| `TestCase` | CANON | derived_from (requirement/AC), steps, expected, level |
| `TestRun` | TRACE | immutable once captured: test_case_refs, environment, result, evidence_ref |
| `Evidence` | TRACE | **immutable**: class, provenance, artifact_versions_covered, digest, captured_at, valid_until | per `16` |
| `QualityGate` | CANON | criteria, severities, required evidence; composition per `31` §4.1 |
| `CriterionEvaluation` | TRACE | **immutable**: one criterion's V1 value + basis + reason + severity + evidence + qualifications (`31` §2.1) |
| `ArtifactVerifierResult` | TRACE | **immutable**: a VERIFIER agent's V3b result about an artifact (`16` §5, `31` §4.3) |
| `GateResult` | TRACE | **immutable**: gate_ref, `GateVerdict`, criterion_evals, evidence_refs, artifact_versions, qualifications, findings, actor, at |
| `EvidenceRevocation` / `EvidenceDispute` | TRACE | appended; inputs to validity derivation |
| `ValidityState` | DERIVED | computed by `SC-RTC-004` per `31` §3.2 — for `Evidence`, `GateResult`, `ArtifactVerifierResult`, `CriterionEvaluation` |
| `TraceabilityMatrix` | DERIVED | requirement ↔ … ↔ verification |
| `SupersessionIndex` | DERIVED | reverse index over forward `supersedes` links (§6.2) |
| `Finding` | WORKING | source (review/test/audit), severity, state, resolution |

### 3.8 Operation & Learning

| Entity | Tier | Key fields |
|---|---|---|
| `Environment` | CANON | name, purpose, data_policy, access |
| `Release` | CANON | version, content[], notes, readiness_evidence, state |
| `Deployment` | TRACE | release_ref, environment, executed_by (owner), at, outcome |
| `OperationalReadiness` | CANON | dimension → IN_SCOPE/NOT_APPLICABLE + evidence |
| `Runbook` | CANON | procedure, tested_at |
| `Incident` | CANON | severity, timeline, containment, resolution, root_cause, corrective_actions |
| `HealthReview` | CANON | period, metrics, findings |
| `LessonLearned` | CANON | event_refs, lesson, applicability_conditions |
| `ReusablePattern` | CANON | pattern, context_applied, context_not_applicable |
| `FailedApproach` | CANON | approach, why_failed, conditions |
| `ApplicabilityAssessment` | WORKING | prior_art_ref, new_context, verdict |

**This is the authoritative entity catalogue** — §3.1 through §3.8 above are the list, and no other document states an entity count (`CAT-2`). It is not a wish list: every entity is consumed by a rule, gate or invariant somewhere in this set, and an entity no rule consumes is a modelling defect detectable by `DC-7`.

---

## 4. Core Relations

```
ProjectGoal ──covered_by──► Requirement ──realized_by──► Feature ──decomposed_into──► Task
                                │                                        │
                                │                                        ├──executed_by──► AgentRun
                                │                                        └──produces──► Artifact
                                ├──verified_by──► AcceptanceCriterion ──tested_by──► TestCase
                                │                                            └──executed_in──► TestRun
                                │                                                     └──produces──► Evidence
                                └──constrained_by──► NFR ──satisfied_by──► Mechanism(Architecture)
                                                       └──verified_by──► Evidence

Note: `Mechanism(Architecture)` is a **conceptual alias** for the `ArchitectureModel` element
recorded in `NFRMapping`. It is not a separate entity.

BusinessRule ──implemented_in──► Artifact ──reviewed_by──► ArtifactVerifierResult
Decision ──affects──► {Architecture, DataModel, Technology, Design, Security}
         ──supersedes──► Decision
Proposal ──becomes──► {Requirement | Decision | Task | ChangeRequest} | REJECTED
ChangeRequest ──requires──► ImpactAnalysis ──generates──► Task[]
Evidence ──supports──► CriterionEvaluation ──composes──► GateResult ──drives──► StageLedgerEntry
ArtifactVerifierResult ──consumed_by──► CriterionEvaluation                    └─drives─► WorkItem / WorkflowRun transition events
Incident ──caused_by──► {Artifact | Decision | Assumption} ──produces──► LessonLearned
Risk ──mitigated_by──► {Decision | Task | Requirement}
Assumption ──underpins──► {Requirement | Decision | Architecture}
```

### 4.1 Link record

Links are first-class, not embedded fields, so traceability can be queried in both directions and link integrity can be checked independently.

```
Link { from_id, from_type, to_id, to_type, relation, created_by_run, at, state: ACTIVE|SUPERSEDED }
```

---

## 5. The Traceability Chain

The chain mandated by `SC-POL-014`:

```
Requirement → Feature → Task → Implementation(Artifact) → TestCase → TestRun → Evidence
                                                                        └→ CriterionEvaluation → GateResult
```

`Implementation(Artifact)` is a **conceptual alias** for `Artifact` records produced by a Tier 4 task; it is not a separate entity. The chain terminates in a `GateResult`, which is the canonical entity a `PASS` lives in — R2 wrote "Verdict" here, which was not an entity in the catalogue.

Every hop is a `Link`. Both directions are queryable.

### 5.1 Orphan classes

| Orphan | Meaning | Handling |
|---|---|---|
| `REQUIREMENT_UNIMPLEMENTED` | Requirement with no Feature/Task | Blocks Acceptance for `MUST` requirements |
| `REQUIREMENT_UNVERIFIED` | Implemented but no passing evidence | Blocks Acceptance |
| `ARTIFACT_UNREQUESTED` | Implementation with no requirement | Blocks Acceptance; possible `SC-POL-009` violation |
| `TEST_UNLINKED` | Test not derived from a requirement/AC | Warning; may be legitimate (exploratory, regression) but must be marked |
| `EVIDENCE_UNBOUND` | Evidence supporting no verdict | Informational |
| `NFR_UNMAPPED` | NFR with no satisfying mechanism | Blocks Architecture Gate |
| `DECISION_ORPHANED` | Decision affecting nothing traceable | Warning |
| `RULE_UNIMPLEMENTED` | BusinessRule with no implementation link | Blocks Acceptance |

`ARTIFACT_UNREQUESTED` is the one that matters most and that conventional systems never check: it is how unrequested behavior gets caught.

**Legitimate exceptions:** enabling/scaffolding artifacts may link to an `ENABLING` work item or an NFR instead of a user-facing requirement. The exception must be recorded, not assumed.

---

## 6. Versioning, Supersession and Staleness

### 6.1 Versioning

- `T-CANON` entities are versioned; prior versions retained and addressable.
- Every version carries a `digest` over its normative content.
- A reference may target a specific version (`ref@v`) or the current version (`ref@current`). **Verdicts always bind to specific versions** — this is what makes `SC-POL-031` computable.

### 6.2 Supersession is forward-only (R2 correction)

Corrections never overwrite — and, corrected in R2, they never edit the superseded record either.

> A new record declares `supersedes: <old_id>` **at creation**.
> The old record is **never touched**.
> `superseded_by` is a `T-DERIVED` reverse index (`SupersessionIndex`) rebuilt from the forward links.

R1's "the old is marked `superseded_by`" required writing to an immutable record to record its own obsolescence — the same class of contradiction as the `AgentRun` defect (§2.1). Queries default to current state through the index; history remains fully reachable; nothing is ever edited.

This applies to `T-TRACE` absolutely and to `T-CANON` versioning, where the "current version" pointer is likewise a derived head index rather than a mutable field on each version.

### 6.3 Validity derivation and staleness (`SC-POL-031`)

**Corrected in R3.** R2 contained the assignment `v.freshness := STALE` — a mutation of an immutable `T-TRACE` record, contradicting `SC-POL-022` and §2.1 of this document.

Validity is **never assigned**. It is **derived** by `SC-RTC-004` per the single definition in `31` §3.2, from: the immutable source record, current artifact versions, the clock, revocation and dispute records, and the dependency graph.

```
onArtifactChange(a, oldVersion, newVersion):
    # nothing is mutated — the change of currentVersion(a) is itself the input
    record ArtifactVersionEvent(a, oldVersion, newVersion)        # T-TRACE, appended
    invalidate cached ValidityState projections covering a        # T-DERIVED, regenerated
    recompute derived views (traceability matrix, validity index)
    record AuditEvent(VALIDITY_RECOMPUTED, affected record ids)
```

Any record whose `artifact_versions_covered` names `a@oldVersion` now derives to `STALE`, and anything depending on it derives to `STALE` by propagation (`31` VD-3). No field is written on any of them.

| `ValidityState` | Usable by a gate? |
|---|---|
| `VALID` | Yes |
| `STALE` · `EXPIRED` · `REVOKED` · `DISPUTED` · `INADMISSIBLE` | No — yields `INDETERMINATE` with reason `EVIDENCE_INVALID` (`31` TX-3b) |

Gates declare an **invalidation set** — which artifact classes invalidate their results. A documentation-only change need not invalidate a performance measurement, but that exemption is declared in the gate definition (`18` §2), never decided at evaluation time.

**Time-bound expiry** is part of the same derivation: some records decay with the clock rather than with artifact change — market research, dependency vulnerability status, a restore test performed a year ago. `valid_until` is set at capture; `EXPIRED` is derived from it. Without this, such records would silently authorize decisions long after they stopped being true.

## 7. Integrity Invariants

Checked by the store integrity checker (`21` §6). A violation is a defect, and blocks gates that depend on the affected records.

| ID | Invariant | Severity |
|---|---|---|
| `KI-1` | Every `T-TRACE` record is unmodified since creation, and every event chain's digest links verify | V1 |
| `KI-1b` | No `T-TRACE` entity carries a mutable lifecycle or validity field (`validity`, `freshness`, `state`); every lifecycle is event-sourced (§2.1) and every validity is derived (`31` VD-1) | V1 |
| `KI-1c` | Every live projection matches a replay of its event log | V1 |
| `KI-1d` | No record contains a stored `superseded_by`; the reverse index is derived (§6.2) | V2 |
| `KI-2` | Every `CriterionEvaluation` with value `MET` has ≥1 bound `Evidence` of the class its criterion requires, all deriving to `VALID` (`31` TX-4) | V1 |
| `KI-2b` | Every `CriterionEvaluation` with value `INDETERMINATE` carries a `reason` from the closed set (`31` TX-3b); every `WAIVED` carries an active `waiver_ref`; every basis `JUDGED` carries `judged_by` | V2 |
| `KI-2c` | `ValidityState = INADMISSIBLE` occurs only on `Evidence` subjects (`31` §3.1) | V2 |
| `KI-2d` | Every stored outcome value is a member of its canonical vocabulary in `31`; `JUDGED` never appears as a verdict value | V1 |
| `KI-3` | Every `Evidence` of class `EXECUTION` has runtime-captured provenance | V1 |
| `KI-4` | No `AuditEvent` was written by an agent actor | V1 |
| `KI-5` | For every accepted artifact: producer ≠ reviewer ≠ acceptor | V1 |
| `KI-5b` | Every node named in a normative relation (§4, §5) is a canonical entity in §3 or is explicitly marked a conceptual alias | V2 |
| `KI-6` | Every `Link` resolves on both ends | V2 |
| `KI-7` | Every `WorkItem` stage ledger covers the full stage set | V2 |
| `KI-8` | Every `Requirement` has ≥1 `AcceptanceCriterion` (priority `MUST`/`SHOULD`) | V2 |
| `KI-9` | Every `NFR` has a measurable target or `NOT_APPLICABLE(reason)` | V2 |
| `KI-10` | Every `Decision` has ≥2 options and a `reevaluation_trigger` | V2 |
| `KI-11` | Every `ImpactAnalysis` has no `UNKNOWN` dimension when approved | V2 |
| `KI-12` | Every `Observation` reaches terminal triage | V3 |
| `KI-13` | Every non-terminal work item past threshold is flagged `STALLED` | V3 |
| `KI-14` | Every stored `Artifact` digest matches the workspace, or divergence is recorded | V2 |
| `KI-15` | Every `Glossary` term has exactly one definition | V3 |
| `KI-16` | Every `BusinessRule` marked `PROPOSED` is not in a baseline | V2 |
| `KI-17` | No `PROTECTED_INVARIANT` element appears as configurable in the Configuration Register | V1 |
| `KI-18` | Every `AgentRun` has `scope_actual ⊆ scope_declared`, or a recorded violation | V1 |
| `KI-19` | Every load-bearing unvalidated `Assumption` is reflected in the Risk register | V2 |
| `KI-20` | `T-DERIVED` views are reconstructible from CANON/WORKING/TRACE | V3 |

---

## 8. Query Obligations

The store MUST answer these without an AI session (`R12`, `00` §16). They are the functional specification of the store's read side.

| # | Query |
|---|---|
| Q1 | What stage is this project in, and what is the next action? |
| Q2 | What is blocked, and by what chain? |
| Q3 | What is waiting on the owner? |
| Q4 | What was decided about X, by whom, when, why, and what were the alternatives? |
| Q5 | What evidence supports this `PASS`, and does it derive to `VALID`? |
| Q6 | What is unverified right now? |
| Q7 | Which requirements are not implemented / not verified? |
| Q8 | Which implementation traces to no requirement? |
| Q9 | What proposals are open, and what are they worth? |
| Q10 | What risks are open above threshold? |
| Q11 | What assumptions is this project resting on, and which are unvalidated? |
| Q12 | What did this agent run do, with what inputs, at what cost? |
| Q13 | What changed in the workspace outside Serva's control? |
| Q14 | What would break if I changed X? (impact query over links) |
| Q15 | Why does this product win? |
| Q16 | What can the admin configure, and what is protected? |
| Q17 | What has been consumed against budget? |
| Q18 | What did we learn on previous projects that might apply here? (marked `CANDIDATE`) |

**Q14 in particular** is what makes Impact Analysis (`SC-POL-013`) tractable rather than an act of imagination.

---

## 9. Model Extension

Adding an entity type, relation, or invariant is a governed change (`09`), requiring: the rule/gate/invariant that consumes it, its tier, its lifecycle, and its effect on existing invariants.

**Anti-bloat rule:** an entity with no consumer is rejected. This model is deliberately large because the governance rules are numerous — not because comprehensiveness is a virtue in itself.
