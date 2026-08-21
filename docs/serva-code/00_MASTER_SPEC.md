# 00 — SERVA CODE 1.0 · MASTER SPECIFICATION

**Document ID:** SC-DOC-000
**Status:** BASELINE R4
**Type:** Root / Map Document
**Supersedes:** —
**Normative:** Yes, for definitions and cross-references. Normative rules live in `01_COMPANY_CONSTITUTION.md`.

---

## ملخص تنفيذي (Arabic Abstract)

Serva Code هي **نظام تشغيل لشركة برمجيات ذكية تعمل محليًا**. ليست مكتبة ولا وكيلًا واحدًا ولا مولّد مشاريع ولا خدمة سحابية. هي طبقة حوكمة ومسؤولية هندسية تعمل على جهاز مالكها داخل VS Code، وتستخدم Claude Code كمحرك تنفيذ خاضع لإدارتها.

المبدأ الأعلى: **العميل يحدد المشكلة والأهداف التجارية، وServa Code تحدد كيف يجب هندسة المنتج.**

بقية هذه الوثيقة وما يليها مكتوبة بالإنجليزية لأن المصطلحات الهندسية والعقود والحالات ستتحول لاحقًا إلى Schemas وSoftware، ووحدة المصطلح شرط لتحويلها.

---

## 1. Executive Definition

**Serva Code is a Local AI Software Company Operating System.**

It is a governed, multi-department, evidence-driven engineering organization that:

- runs **locally**, on a single owner's machine,
- operates **inside VS Code** as its primary human interface,
- **directs** Claude Code (and, in principle, any comparable AI execution engine) as a subordinate execution engine,
- owns **end-to-end engineering responsibility** for a software product, from raw idea to operable, released, maintainable system,
- and **persists its own truth** independently of any AI chat history.

What distinguishes Serva Code from an "AI coding assistant" is not capability. It is **accountability structure**:

| Assistant | Serva Code |
|---|---|
| Answers a prompt | Owns a lifecycle |
| Executes what it is told | Determines what should be done |
| Claims completion | Proves completion with evidence |
| Forgets between sessions | Persists project truth in its own store |
| One actor | Departments with separated authority |
| Self-certifies | Executor ≠ Reviewer ≠ Acceptor |
| Optimizes for the answer | Optimizes for the product winning |

### 1.1 The Supreme Principle

> **The client defines the problem and business goals.
> Serva Code determines how the product should be engineered.**

This principle is codified as policy `SC-POL-001` and is the tie-breaker for every ambiguity in this specification. Where any document conflicts with it, this principle wins.

### 1.2 What "Company" means here — literally, not metaphorically

Serva Code models a software company because a software company solves a coordination problem that a single agent cannot: **separation of authority**. A department is not a persona or a prompt style. A department is:

- a **bounded responsibility** (what it and only it owns),
- an **authority level** (what it may decide alone, propose, or must escalate),
- a set of **contracts** (typed inputs, typed outputs, required evidence),
- and a **refusal surface** (what it must decline to do even when asked).

If a proposed department has no unique authority and no unique refusal surface, it is not a department — it is a task. See `02_COMPANY_STRUCTURE.md`.

---

## 2. Product Mission

Serva Code exists to make it possible for **one person** to ship software of a quality that normally requires an organization — and to make that quality **provable rather than claimed**.

Three mission statements, in priority order when they conflict:

1. **M1 — Correctness of Truth.** The state of a project as recorded by Serva Code must match reality. A false PASS is a worse failure than a slow FAIL.
2. **M2 — Completeness of Responsibility.** No engineering concern is orphaned. Every concern (security, accessibility, operability, cost, competitiveness) has a named owner and a defined moment where it is exercised.
3. **M3 — Throughput.** Subject to M1 and M2, the system should minimize the owner's cognitive load, decisions, and elapsed time.

**Ordering is normative.** When throughput conflicts with truth, truth wins (`SC-POL-005`, `SC-POL-020`).

---

## 3. Scope (Serva Code 1.0)

In scope for 1.0:

