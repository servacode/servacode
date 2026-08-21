# 30 — CANONICAL CATALOGUES

**Document ID:** SC-DOC-030
**Status:** BASELINE R4
**Type:** Normative / Registry
**Derived:** YES — added in Audit R2 (Correction 1).
**Owns:** The authoritative registry of every catalogued instance in Serva Code — departments, agents, runtime checkers, lifecycle stages, gates, workflows, policies — and **every count derived from them**.

**Why this document exists:** Audit R2 found that `00` claimed 61 agents while `06` contained 76, and that `00` claimed 26 lifecycle stages while `03` contained 30. Those were not typos. They were the predictable result of maintaining counts by hand in prose across a document set whose central principle is Single Source of Truth (`SC-POL-004`). A specification that violates its own foundational policy cannot be trusted to enforce it.

---

## 1. Canonical Ownership Rule

> **CAT-1.** This document is the sole authoritative source for the *membership and cardinality* of every catalogue listed in §2.
>
> **CAT-2.** No other document may state a count of catalogued items. Where a count is useful in prose, the document MUST write it as a derived reference — e.g. *"the departments catalogued in `30` §3"* — never as a literal number.
>
> **CAT-3.** Other documents remain authoritative for the *content* of catalogued items. `06` owns what a department is and does; `32` owns what an agent's contract says; `03` owns what a stage does; `18` owns what a gate checks. This document owns only *which ones exist*.
>
> **CAT-4.** Adding, merging, splitting, retiring or renaming any catalogued item is a governed change (`29` §2) and MUST be reflected here in the same change.
>
> **CAT-5.** Identifiers are permanent and never reused. Items removed by merge or reclassification are moved to the **Retired Register** (§10) with their disposition, not deleted.

**Exception (CAT-2a):** the summary table in §11 of this document, the distributions in §4.1–§4.2, and the Phase report may state literal counts, because they are generated from the catalogue tables. Each is marked **GENERATED**.

**CAT-2b (R3):** a table marked `GENERATED` MUST be recomputed from its source table and diffed whenever the source changes. R2 hand-maintained §4.1 and §4.2 and both drifted (see §4.1). Checked by `DC-28`.

---

## 2. Catalogue Index

| Catalogue | Section | Content owner | Identifier |
|---|---|---|---|
| Departments | §3 | `02` (structure), `06` (contracts) | `SC-DEPT-###` |
| Agents | §4 | `32` (contracts) | `SC-AGENT-###` |
| Runtime Checkers & Executors | §5 | `21` (runtime), `16` (evidence) | `SC-RTC-###` |
| Lifecycle stages | §6 | `03` | `SC-STAGE-###` |
| Quality gates | §7 | `18` | `SC-GATE-<NAME>` |
| Workflows | §8 | `07` | `SC-WF-###` |
| Policies | §9 | `01` | `SC-POL-###` |
| Retired identifiers | §10 | this document | — |

Value **enumerations** (verdicts, severities, states) are not catalogues of instances; they are owned by `31` (result vocabularies) and `26` §2 (all other enumerations).

---

## 3. Department Catalogue

Content: `02` §3 (rationale), `06` (contracts). Applicability: `02` §4.

| ID | Department | Tier |
|---|---|---|
| SC-DEPT-001 | Orchestration | 1 |
| SC-DEPT-002 | Governance & Compliance | 1 |
| SC-DEPT-010 | Product Management | 2 |
| SC-DEPT-011 | Discovery | 2 |
| SC-DEPT-012 | Business Analysis | 2 |
| SC-DEPT-013 | Requirements Engineering | 2 |
| SC-DEPT-014 | Market & Competitive Intelligence | 2 |
| SC-DEPT-020 | Software Architecture | 3 |
| SC-DEPT-021 | Data Architecture | 3 |
| SC-DEPT-022 | Security Architecture | 3 |
| SC-DEPT-023 | Infrastructure & DevOps | 3 |
| SC-DEPT-024 | Cost Engineering / FinOps | 3 |
| SC-DEPT-025 | UX | 3 |
| SC-DEPT-026 | UI & Design System | 3 |
| SC-DEPT-027 | Admin Experience & Operability | 3 |
| SC-DEPT-030 | Backend Engineering | 4 |
| SC-DEPT-031 | Frontend Engineering | 4 |
| SC-DEPT-032 | Mobile Engineering | 4 |
| SC-DEPT-033 | Database Engineering | 4 |
| SC-DEPT-034 | Integration Engineering | 4 |
| SC-DEPT-050 | Code Review | 5 |
| SC-DEPT-051 | QA & Test Engineering | 5 |
| SC-DEPT-052 | Security Testing | 5 |
| SC-DEPT-053 | Performance Engineering | 5 |
| SC-DEPT-054 | Acceptance | 5 |
| SC-DEPT-060 | Release Management | 6 |
| SC-DEPT-061 | Operations | 6 |
| SC-DEPT-062 | Incident Management | 6 |
| SC-DEPT-063 | Continuous Improvement | 6 |
| SC-DEPT-064 | Knowledge & Organizational Learning | 6 |

