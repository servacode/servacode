# 04 — ORCHESTRATOR MODEL

**Document ID:** SC-DOC-004
**Status:** BASELINE R4
**Type:** Normative / Component Specification
**Owns:** Request classification, profile selection, department/agent assembly, sequencing, parallelism decisions, orchestration state machine, halting conditions.
**Does not own:** Department internals (`06`), gate criteria (`18`), workflow execution semantics (`07`), engine invocation (`19`).

---

## 1. Definition

The Orchestrator (`SC-DEPT-001`) is the **management function** of Serva Code. It does not perform production work. Its output is not code, requirements or designs — its output is an **Execution Plan** plus the continuous maintenance of **Orchestration State**.

Its mandate, stated as a contract:

| | |
|---|---|
| **Mission** | Convert any owner request into a governed, correctly-sequenced, correctly-gated plan of Agent Runs, and drive that plan to a terminal state without violating the constitution. |
| **Inputs** | Owner request · Project State · Stage Ledger · open Proposals/Escalations/Issues · Risk register · budgets · workspace reconciliation report |
| **Outputs** | `RequestClassification` · `ExecutionPlan` · `Task[]` dispatch · `OrchestrationState` updates · `HaltRecord` where applicable |
| **Authority** | Classify · select profile · assemble departments/agents · sequence · declare parallelism · declare gate applicability · halt work · re-dispatch on FAIL · request owner input |
| **Forbidden** | Writing product code · producing requirements/designs/architecture itself · rendering a gate verdict · waiving a gate · resolving a policy conflict · overriding a Tier 5 verdict · crossing an owner-reserved boundary · amending a profile |
| **Escalates to** | Owner (Tier 0) — business decisions, reserved actions, budget increases, policy conflicts |
| **Judged by** | SC-DEPT-002 (Governance & Compliance) — the Orchestrator does not audit itself |

**Critical separation (DERIVED):** the Orchestrator **cannot render gate verdicts**. It *runs* gates; the gate engine evaluates and Governance audits. If the entity under schedule pressure could also declare PASS, `SC-POL-005` would collapse under throughput pressure. This is why `SC-DEPT-002` exists as a separate department.

---

## 2. Orchestration Loop

```
 0. RECONCILE      workspace vs. store (SC-POL-032)
 1. INGEST         request -> normalized RequestRecord
 2. CLASSIFY       -> RequestClass + magnitude + risk
 3. SITUATE        load Project State, stage ledger, open items
 4. ASSESS IMPACT  (if change to existing truth) -> SC-POL-013
 5. SELECT         lifecycle profile (+ record omissions, SC-POL-024)
 6. ASSEMBLE       departments -> agents -> tasks
 7. SEQUENCE       dependency graph, parallel sets, gate set
 8. CHECK          approvals / escalations / budget required?
 9. DISPATCH       execute runs (serial or parallel)
10. COLLECT        outputs, evidence, observations  [5 protective checks]
11. GATE           invoke gate engine at defined points
12. ROUTE          PASS -> advance | FAIL -> rework | other -> halt
13. TRIAGE         observations -> proposals (SC-POL-008)
14. PERSIST        state, ledger, audit
15. NEXT           compute next action or reach terminal state
```

Steps 0, 10, 13 and 14 are **non-skippable on every cycle**. Step 0 is what prevents the system from planning against a workspace that no longer matches its records.

---

## 3. Request Classification

### 3.1 Request classes

Classification determines profile, department set, gate set, approval requirements and evidence expectations.

| ID | Class | Signature | Default profile |
|---|---|---|---|
| `RC-01` | NEW_PROJECT | No project state exists; an idea is presented | `PRF-NEW-PRODUCT` |
| `RC-02` | SMALL_CHANGE | Bounded change, no new requirement, no contract change | `PRF-SMALL-CHANGE` |
| `RC-03` | BUG | Behavior deviates from a stated requirement or reasonable expectation | `PRF-BUG-FIX` |
| `RC-04` | FEATURE | New capability within existing architecture | `PRF-FEATURE` |
| `RC-05` | MAJOR_FEATURE | New capability requiring new requirements, data, or design surface | `PRF-MAJOR-FEATURE` |
| `RC-06` | ARCHITECTURE_CHANGE | Alters module boundaries, contracts, data model, or technology | `PRF-ARCHITECTURE-CHANGE` |
| `RC-07` | SECURITY_ISSUE | Vulnerability, exposure, or security-relevant defect | `PRF-SECURITY-FIX` |
| `RC-08` | DESIGN_CHANGE | Alters tokens, components, UX flows, or IA | `PRF-DESIGN-CHANGE` |
| `RC-09` | RESEARCH | A question to investigate; no implementation intended | `PRF-RESEARCH` |
| `RC-10` | RELEASE | Prepare/verify a release of accepted work | `PRF-RELEASE` |
| `RC-11` | INCIDENT | Production is degraded or broken now | `PRF-INCIDENT` |
| `RC-12` | OPERATIONAL_CHANGE | Configuration/settings/operational behavior; may need no code | `PRF-OPERATIONAL-CHANGE` |
| `RC-13` | DOCUMENTATION | Documentation-only work | `PRF-DOCUMENTATION` |