| # | Capability | Primary Document |
|---|---|---|
| S1 | A formal, tailorable project lifecycle from IDEA to CONTINUOUS IMPROVEMENT | `03` |
| S2 | An Orchestrator that classifies work, plans, routes, sequences, and gates it | `04` |
| S3 | A typed Agent contract model and agent runtime semantics | `05` |
| S4 | Department definitions with authority, contracts and refusal surfaces | `02`, `06` |
| S5 | A workflow model with explicit handoff protocol and parallelism rules | `07` |
| S6 | A persistent Project Knowledge Model (project memory) | `08` |
| S7 | Decision governance: ADRs, change requests, impact analysis, approval authority | `09` |
| S8 | A proposal system through which any agent can raise improvements | `10` |
| S9 | An institutional competitive/innovation function | `11` |
| S10 | A mandatory Admin Operability Review per feature | `12` |
| S11 | Design governance: tokens, design system, accessibility, no-arbitrary-values | `13` |
| S12 | Engineering governance: SSOT, traceability, review separation | `14` |
| S13 | Testing & QA model | `15` |
| S14 | An Evidence Model that makes PASS falsifiable | `16` |
| S15 | Security governance across the lifecycle | `17` |
| S16 | Quality Gates with deterministic-first evaluation | `18` |
| S17 | Claude Code integration: invocation, scoping, tool restriction, session, structured output | `19` |
| S18 | VS Code integration model and governance visibility | `20` |
| S19 | Local runtime model: storage, concurrency, isolation, backup, reproducibility | `21` |
| S20 | Failure taxonomy and recovery procedures | `22` |
| S21 | Release, handover, operations, incident management | `23` |
| S22 | Definitions of Done at every level, and Serva Code 1.0 readiness definition | `24` |
| S23 | Human authority and trust boundaries | `28` |
| S24 | Canonical catalogues and a single outcome vocabulary | `30`, `31` |
| S25 | Complete per-agent contracts | `32` |
| S26 | Platform isolation and provider capability constraints, with qualification requirements | `33` |

### 3.1 Non-Goals (explicitly out of scope for 1.0)

| # | Non-Goal | Rationale |
|---|---|---|
| NG1 | Multi-tenancy in Serva Code itself | Single-owner local tool (`21`) |
| NG2 | A subscription/billing system for Serva Code | Not a SaaS |
| NG3 | Public end-user accounts for Serva Code | Not a SaaS |
| NG4 | Kubernetes / HA / distributed deployment of Serva Code | Complexity without requirement (`SC-POL-017`) |
| NG5 | A fixed technology stack for client products | Forbidden by `SC-POL-016` |
| NG6 | Choosing Serva Code's own implementation stack | Deferred; see `27_SERVA_SELF_REQUIREMENTS.md` |
| NG7 | Replacing the owner's judgment on business strategy | Client owns problem & goals (`SC-POL-001`) |
| NG8 | Autonomous unattended release to production | Human authority boundary (`28`) |
| NG9 | Training or fine-tuning models | Out of product concept |
| NG10 | Being a general-purpose chat assistant | Serva is a governance layer, not a chat surface |
| NG11 | Guaranteeing AI output correctness by prompt engineering alone | Replaced by evidence (`16`) |

### 3.2 Phase boundary of this document set

Phase 1 produces **specification only**. No executable product code exists. Every statement in these documents is written to be convertible into schemas, state machines, and validators in later phases — that is the acceptance criterion for the documents themselves (`24`, `29`).

---

## 4. Core Principles (index)

The twenty founding principles supplied by the owner are formalized as numbered policies in `01_COMPANY_CONSTITUTION.md`. This section is an **index only** — do not restate policy text here.

| Policy | Short name |
|---|---|
| SC-POL-001 | Client Defines Problem, Serva Defines Engineering |
| SC-POL-002 | No Arbitrary Engineering Decisions |
| SC-POL-003 | No Arbitrary Design Decisions |
| SC-POL-004 | Single Source of Truth |
| SC-POL-005 | Evidence Before PASS |
| SC-POL-006 | Executor Does Not Self-Certify |
| SC-POL-007 | Execute → Review → Improve |
| SC-POL-008 | Never Silently Discard an Improvement |
| SC-POL-009 | Never Implement an Unapproved Major Change |
| SC-POL-010 | Configuration Over Code |
| SC-POL-011 | Every Product Must Have a Reason to Win |
| SC-POL-012 | Serva Code Must Know What It Does Not Know |
| SC-POL-013 | Impact Analysis Before Significant Change |
| SC-POL-014 | Requirements Traceability |
| SC-POL-015 | Decisions Must Be Remembered |
| SC-POL-016 | Research Before Technology Selection |
| SC-POL-017 | Simplicity Is a Professional Choice |
| SC-POL-018 | Security From Design |
| SC-POL-019 | Quality Includes Operations |
| SC-POL-020 | Project Memory Must Not Depend on AI Chat History |
| SC-POL-021 | Organizational Learning Without Blind Reuse |
| SC-POL-022 … SC-POL-034 | Policies derived during Phase 1 analysis — see `01` §4 |
| SC-POL-035 | Provider Capability Is Detected, Never Assumed (derived in Audit R2) |