**Cardinality: 30.** Unchanged in R2 — the department set passed audit.

---

## 4. Agent Catalogue

Contracts: `32_AGENT_CONTRACT_CATALOG.md`. Existence test: `05` §3.1.

An **Agent** is an AI-invoked role contract. Deterministic components are **not** agents (§5).

| ID | Agent | Dept | Archetype | Authority | Ceiling |
|---|---|---|---|---|---|
| SC-AGENT-001 | Orchestrator | 001 | GOVERNOR | DECIDE | M4 (process only) |
| SC-AGENT-002 | Planner | 001 | GOVERNOR | RECOMMEND | M4 |
| SC-AGENT-003 | Request Classifier | 001 | ANALYST | ADVISE | M4 |
| SC-AGENT-010 | Compliance Auditor | 002 | VERIFIER | VERIFY | M4 |
| SC-AGENT-011 | Policy Interpreter | 002 | ANALYST | RECOMMEND | M4 |
| SC-AGENT-020 | Product Manager | 010 | DEFINER | DECIDE | M3 |
| SC-AGENT-030 | Discovery Analyst | 011 | ANALYST | RECOMMEND | M3 |
| SC-AGENT-040 | Business Analyst | 012 | DEFINER | DECIDE | M3 |
| SC-AGENT-050 | Requirements Engineer | 013 | DEFINER | DECIDE | M3 |
| SC-AGENT-051 | NFR Specialist | 013 | DEFINER | DECIDE | M3 |
| SC-AGENT-052 | Requirements Quality Verifier | 013 | VERIFIER | VERIFY | M3 |
| SC-AGENT-060 | Market Researcher | 014 | ANALYST | ADVISE | M3 |
| SC-AGENT-061 | Competitive Analyst | 014 | ANALYST | RECOMMEND | M3 |
| SC-AGENT-062 | Innovation Strategist | 014 | ANALYST | RECOMMEND | M3 |
| SC-AGENT-063 | Source Verifier | 014 | VERIFIER | VERIFY | M2 |
| SC-AGENT-070 | Software Architect | 020 | ARCHITECT | DECIDE | M4 |
| SC-AGENT-071 | Technology Evaluator | 020 | ANALYST | RECOMMEND | M4 |
| SC-AGENT-072 | Architecture Reviewer | 020 | VERIFIER | VERIFY | M4 |
| SC-AGENT-080 | Data Architect | 021 | ARCHITECT | DECIDE | M4 |
| SC-AGENT-082 | Data Model Reviewer | 021 | VERIFIER | VERIFY | M4 |
| SC-AGENT-090 | Security Architect | 022 | ARCHITECT | DECIDE | M4 |
| SC-AGENT-100 | Infrastructure Architect | 023 | ARCHITECT | DECIDE | M3 |
| SC-AGENT-101 | Infrastructure Engineer | 023 | PRODUCER | EXECUTE | M2 |
| SC-AGENT-110 | Cost Engineer | 024 | ANALYST | RECOMMEND | M3 |
| SC-AGENT-120 | UX Designer | 025 | DEFINER | DECIDE | M3 |
| SC-AGENT-123 | UX Reviewer | 025 | VERIFIER | VERIFY | M3 |
| SC-AGENT-130 | Design System Owner | 026 | ARCHITECT | DECIDE | M3 |
| SC-AGENT-131 | UI Designer | 026 | DEFINER | RECOMMEND | M2 |
| SC-AGENT-133 | Design System Reviewer | 026 | VERIFIER | VERIFY | M3 |
| SC-AGENT-140 | Operability Classifier | 027 | ARCHITECT | DECIDE | M3 |
| SC-AGENT-141 | Admin Experience Designer | 027 | DEFINER | RECOMMEND | M2 |
| SC-AGENT-150 | Backend Engineer | 030 | PRODUCER | EXECUTE | M2 |
| SC-AGENT-160 | Frontend Engineer | 031 | PRODUCER | EXECUTE | M2 |
| SC-AGENT-170 | Mobile Engineer | 032 | PRODUCER | EXECUTE | M2 |
| SC-AGENT-180 | Database Engineer | 033 | PRODUCER | EXECUTE | M2 |
| SC-AGENT-181 | Migration Executor | 033 | PRODUCER | EXECUTE | M1 |
| SC-AGENT-190 | Integration Engineer | 034 | PRODUCER | EXECUTE | M2 |
| SC-AGENT-191 | External Contract Analyst | 034 | ANALYST | ADVISE | M2 |
| SC-AGENT-200 | Code Reviewer | 050 | VERIFIER | VERIFY | M3 |
| SC-AGENT-210 | Test Strategist | 051 | DEFINER | DECIDE | M3 |
| SC-AGENT-211 | Test Case Designer | 051 | DEFINER | RECOMMEND | M2 |
| SC-AGENT-213 | Accessibility Verifier | 051 | VERIFIER | VERIFY | M3 |
| SC-AGENT-214 | QA Verifier | 051 | VERIFIER | VERIFY | M3 |
| SC-AGENT-220 | Security Tester | 052 | VERIFIER | VERIFY | M3 |
| SC-AGENT-230 | Performance Engineer | 053 | VERIFIER | VERIFY | M3 |
| SC-AGENT-240 | Acceptance Verifier | 054 | VERIFIER | VERIFY | M4 |
| SC-AGENT-250 | Release Manager | 060 | GOVERNOR | RECOMMEND | M4 |
| SC-AGENT-251 | Handover Compiler | 060 | PRODUCER | EXECUTE | M2 |
| SC-AGENT-260 | Operations Engineer | 061 | PRODUCER | EXECUTE | M2 |
| SC-AGENT-262 | Operational Readiness Verifier | 061 | VERIFIER | VERIFY | M3 |
| SC-AGENT-270 | Incident Commander | 062 | GOVERNOR | DECIDE | M4 (containment only) |
| SC-AGENT-271 | Post-Incident Analyst | 062 | ANALYST | RECOMMEND | M3 |
| SC-AGENT-280 | Improvement Analyst | 063 | ANALYST | RECOMMEND | M2 |
| SC-AGENT-290 | Knowledge Curator | 064 | DEFINER | DECIDE | M2 |
| SC-AGENT-291 | Applicability Assessor | 064 | ANALYST | ADVISE | M2 |