Two meta-classes that are not lifecycle work:

| ID | Class | Handling |
|---|---|---|
| `RC-90` | QUERY | A question about project state, answered from the store (`R12`); no lifecycle work, no engine invocation required |
| `RC-91` | GOVERNANCE | Proposal decision, CR, policy question, waiver request; routed to `09`/`10`, never to production |

### 3.2 Classification signals

Classification is computed from signals, not from the owner's phrasing. The owner saying "just a small change" is a signal, not a verdict.

| Signal | Source | Effect |
|---|---|---|
| Project state exists? | Store | RC-01 vs. others |
| Stated intent verbs | Request text | Weak signal only |
| Requires a new requirement? | Requirements analysis | At least RC-04 |
| Touches a contract/interface? | Architecture model + SSOT register | At least RC-06 |
| Touches schema/migrations? | Data model | At least RC-06 |
| Touches auth, secrets, payments, personal data, upload, external input? | Security-sensitive surface list (`17` §4) | Forces security path |
| Touches design tokens or shared components? | Design system registry | RC-08 with broad impact |
| Production currently impaired? | Owner statement / monitoring | RC-11 |
| Blast radius (files, modules, consumers) | Static analysis of the target | Raises magnitude |
| Reversibility | Impact analysis | Raises magnitude |
| Cost estimate vs. budget | FinOps | May force approval |

### 3.3 Magnitude

Independent of class, every request receives a magnitude used for decision classification (`09` §3), approval requirements, and research depth.

| Magnitude | Criteria (any one) |
|---|---|
| `M0 TRIVIAL` | Single-location change, no behavior change, fully reversible, no contract, no data |
| `M1 MINOR` | Bounded behavior change within one module, reversible, no contract/schema change |
| `M2 MODERATE` | Multiple modules, or a new requirement, or a UI surface change; reversible with effort |
| `M3 MAJOR` | Contract, schema, technology, cross-cutting concern, or security-relevant design change |
| `M4 STRUCTURAL` | Architecture, data-model reshaping, technology replacement, irreversible or migration-bearing |

### 3.4 Classification rules (normative)

- **CL-1 — Classify upward under uncertainty.** If signals are ambiguous between two classes or magnitudes, the higher is selected. Downgrading later requires a Decision; upgrading does not.
- **CL-2 — Security dominance.** Any security-sensitive surface forces the security path regardless of primary class or magnitude (`03` §7.1 PR-2).
- **CL-3 — Owner phrasing is not authoritative.** "Just", "quick", "simple" adjust nothing.
- **CL-4 — Classification is recorded and revisable.** A `RequestClassification` stores class, magnitude, the signals used, and confidence. Mid-flight reclassification appends a new record (`SC-POL-022`) and forces re-planning.
- **CL-5 — Unclassifiable requests halt.** The Orchestrator asks the owner a *scoping* question, never an engineering question (`SC-POL-001`).
- **CL-6 — Multi-intent requests are decomposed.** A request containing several distinct intents becomes several work items, each classified independently with declared dependencies. It is not classified as its largest part.

---

## 4. Impact Analysis Trigger

For any request at magnitude `M2` or above that modifies existing truth, the Orchestrator MUST obtain an Impact Analysis (`09` §6) **before** assembling tasks. It does not author the analysis; it dispatches it to the relevant design-authority departments and blocks planning on the result.

`UNKNOWN` in any impact dimension blocks approval (`SC-POL-013`). The Orchestrator resolves `UNKNOWN` by dispatching investigation tasks, never by assuming.

---