Policies from 022 onward were **not explicitly stated in the assignment** but were found necessary while specifying the system. Each carries a `Derived: yes` marker and a justification in `01`. Membership and cardinality: `30` §9.

---

## 5. Company Model (overview)

Serva Code is organized into **six authority tiers** and **N departments**. Tiers, not department count, are what make authority tractable.

```
TIER 0  OWNER (human)              — sole holder of business authority
   │
TIER 1  GOVERNANCE                 — Orchestrator, Constitution enforcement
   │
TIER 2  DEFINITION                 — Product, Discovery, BA, Requirements, Market/Innovation
   │
TIER 3  DESIGN AUTHORITY           — Architecture, Data, Security Arch, UX, Design System, FinOps
   │
TIER 4  PRODUCTION                 — Backend, Frontend, Mobile, DB, Admin Experience, Infra
   │
TIER 5  ASSURANCE                  — Code Review, QA/Test, Security Test, Performance, Acceptance
   │
TIER 6  OPERATION                  — Release, Operations, Incident, Continuous Improvement
```

Two structural rules follow from the tiers and are enforced constitutionally:

- **Downward specification, upward evidence.** A tier specifies *what* to the tier below; the tier below returns *evidence* upward. A Tier-4 department cannot redefine a Tier-3 decision; it can only raise a Proposal or an Escalation.
- **Assurance is never subordinate to Production.** Tier 5 reports to Tier 1, not to the department whose work it evaluates. This is the structural implementation of `SC-POL-006`.

Full definitions, merges, splits, and the rationale for each department's existence: `02_COMPANY_STRUCTURE.md`. Per-department contracts: `06_DEPARTMENT_CONTRACTS.md`.

---

## 6. Lifecycle Overview

Serva Code defines a set of lifecycle stages (catalogued in `30` §6) grouped into **7 phases**, with explicit dependency edges — not a waterfall list. Each stage satisfies the Stage Existence Test (`03` §1.4); four R1 stages failed it and were merged (`03` §1.5).

```
PHASE A  FRAME      INTAKE (incl. Idea capture) → DISCOVERY → PRODUCT_VALIDATION
PHASE B  DEFINE     BUSINESS_ANALYSIS → REQUIREMENTS (functional + NFR)
                    ∥ MARKET_AND_COMPETITIVE_INTELLIGENCE
                    → FEASIBILITY ∥ RISK
PHASE C  DESIGN     ARCHITECTURE ∥ DATA_ARCHITECTURE ∥ SECURITY_ARCHITECTURE
                    → TECHNOLOGY_SELECTION
                    UX → DESIGN_SYSTEM ∥ ADMIN_OPERABILITY
PHASE D  PLAN       PLANNING
PHASE E  BUILD      IMPLEMENTATION → CODE_REVIEW
PHASE F  ASSURE     QA ∥ SECURITY_TESTING ∥ PERFORMANCE → ACCEPTANCE
PHASE G  DELIVER    RELEASE (incl. handover) → OPERATIONS → CONTINUOUS_IMPROVEMENT
                    INCIDENT (on demand)
```

Key properties, specified fully in `03_PROJECT_LIFECYCLE.md`:

- Each stage has **entry conditions**, **exit conditions**, **owning department**, **produced artifacts**, and a **gate** (or an explicit "no gate" declaration).
- Stages are **tailorable**: a lifecycle *profile* selects which stages apply to a given work item. A one-line bug fix does not run DISCOVERY. Tailoring is itself governed — omissions are recorded, not silent (`SC-POL-024`).
- The lifecycle is **re-entrant**: CONTINUOUS_IMPROVEMENT feeds back into INTAKE, and any stage can be forced backward by a gate FAIL.
- BUILD is **iterative per feature**, not a single global phase.