**Cardinality: 55.**

### 4.1 Archetype distribution

> **GENERATED from the §4 table.** Do not maintain by hand.

| Archetype | Count |
|---|---|
| VERIFIER | 14 |
| ANALYST | 12 |
| DEFINER | 10 |
| PRODUCER | 9 |
| ARCHITECT | 6 |
| GOVERNOR | 4 |
| **Total** | **55** |

Verifiers remain the largest archetype. That is the structural expression of `SC-POL-005` and `SC-POL-006`.

### 4.2 Authority distribution

> **GENERATED from the §4 table.** Do not maintain by hand.

| Authority | Count |
|---|---|
| DECIDE | 15 |
| VERIFY | 14 |
| RECOMMEND | 13 |
| EXECUTE | 9 |
| ADVISE | 4 |
| **Total** | **55** |

**Corrected in R3.** Both distributions were hand-derived in R2 and disagreed with the §4 table they claimed to summarize — `CAT-2` violated inside the catalogue that defines it. Audit R3 did not cite this; it was found by recomputing the tables while resolving per-output determinism (`32` §9.2). The lesson is recorded as `DC-28`: **derived tables must be regenerated and diffed, not reviewed by eye.**

---

## 5. Runtime Checker & Executor Catalogue

**New in R2.** These were previously mis-modelled as agents. A component that computes a determination from stored state, or executes a command and captures its output, is **deterministic and must not be an AI invocation** — invoking a language model to compare two digests is both wasteful and epistemically wrong, and it would place model output inside the evidence-capture path that `SC-POL-023` exists to keep model-free.