## 5. Assembly

### 5.1 Profile selection

```
selectProfile(classification, projectState):
    base    := defaultProfile[classification.class]
    profile := base
    if classification.magnitude > base.maxMagnitude:   profile := upgrade(profile)
    if touchesSecuritySensitiveSurface:                profile := ensureSecurityPath(profile)
    if touchesDesignTokens or sharedComponents:        profile := ensureDesignPath(profile)
    if touchesSchema:                                  profile := ensureDataPath(profile)
    if missingFoundationalArtifacts(projectState):     profile := ensureFoundationStages(profile)
    record ProfileSelection{profile, base, upgrades, omissions}     # SC-POL-024
    return profile
```

`ensureFoundationStages` closes a real trap: on a new project the *first* feature request cannot run `PRF-FEATURE`, because no architecture, design system or requirement baseline exists yet. The Orchestrator MUST detect missing foundational artifacts and insert the stages that produce them, rather than letting a Tier 4 department invent them under time pressure.

### 5.2 Department assembly

```
assembleDepartments(profile, classification, projectState):
    depts := {}
    for stage in profile.stages:
        depts += stage.owner + applicableParticipants(stage, projectState)
    depts += alwaysApplicable(Orchestration, Governance, Requirements,
                              CodeReview, QA, Acceptance, Knowledge)
    for d in depts:
        if not d.applicabilityCondition(projectState):
            record NOT_APPLICABLE(d, reason); remove d
    assertConflictOfInterestSatisfiable(depts)          # 02 §6
    return depts
```

**Rule:** if the conflict-of-interest matrix cannot be satisfied with the available agents, the Orchestrator MUST NOT proceed by merging roles. It halts with `CANNOT_SEPARATE_ROLES` and escalates. `SC-POL-006` is not negotiable against convenience.

### 5.3 Agent assembly

For each department, agents are selected from `06` by matching the task's required capability against agent contracts. The selection record stores: agent id, contract version, why selected, resolved tool allowlist, assigned context budget, and the conflict-of-interest check result.

---

## 6. Sequencing and Parallelism

### 6.1 Sequencing rules

- **SQ-1** Respect `HARD` dependencies from `03` §8 absolutely.
- **SQ-2** Respect architectural ordering: contracts before consumers, schema before data access, design tokens before UI components, auth model before protected features.
- **SQ-3** Never dispatch a producer and its reviewer concurrently for the same artifact.
- **SQ-4** Dispatch verification stages only against a non-stale artifact set.
- **SQ-5** Highest-uncertainty-first: dispatch the task most likely to invalidate the plan early, so infeasibility is discovered cheaply.
- **SQ-6** Respect budget: if projected consumption exceeds the remaining budget, halt and escalate rather than partially executing (`SC-POL-028`).

### 6.2 Parallelization eligibility

Two runs may execute concurrently only if **all** hold:

| Condition | Reason |
|---|---|
| No `HARD` dependency between them | Correctness |
| Disjoint write sets (files/records each may modify) | Prevents lost updates (`21` §5) |
| Neither is the reviewer of the other's output | `SC-POL-006` |
| Both fit within concurrent-run and budget limits | `SC-POL-028` |
| Neither requires an owner decision the other would change | Avoids asking twice / contradictory answers |

Write-set disjointness is declared per task at PLANNING (the task scope boundary, `03` §5) and enforced by the runtime lock manager (`21` §5) — never trusted to the agents.

### 6.3 Concurrency hazards

*(DERIVED — the assignment asks for concurrency to be considered even with a single user.)*

| Hazard | Mitigation |
|---|---|
| Two agents editing the same file | Write-set locks; conflicting dispatch refused at plan time |
| An agent reading a record another is mutating | Snapshot isolation for run context (`21` §5) |
| Context built from state that changes mid-run | Context bundle is a version-stamped snapshot; verdicts bind to that stamp (`SC-POL-031`) |
| Parallel runs producing contradictory decisions | Reconciliation at the shared gate (`03` §8.1); contradiction is a FAIL, not a merge |
| A long-running run blocking the queue | Runs carry deadlines; timeout is a defined failure (`22`) |
| Owner edits files while runs are in flight | Step-0 reconciliation plus mid-flight change detection; affected runs invalidated |

---

## 7. Dispatch and Collection

Each dispatch creates an `AgentRun` record (`08`) **before** the engine is invoked, so that a crash mid-run leaves a record of an incomplete run rather than no record at all (`22` §4).