---

## 7. Agent Model Overview

An **Agent** is an executable role contract, not a personality. It is defined by `05_AGENT_ARCHITECTURE.md` and instantiated per department in `06_DEPARTMENT_CONTRACTS.md`.

Every agent contract declares, at minimum:

`id · department · archetype · authority_level · mission · responsibilities · non_responsibilities · inputs · outputs (typed, each with determinism) · output_schema_ref · tools (allowlist) · filesystem_scope · network_scope · allowed_actions · forbidden_actions · refusal_surface · required_evidence · quality_criteria · escalation_conditions · failure_conditions · proposal_behavior · review_responsibilities · conflict_of_interest · context_budget · magnitude_ceiling · untrusted_content_rule`

Complete contracts for every agent: `32`. Membership: `30` §4. A **fourth** separation was added in R2: an **agent** is an AI-invoked role, whereas a **runtime component** (`30` §5) is a deterministic checker or executor with no model invocation — the two must never be conflated, because deterministic verification inside a model invocation is neither reproducible nor trustworthy.

Three separations are structural:

1. **Agent ≠ Department.** A department may host several agents; an agent may serve several workflows if that is architecturally correct.
2. **Agent ≠ Agent Run.** The contract is static and versioned; an *Agent Run* is a recorded execution with inputs, outputs, evidence, cost and verdict (`08`).
3. **Agent ≠ Model.** The contract binds a role to responsibilities. The engine (Claude Code) is an implementation detail bound at run time (`19`).

Agents cannot grant themselves capability. Tool access is an allowlist resolved by the runtime, not text in a prompt (`SC-POL-026`, `19`, `28`).

---

## 8. Governance Model

Governance in Serva Code answers four questions:

| Question | Mechanism | Document |
|---|---|---|
| Who may decide this? | Authority Matrix (tiers + decision classes) | `09` |
| How was it decided? | Decision Records / ADRs | `09` |
| What else does it touch? | Impact Analysis | `09` |
| May work proceed? | Quality Gates | `18` |

And two supporting flows:

- **Proposal flow** — how an improvement discovered mid-work becomes a governed decision instead of an unrequested change (`10`).
- **Change Request flow** — how a change to already-baselined truth (requirement, architecture, design token, contract) is admitted (`09`).

The governing invariant:

> **No baselined truth changes without a recorded decision. No recorded decision exists without alternatives considered and a re-evaluation trigger.**

---

## 9. Project Knowledge Philosophy

Project truth lives in the **Project Knowledge Store** — a Serva-owned, on-disk, machine-readable store. Chat transcripts are *not* project memory; they are, at most, evidence attachments.

Three tiers of knowledge, with different durability guarantees:

| Tier | Contains | Durability | Example |
|---|---|---|---|
| **T-CANON** | Baselined truth | Immutable-by-append; changes only via Decision/CR | Requirements, ADRs, Design Tokens, Contracts |
| **T-WORKING** | In-flight work | Mutable, versioned | Tasks, drafts, open proposals |
| **T-TRACE** | Records of what happened | Append-only, never edited | Agent Runs, Evidence, Gate Results, Audit Events |

`T-TRACE` is never rewritten. If a record is wrong, a correcting record is appended. This is what makes the system auditable and what makes `SC-POL-005` enforceable rather than aspirational.

Entity catalogue, relations, invariants and integrity rules: `08_PROJECT_KNOWLEDGE_MODEL.md`.

---

## 10. Evidence Philosophy

The central epistemic rule of Serva Code:

> **NO EVIDENCE = NOT VERIFIED.**
> `NOT VERIFIED` is a distinct outcome from `PASS` and from `FAIL`. It must never be reported as either.

Consequences that shape the whole system:

- A verdict is a **claim bound to artifacts**, not a sentence in prose.
- Evidence has a **strength ordering** (`16` §3): deterministic machine output > reproducible runtime observation > structured AI analysis > AI assertion. An AI assertion alone can never justify a `MET` criterion where stronger evidence is obtainable.
- Evidence has **provenance and validity**. Validity is derived, never stored: evidence produced against a superseded artifact version derives to `STALE` and must be re-collected (`31` §3).
- Where a claim is genuinely not machine-verifiable (e.g. "the information architecture is coherent"), the system does not fake evidence — the criterion resolves on a **`JUDGED` basis** with a named reviewer role, explicit criteria and a confidence value, which caps the gate at `PASS_WITH_QUALIFICATION` and is visible as such (`31` §2, §4.1).

Full model: `16_EVIDENCE_MODEL.md`. Gate consumption of evidence: `18_QUALITY_GATES.md`.

---

## 11. Quality Philosophy

Quality in Serva Code is defined as **fitness proven against declared intent**, and it is layered:

1. **Requirement quality** — is the requirement testable, traceable, and non-contradictory?
2. **Design quality** — is the decision justified, alternatives evaluated, and constraints satisfied?
3. **Implementation quality** — does the code satisfy the requirement, standards, and SSOT rules?
4. **Verification quality** — is the evidence real, fresh, sufficient, and independently produced?
5. **Operational quality** — can the product be run, observed, recovered, and changed by its owner (`SC-POL-019`)?
6. **Competitive quality** — does the product have a defensible reason to be chosen (`SC-POL-011`)?

A product that passes 1–4 and fails 5 or 6 is **not done**. This is a deliberate departure from conventional "definition of done".

---

## 12. AI Integration Philosophy

Claude Code is a **subordinate execution engine**, not the system.

| Serva Code owns | The AI engine provides |
|---|---|
| What work exists | Language, reasoning, code generation |
| Who is allowed to do it | Analysis and drafting within a scoped role |
| What context that role receives | Execution of tool calls it is permitted to make |
| What tools are permitted | Structured output conforming to a requested schema |
| What counts as done | — |
| What is remembered | — |

Design consequences (specified in `19_CLAUDE_INTEGRATION.md`):

- **Scoped context, not full history.** Each Agent Run receives a deliberately constructed context bundle derived from the Knowledge Store — never "whatever was in the chat".
- **Role isolation.** Executor and reviewer runs are separate sessions with separate context; the reviewer must not inherit the executor's reasoning (`SC-POL-006`).
- **Tool restriction is enforced outside the model.** Prompt-level instruction is not a security boundary (`28`).
- **Structured output is contractual.** A run that cannot produce schema-valid output is a run failure, not a soft result.
- **Engine-agnostic by construction.** The engine is behind an abstraction so that engine change is a Technology Decision, not a rewrite (`27`).
- **AI failure modes are first-class**: hallucinated evidence, silent scope reduction, fabricated file paths, over-claiming completion, context truncation, non-determinism. Each has a named mitigation in `22_FAILURE_AND_RECOVERY.md`.

---

## 13. Local-First Philosophy

Serva Code runs on one machine, for one owner, offline-capable except where an AI engine or research task genuinely requires network access.

Implications specified in `21_LOCAL_RUNTIME_MODEL.md`:

- **Data locality** — all project truth on local disk under a defined layout; no implicit upload.
- **Isolation** — projects are isolated by default; cross-project reads happen only through the Organizational Learning interface (`SC-POL-021`), never by direct file access.
- **Single-writer, but concurrency-safe** — one human user does not imply one concurrent process. Parallel agent runs, background research and long-running tasks demand locking, transactional writes and idempotent operations *in 1.0*, not later.
- **Durability** — the store must survive crashes, interrupted sessions and killed processes without leaving unreadable state.
- **Reproducibility** — an Agent Run must be re-constructible from stored inputs even if the model output would differ (`16`, `21`).
- **Backup/restore is a 1.0 requirement**, not an operations nicety, because the store *is* the product's memory (`SC-POL-020`).

---

## 14. VS Code Integration Philosophy

VS Code is the **primary human surface**. The chat with the AI engine is not.

Non-negotiable UX properties (`20_VSCODE_INTEGRATION.md`):

- The owner must be able to answer, at a glance: *Is this project governed? What stage is it in? What is blocked? What is waiting on me?*
- A governed project carries an explicit, verifiable state marker: **`SERVA GOVERNANCE = ACTIVE`**, backed by a real store — never a badge that can lie.
- The owner must never be confused about **who is acting** — Serva, an agent, or a raw AI session.
- Everything shown in the UI must be **derived from the Knowledge Store**, so the UI cannot present a different truth than the system holds.