| Kind | Meaning | Produces |
|---|---|---|
| `CHECKER` | Computes a determination from stored state | `ANALYSIS`-equivalent determinations recorded as `OBSERVATION` evidence |
| `EXECUTOR` | Runs a declared command and captures its output | `EXECUTION` evidence (`16` §3) |

| ID | Component | Kind | Enforces / supports | Was |
|---|---|---|---|---|
| SC-RTC-001 | Store Integrity Checker | CHECKER | `21` §6, `08` §7 | — |
| SC-RTC-002 | Evidence Integrity Checker | CHECKER | `16` §8 | SC-AGENT-012 |
| SC-RTC-003 | Workspace Reconciler | CHECKER | `SC-POL-032`, `21` §10 | — |
| SC-RTC-004 | Staleness Calculator | CHECKER | `SC-POL-031` | — |
| SC-RTC-005 | Scope Conformance Checker | CHECKER | `SC-POL-009`, `05` §4 | SC-AGENT-202 |
| SC-RTC-006 | Output Schema Validator | CHECKER | `19` §6 | — |
| SC-RTC-007 | Traceability & Orphan Checker | CHECKER | `SC-POL-014`, `08` §5.1 | SC-AGENT-241 |
| SC-RTC-008 | Configuration Consistency Checker | CHECKER | `12` §8, `KI-17` | SC-AGENT-142 |
| SC-RTC-009 | Consumption Meter | CHECKER | `SC-POL-028` | SC-AGENT-111 |
| SC-RTC-010 | Policy Enforcement Coverage Checker | CHECKER | `24` R1.1, `DC-5` | — |
| SC-RTC-011 | Build Executor | EXECUTOR | `14` §10 | — |
| SC-RTC-012 | Test Executor | EXECUTOR | `15` §7 | SC-AGENT-212 |
| SC-RTC-013 | Standards & Lint Checker | EXECUTOR | `14` §2 | SC-AGENT-201 |
| SC-RTC-014 | Design Conformance Scanner | EXECUTOR | `SC-POL-003`, `13` §7 | — |
| SC-RTC-015 | Secrets Scanner | EXECUTOR | `17` SEC-3 | — |
| SC-RTC-016 | Dependency Vulnerability Scanner | EXECUTOR | `17` §11 | SC-AGENT-221 |
| SC-RTC-017 | Accessibility Automated Checker | EXECUTOR | `13` §5.3 | — |
| SC-RTC-018 | Performance Measurement Harness | EXECUTOR | `15` §3 | — |
| SC-RTC-019 | Visual Regression Runner | EXECUTOR | `SC-WF-013` | — |

**Cardinality: 19.**

### 5.1 Rules

- **RTC-1** Runtime components contain no model invocation. Their output is reproducible from their inputs.
- **RTC-2** They are the **only** producers of `EXECUTION` and `OBSERVATION` evidence (`16` §3.2).
- **RTC-3** No agent tool grant may invoke a runtime component in a way that lets the agent author or alter its output.
- **RTC-4** A runtime component failure yields `NOT_VERIFIED` for the criteria it feeds, never `PASS` (`22` DG-1).
- **RTC-5** Adding a runtime component is a governed change; removing one requires owner approval, because each is an enforcement point.

---

## 6. Lifecycle Stage Catalogue

Content: `03`. Existence test: `03` §1.4.