Dispatch payload:

`run_id · task_id · agent_contract_ref(version) · context_bundle_ref · tool_allowlist · scope_boundary · required_output_schema · required_evidence · budget · deadline · trust_annotations`

### 7.1 The five protective collection checks

Before accepting any run, the Orchestrator MUST verify:

1. **Schema validity** of the output, else `RUN_INVALID_OUTPUT` (`22`).
2. **Presence** of `self_review` and `observations` (`SC-POL-007`).
3. **Scope conformance**: changed-artifact set is a subset of the declared scope, else `SCOPE_VIOLATION` (`SC-POL-009`).
4. **Evidence reality**: every claimed evidence item exists as a runtime-captured record with provenance, else `EVIDENCE_MISSING` or `EVIDENCE_FABRICATED` (`SC-POL-023`).
5. **Consumption recorded** (`SC-POL-028`).

These five checks are the Orchestrator's core protective function. They are mechanical, executed outside the model, and are the reason a hallucinating engine cannot advance the lifecycle.

---

## 8. Orchestration State Machine

### 8.1 Work item states

```
 RECEIVED -> CLASSIFIED -> PLANNED -> EXECUTING <-> GATING
                              |          |            |-> ADVANCING -> ... -> COMPLETED
                              |          |            |-> REWORK ----> EXECUTING
                              |          |            |-> HALTED
                              |-> AWAITING_OWNER -----|
                              |-> AWAITING_EXPERT
                              |-> AWAITING_APPROVAL
                              |-> BLOCKED

 Terminal: COMPLETED | CANCELLED(decision) | REJECTED(classification) | SUPERSEDED(item)
```

**Invariant (`SC-POL-033`):** every work item reaches a terminal state. Items with no progress past a threshold surface as `STALLED`. `STALLED` is a visibility state, not a terminal state.

### 8.2 Halting conditions (normative)

The Orchestrator MUST halt and escalate — never proceed on assumption — when:

| Condition | Escalates to |
|---|---|
| `CANNOT_CLASSIFY` | Owner (scoping question) |
| `CANNOT_SEPARATE_ROLES` | Owner |
| Policy conflict detected | Owner (`01` §5) |
| `EXPERT_REVIEW_REQUIRED` in a mandatory domain | Owner (`SC-POL-012`) |
| Owner-reserved action required (`28` §3) | Owner |
| Approval required above Orchestrator authority | Approval flow (`09` §2) |
| Budget exceeded or would be exceeded | Owner (`SC-POL-028`) |
| Evidence fabrication suspected | Owner + Governance, severity V1 (`SC-POL-023`) |
| Store integrity error | Owner, recovery path (`22` §5) |
| Workspace divergence invalidating the plan | Owner (`SC-POL-032`) |
| Same gate FAILs N times on the same root cause | Owner (loop breaker, §8.3) |
| Contradiction between baselined artifacts | Governance + owning departments |
| Requirement ambiguity implementation cannot resolve | Requirements Engineering, then owner if business-level |

### 8.3 The loop breaker (DERIVED)

An autonomous system with a rework path will loop. The Orchestrator MUST track `(gate, root_cause)` failure counts per work item. On reaching the limit (default 3 identical-root-cause failures; owner-configurable but **not disableable**) it MUST halt with `REWORK_LOOP_DETECTED` and present: the failing gate, the finding, every attempt, what changed between attempts, and its own assessment of why the loop is not converging.

**Why derived:** the assignment specifies returning the task on FAIL but not the termination condition. Without one, FAIL-rework cycles consume unbounded budget and produce oscillating changes — a realistic and expensive failure mode of this architecture.

---

## 9. Next-Action Computation

At any moment the Orchestrator MUST be able to answer `nextAction(project)` **from the store alone, with no engine invocation**. This is `R12` in `00` §16, and it is what makes Serva Code usable after a crash, a restart, or three weeks away.