No extension is implemented in Phase 1. `20` specifies surfaces, states and information contracts only.

---

## 15. Document Map & Cross-References

| Doc | Title | Owns (authoritative for) | Must not restate |
|---|---|---|---|
| `00` | Master Specification | Vision, scope, philosophy, map, 1.0 Ready definition | Policy text, contracts |
| `01` | Company Constitution | Policy text and enforcement | Process detail |
| `02` | Company Structure | Departments, tiers, authority, RACI | Per-agent contracts |
| `03` | Project Lifecycle | Stages, entry/exit, dependencies, tailoring | Gate criteria detail |
| `04` | Orchestrator Model | Classification, routing, planning, orchestration state | Department internals |
| `05` | Agent Architecture | Agent contract schema, run semantics | Individual agents |
| `06` | Department Contracts | Every department & agent instance contract | Schema definition |
| `07` | Workflow Model | Workflow definition, handoff protocol, parallelism | Lifecycle stage list |
| `08` | Project Knowledge Model | Entities, relations, invariants | Storage layout |
| `09` | Decision Governance | Decisions, ADRs, CRs, impact analysis, authority matrix | Proposal schema |
| `10` | Proposal System | Proposal schema, triage, states | Decision records |
| `11` | Competitive Innovation | Market/competitive process and artifacts | Product requirements |
| `12` | Admin Operability | Admin review process, configuration taxonomy | Design tokens |
| `13` | Design Governance | Design system, tokens, a11y, design decisions | UI implementation |
| `14` | Engineering Governance | Code standards process, SSOT, review, traceability | Test model |
| `15` | Testing & QA | Test strategy, levels, test entities, QA process | Evidence integrity |
| `16` | Evidence Model | Evidence types, strength, provenance, integrity, sufficiency | Outcome vocabularies, validity model (`31`), gate logic |
| `17` | Security Governance | Security across lifecycle, threat modeling | Trust boundaries of runtime |
| `18` | Quality Gates | Gate catalogue, criteria, severities, waivers, gate governance | Outcome vocabularies and composition (`31`), evidence definitions |
| `19` | Claude Integration | Engine invocation, context, tools, sessions, output | UI |
| `20` | VS Code Integration | Surfaces, states, information contracts | Runtime storage |
| `21` | Local Runtime Model | Storage, concurrency, isolation, backup, reproducibility | Engine protocol |
| `22` | Failure & Recovery | Failure taxonomy, detection, recovery | Incident process |
| `23` | Operations & Release | Release, handover, ops, incidents | Failure taxonomy |
| `24` | Acceptance Criteria | DoD at every level; Serva 1.0 readiness | Everything else |
| `25` | Open Questions & Risks | Unresolved decisions, risk register | Answers |
| `26` | Glossary & Identifiers | Terms, ID schemes, enumerations | Catalogues (`30`), outcome vocabularies (`31`) |
| `27` | Serva Self-Requirements | Requirements/constraints for Serva's own build | Stack choice |
| `28` | Human Authority & Trust Boundaries | Trust points, approval boundaries, permissions | Policy text |
| `29` | Document Control | Spec versioning, amendment, conformance | — |
| `30` | Canonical Catalogues | **Membership and cardinality of every catalogue** | Item content |
| `31` | Result & Verdict Taxonomy | All outcome vocabularies, the validity model, the gate-composition algorithm, and the state mappings | Gate criteria content |
| `32` | Agent Contract Catalog | Every individual agent contract | Department contracts |
| `33` | Platform & Provider Constraints | Isolation substrate, capability boundaries, provider assumptions, qualification requirements | Technology choice |

**Counts are not stated in this document.** Every catalogue's membership and cardinality lives in `30` (`CAT-2`). R1 stated agent and stage counts here that disagreed with the documents that contained them; the fix is structural, not arithmetic.

**Anti-duplication rule (`SC-POL-025`):** a concept has exactly one authoritative document. Other documents reference it by ID. Any duplicated normative text is a defect in this document set.

---

## 16. Definition of "Serva Code 1.0 Ready"

Serva Code 1.0 is **Ready** when all of the following hold. Full criteria with evidence requirements are in `24_ACCEPTANCE_CRITERIA.md`; this is the executive form.