| ID | Stage | Phase | Owner | Gate |
|---|---|---|---|---|
| SC-STAGE-002 | INTAKE | A | 010 | `SC-GATE-INTAKE` |
| SC-STAGE-003 | DISCOVERY | A | 011 | `SC-GATE-DISCOVERY` |
| SC-STAGE-004 | PRODUCT_VALIDATION | A | 010 | `SC-GATE-PRODUCT_VALIDATION` |
| SC-STAGE-010 | BUSINESS_ANALYSIS | B | 012 | `SC-GATE-REQUIREMENTS` |
| SC-STAGE-011 | REQUIREMENTS | B | 013 | `SC-GATE-REQUIREMENTS` |
| SC-STAGE-013 | MARKET_AND_COMPETITIVE_INTELLIGENCE | B | 014 | `SC-GATE-COMPETITIVE` |
| SC-STAGE-015 | FEASIBILITY | B | 020 | `SC-GATE-FEASIBILITY` |
| SC-STAGE-016 | RISK | B | 002 | `SC-GATE-FEASIBILITY` |
| SC-STAGE-020 | ARCHITECTURE | C | 020 | `SC-GATE-ARCHITECTURE` |
| SC-STAGE-021 | DATA_ARCHITECTURE | C | 021 | `SC-GATE-ARCHITECTURE` |
| SC-STAGE-022 | SECURITY_ARCHITECTURE | C | 022 | `SC-GATE-SECURITY_DESIGN` |
| SC-STAGE-023 | TECHNOLOGY_SELECTION | C | 020 | `SC-GATE-TECHNOLOGY` |
| SC-STAGE-024 | UX | C | 025 | `SC-GATE-DESIGN` |
| SC-STAGE-025 | DESIGN_SYSTEM | C | 026 | `SC-GATE-DESIGN` |
| SC-STAGE-026 | ADMIN_OPERABILITY | C | 027 | `SC-GATE-DESIGN` |
| SC-STAGE-030 | PLANNING | D | 001 | `SC-GATE-PLAN` |
| SC-STAGE-040 | IMPLEMENTATION | E | Tier 4 | `SC-GATE-IMPLEMENTATION` |
| SC-STAGE-041 | CODE_REVIEW | E | 050 | `SC-GATE-CODE_REVIEW` |
| SC-STAGE-042 | QA | F | 051 | `SC-GATE-QA` |
| SC-STAGE-043 | SECURITY_TESTING | F | 052 | `SC-GATE-SECURITY` |
| SC-STAGE-044 | PERFORMANCE | F | 053 | `SC-GATE-PERFORMANCE` |
| SC-STAGE-045 | ACCEPTANCE | F | 054 | `SC-GATE-ACCEPTANCE` |
| SC-STAGE-050 | RELEASE | G | 060 | `SC-GATE-RELEASE` |
| SC-STAGE-052 | OPERATIONS | G | 061 | NONE (continuous) |
| SC-STAGE-053 | CONTINUOUS_IMPROVEMENT | G | 063 | NONE (continuous) |
| SC-STAGE-054 | INCIDENT | G | 062 | `SC-GATE-INCIDENT_CLOSURE` |

**Cardinality: 26.**

**Note on the number:** R1 claimed 26 while containing 30. R2 applied the Stage Existence Test (`03` §1.4) to all 30 and merged four. The result is 26 by arithmetic coincidence, not by adjusting the analysis to fit the old claim. The four merges are individually justified in `03` §1.5 and each rests on the same rule — same accountable department, same gate, no distinct dependency position. Had the test produced 24 or 28, that is what this catalogue would record.

---

## 7. Quality Gate Catalogue

Content and criteria: `18` §3.

| ID | After stage | Blocking |
|---|---|---|
| SC-GATE-INTAKE | 002 | Yes |
| SC-GATE-DISCOVERY | 003 | Yes |
| SC-GATE-PRODUCT_VALIDATION | 004 | Yes |
| SC-GATE-REQUIREMENTS | 010 + 011 | Yes |
| SC-GATE-COMPETITIVE | 013 | Yes |
| SC-GATE-FEASIBILITY | 015 + 016 | Yes |
| SC-GATE-ARCHITECTURE | 020 + 021 | Yes |
| SC-GATE-SECURITY_DESIGN | 022 | Yes |
| SC-GATE-TECHNOLOGY | 023 | Yes |
| SC-GATE-DESIGN | 024 + 025 + 026 | Yes |
| SC-GATE-PLAN | 030 | Yes |
| SC-GATE-IMPLEMENTATION | 040 | Yes |
| SC-GATE-CODE_REVIEW | 041 | Yes |
| SC-GATE-QA | 042 | Yes |
| SC-GATE-SECURITY | 043 | Yes |
| SC-GATE-PERFORMANCE | 044 | Conditional |
| SC-GATE-ACCEPTANCE | 045 | Yes |
| SC-GATE-RELEASE | 050 | Yes |
| SC-GATE-INCIDENT_CLOSURE | 054 | Yes |

**Cardinality: 19.**

---

## 8. Workflow Catalogue

Content: `07` §7.