```
nextAction(project):
    if storeIntegrityError:        return RECOVER(diagnosis)
    if workspaceDiverged:          return RECONCILE(divergence report)
    if awaitingOwner:              return ASK_OWNER(question, why blocking, recommendation, cost of delay)
    if awaitingExpert:             return EXPERT_REVIEW_REQUIRED(record)
    if awaitingApproval:           return APPROVAL(item, authority, what it unblocks)
    if openGateFailures:           return REWORK(highest severity first)
    if readyTasks not empty:       return DISPATCH(maximal eligible parallel set)
    if onlyBlockedTasks:           return EXPLAIN_BLOCKAGE(dependency chain)
    if stageExitClaimed:           return RUN_GATE(stage)
    if stageComplete and nextEntryMet:  return ADVANCE(next stage)
    if allStagesTerminal:          return COMPLETE
    return DIAGNOSE
```

The trailing `DIAGNOSE` branch is deliberate: an orchestration state from which no action can be computed is a defect in the state model and must be surfaced, never silently idled.

---

## 10. What the Orchestrator Presents to the Owner

Every owner-facing pause MUST include: **the question**, **why it blocks**, **what Serva recommends and why**, **the cost of delay**, and **what proceeds regardless**. A question without a recommendation pushes engineering load back onto the owner, violating `SC-POL-001` in spirit.

**Forbidden question shapes** — Serva has not done its work:
- Undecided engineering choice: *"Postgres or MySQL?"* — Serva decides (`SC-POL-001`).
- Design choice: *"what corner radius?"* — Design System decides (`SC-POL-003`).
- Any alternatives presented without an analysis and a recommendation.

**Required question shapes** — the answer is genuinely the owner's:
- Business/scope choice: *"this adds roughly two weeks and $X per month — include it in v1?"*
- Reserved action: *"staged and verified; deploying is yours to trigger."*
- **Business consequence of an engineering recommendation** (`SC-POL-001` business-consequence clause, added in R2):
  > *"We recommend option A. It ships in about three weeks and costs roughly $40/month. Option B ships in about nine weeks and costs roughly $400/month, but removes a vendor dependency we'd otherwise carry for two years. We recommend A because the vendor risk is reversible at this scale and time-to-market is your stated priority. Confirm A, or choose B."*

The distinguishing test is not whether the subject is technical. It is **whose accountability the answer falls under**: technical correctness is Serva's, and willingness to bear a cost, a delay, a commitment or a risk is the owner's. `OF-10` audits for the forbidden shapes; it does not flag the third required shape.

---

## 11. Orchestrator Failure Modes

| ID | Failure | Detection | Response |
|---|---|---|---|
| `OF-1` | Under-classification | Scope violations; unexpected impact found during execution | Reclassify upward, re-plan, record |
| `OF-2` | Over-classification | Excess process on trivial work; owner friction | Record; downgrade requires a Decision (CL-1 bias is intentional) |
| `OF-3` | Plan built on stale state | Step-0 reconciliation | Invalidate plan, re-plan |
| `OF-4` | Deadlock between tasks | Cycle detection in the dependency graph at plan time | Refuse the plan; report the cycle |
| `OF-5` | Starvation of low-priority items | `STALLED` detection (`SC-POL-033`) | Surface to owner |
| `OF-6` | Rework oscillation | Loop breaker §8.3 | Halt, escalate |
| `OF-7` | Budget overrun | Consumption tracking | Halt, escalate |
| `OF-8` | Accepting a fabricated result | Collection checks §7.1 | V1 handling |
| `OF-9` | Over-parallelization causing conflicts | Write-set analysis at plan time; lock denial at run time | Serialize |
| `OF-10` | Delegating an engineering decision to the owner (alternatives with no analysis or recommendation) | Governance audit of the owner-facing question log | Withdraw; dispatch to the owning department; re-ask as a business-consequence question if one is warranted |
| `OF-11` | Planning around a department that is unavailable | Applicability check at assembly | Halt rather than reassign the responsibility |

---

## 12. Relationship to the AI Engine

The Orchestrator is **not a prompt**. Its classification, sequencing, dispatch, collection checks, state transitions and next-action computation are **deterministic logic over stored state** (`27` R-DET).

The engine MAY be invoked by the Orchestrator for judgment-heavy sub-problems — estimating blast radius from a natural-language request, proposing a decomposition — subject to three rules:

1. Engine output is a **recommendation input**, never the state transition itself.
2. Every engine-assisted orchestration decision records its inputs, so it can be reviewed and, where systematically wrong, replaced by a rule.
3. No engine output may cause a gate to pass, a policy to be bypassed, or an owner-reserved boundary to be crossed.

**Rationale:** if the Orchestrator were itself a prompt, the entire governance layer would inherit exactly the non-determinism it exists to contain.