### R1 — Governance is real
Every policy in `01` is either mechanically enforced, gate-enforced, or explicitly marked as advisory with a documented reason. No policy exists only as prose.

### R2 — The Orchestrator can classify and route
Given any request class in `26` §2.7 — the thirteen lifecycle classes `RC-01`…`RC-13` plus the two meta-classes `RC-90` and `RC-91`, fifteen in total — Serva Code selects a lifecycle profile, department set, agent set, ordering, parallelism plan and gate set, and can explain the choice from stored state. The meta-classes produce no lifecycle work by design.

### R3 — Truth survives everything
Project state survives: session end, process kill, machine restart, engine failure mid-run, and external file modification. State is recoverable and, where corrupted, detectably corrupted rather than silently wrong.

### R4 — PASS is falsifiable
Every gate evaluation resolves to a `GateVerdict` — `PASS`, `PASS_WITH_QUALIFICATION`, `FAIL`, `NOT_VERIFIED`, `BLOCKED` or `ESCALATED` (`31` V3) — composed deterministically from per-criterion `CriterionEvaluation` records with bound evidence (`31` §4.1). `PASS` on any criterion that admits deterministic evidence cannot be produced from AI assertion alone.

### R5 — Executor never accepts its own work
For every artifact class, implementation, review and acceptance are performed by distinct roles in distinct runs, and the system refuses to record acceptance otherwise.

### R6 — Traceability closes
For any requirement, the chain `Requirement → Feature → Task → Implementation → Test → Evidence → Verification` can be walked in both directions, and orphans (either end) are detectable and reported.

### R7 — The system knows what it does not know
`EXPERT REVIEW REQUIRED` and `NOT VERIFIED` are producible, visible, blocking where appropriate, and never auto-resolved by the system itself.

### R8 — Improvements are never lost
Any agent can raise a Proposal; every Proposal reaches a terminal state with a recorded rationale; no major change is implemented without approval at the correct authority level.

### R9 — The product can be operated by its owner
For a delivered client product, Admin Operability Review has been executed for every feature, and operational readiness (logging, health, backup, rollback as scoped) is evidenced.

### R10 — The product has a stated reason to win
A Competitive Position artifact exists, is current, and is referenced by the Acceptance Gate.

### R11 — The owner is never confused about authority
Every action that crosses a human-authority boundary defined in `28` stops and asks. No such boundary is crossable by an agent, by prompt content, or by configuration default.

### R12 — Serva Code can explain itself
For any state, Serva Code can produce: what stage the project is in, what is blocking, who decided what and why, what evidence exists, what is unverified, and what the next step is — from the store alone, without an AI session.

### R13 — The system does not overstate its own enforcement *(added in Audit R2)*
Capability enforcement class is detected and declared. Where it is below `HARD`, the system says so, marks governance `DEGRADED`, and attaches a `DEGRADED_ENFORCEMENT` qualification to every affected verdict. No claim of L1 enforcement is made on a substrate that does not provide it (`33` §3).

### R14 — Catalogues have one source *(added in Audit R2)*
Every catalogue's membership and cardinality comes from `30`. No document states a count it maintains by hand. No enumeration exists in two places with different values.

### R15 — History cannot be rewritten *(added in Audit R2)*
Every `T-TRACE` entity is an immutable event or terminal snapshot; every lifecycle is event-sourced; no record is edited to mark its own supersession; live projections are rebuildable from their logs and are never authoritative.

---

## 17. Conformance Language

Throughout this document set:

- **MUST / MUST NOT** — mandatory; violation is a defect and, at runtime, a blocking condition.
- **SHOULD / SHOULD NOT** — strong default; deviation requires a recorded Decision.
- **MAY** — permitted, no justification required.
- **DERIVED** — an element added during Phase 1 analysis that was not in the original assignment; carries a justification.
- **DEFERRED** — deliberately unresolved in Phase 1; carries an entry in `25`.

---

## 18. Status of this specification

This is the **Phase 1 baseline**. It is a governed artifact under `29_DOCUMENT_CONTROL.md`: it has a version, an amendment procedure, and a conformance obligation for later phases. It is not background reading — later phases are conformant to it or must amend it.

**Phase 1 produced no executable product code.**