| ID | Workflow |
|---|---|
| SC-WF-001 | New Project Initiation |
| SC-WF-002 | Requirements Definition |
| SC-WF-003 | Architecture & Technology |
| SC-WF-004 | Design Definition |
| SC-WF-005 | Feature Implementation |
| SC-WF-006 | Bug Fix |
| SC-WF-007 | Security Fix (expedited) |
| SC-WF-008 | Change Request |
| SC-WF-009 | Proposal Lifecycle |
| SC-WF-010 | Release & Handover |
| SC-WF-011 | Incident Response |
| SC-WF-012 | Research |
| SC-WF-013 | Design System Change |
| SC-WF-014 | Operational Change |
| SC-WF-015 | Project Reconciliation |

**Cardinality: 15.**

---

## 9. Policy Catalogue

Content: `01`.

| Range | Policies | Origin |
|---|---|---|
| SC-POL-001 … SC-POL-021 | 21 | Founding assignment |
| SC-POL-022 … SC-POL-034 | 13 | Derived in Phase 1 |
| SC-POL-035 | 1 | Derived in Audit R2 (`33`, Correction 13) |

**Cardinality: 35.** Enforcement-class distribution is owned by `01` §6 and derived from the same list.

---

## 10. Retired Register

Identifiers withdrawn in R2. **Never reused** (`CAT-5`). Retained so that any external reference to an R1 identifier resolves to its disposition.

### 10.1 Agents merged into another agent

| Retired | Name | Merged into | Reason |
|---|---|---|---|
| SC-AGENT-021 | Roadmap Analyst | SC-AGENT-020 | No authority, tool, trust or context distinction from Product Manager |
| SC-AGENT-031 | Assumption Mapper | SC-AGENT-030 | Assumption extraction is a Discovery work product, not a role |
| SC-AGENT-041 | Rule Modeler | SC-AGENT-040 | Task mode of Business Analyst; identical contract surface |
| SC-AGENT-042 | State Machine Modeler | SC-AGENT-040 | Same |
| SC-AGENT-081 | Migration Strategist | SC-AGENT-080 | Same authority, tools and context as Data Architect |
| SC-AGENT-091 | Threat Modeler | SC-AGENT-090 | Threat modeling is the core Security Architecture work product |
| SC-AGENT-092 | Privacy Analyst | SC-AGENT-090 | Now a mandatory responsibility and required output section — stronger than an advisory role whose output could be ignored |
| SC-AGENT-102 | Observability Engineer | SC-AGENT-101 | Same archetype, authority and tool surface as build/deploy production |
| SC-AGENT-121 | Flow & State Modeler | SC-AGENT-120 | State coverage is the core UX work product |
| SC-AGENT-122 | Content Strategist | SC-AGENT-120 | Same contract surface; now a required UX output section |
| SC-AGENT-132 | Accessibility Designer | SC-AGENT-130 | Design-side a11y is token-bound and therefore Design System Owner territory; independent verification remains at SC-AGENT-213 |
| SC-AGENT-151 | API Implementer | SC-AGENT-150 | Differed only by prompt wording |
| SC-AGENT-161 | Component Implementer | SC-AGENT-160 | Differed only by prompt wording |
| SC-AGENT-261 | Runbook Author | SC-AGENT-260 | Same archetype, authority and tools |
| SC-AGENT-281 | Technical Debt Registrar | SC-AGENT-280 | Same |

### 10.2 Agents reclassified as runtime components

| Retired | Name | Became | Reason |
|---|---|---|---|
| SC-AGENT-012 | Evidence Integrity Checker | SC-RTC-002 | Purely deterministic |
| SC-AGENT-111 | Consumption Monitor | SC-RTC-009 | Purely deterministic |
| SC-AGENT-142 | Configuration Auditor | SC-RTC-008 | Purely deterministic |
| SC-AGENT-201 | Standards Checker | SC-RTC-013 | Purely deterministic |
| SC-AGENT-202 | Scope Conformance Checker | SC-RTC-005 | Purely deterministic |
| SC-AGENT-212 | Test Executor | SC-RTC-012 | Executes and captures; must be model-free (`SC-POL-023`) |
| SC-AGENT-221 | Dependency & Secrets Scanner | SC-RTC-016, SC-RTC-015 | Purely deterministic; split by tool |
| SC-AGENT-241 | Traceability Auditor | SC-RTC-007 | Graph query over stored links |

### 10.3 Agents split

| Original | Split into | Reason |
|---|---|---|
| SC-AGENT-210 Test Engineer | SC-AGENT-210 Test Strategist (DEFINER/DECIDE) + SC-AGENT-214 QA Verifier (VERIFIER/VERIFY) | R1 gave one agent two authority levels. Splitting also means the role that set the strategy is not the sole role declaring it satisfied (`SC-POL-006`). |
| SC-AGENT-260 Operations Engineer | SC-AGENT-260 Operations Engineer (PRODUCER/EXECUTE) + SC-AGENT-262 Operational Readiness Verifier (VERIFIER/VERIFY) | R1 gave one agent `PRODUCER+VERIFIER`. An agent that configures monitoring must not be the one certifying that monitoring works. |

### 10.4 Agents renamed or re-typed

| ID | R1 | R2 | Reason |
|---|---|---|---|
| SC-AGENT-101 | Build & Release Engineer, PRODUCER | Infrastructure Engineer, PRODUCER | Absorbed observability; name now covers the scope |
| SC-AGENT-140 | Admin Operability Reviewer, ANALYST/DECIDE | Operability Classifier, ARCHITECT/DECIDE | R1 paired an ANALYST archetype with DECIDE authority, which the archetype table forbids. The role genuinely decides canon (the Configuration Register), so it is a Tier-3 design authority. Renamed because "Reviewer" implied the VERIFIER archetype. |
| SC-AGENT-213 | Accessibility Verifier, `JUDGMENT+DETERMINISTIC` | Accessibility Verifier, JUDGMENT-only | Deterministic checks moved to SC-RTC-017 |
| SC-AGENT-220 | Security Tester, `JUDGMENT+DETERMINISTIC` | Security Tester, JUDGMENT-only | Deterministic scans moved to SC-RTC-015/016 |
| SC-AGENT-230 | Performance Engineer, DETERMINISTIC | Performance Engineer, JUDGMENT-only | Measurement moved to SC-RTC-018; the agent interprets against targets |
| SC-AGENT-250 | Release Manager, `DECIDE/RECOMMEND` | Release Manager, RECOMMEND | The Release Gate verdict comes from the deterministic gate engine, not from an agent (`18` §1.1) |
| SC-AGENT-290 | Knowledge Curator, ANALYST/DECIDE | Knowledge Curator, DEFINER/DECIDE | Same archetype/authority conflict as SC-AGENT-140 |

### 10.5 Lifecycle stages retired

| Retired | Stage | Merged into | Reason |
|---|---|---|---|
| SC-STAGE-001 | IDEA | SC-STAGE-002 INTAKE | Same accountable department, no gate, no distinct dependency position. The `Idea` record remains a mandatory immutable INTAKE work product and a gate criterion. |
| SC-STAGE-012 | NON_FUNCTIONAL_REQUIREMENTS | SC-STAGE-011 REQUIREMENTS | Same department, same gate, ran SOFT-parallel. NFR coverage remains an explicit gate criterion and SC-AGENT-051 remains a distinct agent. |
| SC-STAGE-014 | COMPETITIVE_INNOVATION | SC-STAGE-013 | Same department, same gate; the internal ordering is workflow sequencing, not a stage boundary. |
| SC-STAGE-051 | HANDOVER | SC-STAGE-050 RELEASE | Same department, same gate; the handover package is composed *before* the Release Gate evaluates it, so it was never a downstream stage. |

---

## 11. Derived Summary (generated from §3–§9)

| Catalogue | Count | R1 claim | R1 actual |
|---|---|---|---|
| Departments | 30 | 30 | 30 |
| Agents | 55 | 61 | 76 |
| Runtime checkers & executors | 19 | — | — |
| Lifecycle stages | 26 | 26 | 30 |
| Quality gates | 19 | 19 | 19 |
| Workflows | 15 | 15 | 15 |
| Policies | 35 | 34 | 34 |

**Total governed role-bearing components: 74** (55 agents + 19 runtime components), against 76 agents in R1. The count barely moved; what changed is that 19 of them are no longer AI invocations, and the 8 formerly-agent deterministic checks are now structurally incapable of being influenced by model output — which was the real defect, not the number.
