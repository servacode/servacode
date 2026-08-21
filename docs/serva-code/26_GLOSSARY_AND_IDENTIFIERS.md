# 26 — GLOSSARY AND IDENTIFIERS

**Document ID:** SC-DOC-026
**Status:** BASELINE R4
**Type:** Normative / Reference
**Derived:** YES — added in Phase 1.
**Owns:** Identifier schemes, canonical enumerations, term definitions.

**Why this document exists:** `SC-POL-025` requires one authoritative location per concept. Identifier formats, verdict values, state names and severity scales are referenced by nearly every other document. Without a single authoritative list, they drift — and drifted enumerations are exactly the kind of defect that makes a specification unimplementable. This is the specification's own glossary discipline, mirroring what `SC-DEPT-012` requires of client projects.

---

## 1. Identifier Schemes

All identifiers are **permanent and never reused**, including after deletion or supersession.

| Prefix | Entity | Format | Example |
|---|---|---|---|
| `SC-DOC-` | Specification document | 3 digits | `SC-DOC-016` |
| `SC-POL-` | Constitutional policy | 3 digits | `SC-POL-005` |
| `SC-DEPT-` | Department | 3 digits, tier-grouped | `SC-DEPT-022` |
| `SC-AGENT-` | Agent contract | 3 digits, department-grouped | `SC-AGENT-090` |
| `SC-STAGE-` | Lifecycle stage | 3 digits, phase-grouped | `SC-STAGE-040` |
| `SC-GATE-` | Quality gate | Uppercase name | `SC-GATE-ACCEPTANCE` |
| `SC-WF-` | Workflow definition | 3 digits | `SC-WF-005` |
| `SC-WFR-` | Workflow run | Sequence | `SC-WFR-00142` |
| `SC-RUN-` | Agent run | UUID | `SC-RUN-<uuid>` |
| `SC-RUNEV-` | Agent run event | Sequence within run | `SC-RUNEV-0007` |
| `SC-RTC-` | Runtime checker / executor | 3 digits | `SC-RTC-012` |
| `QR-` | Capability qualification requirement | 2 digits | `QR-09` |
| `SC-TC-` | Tool call record | Sequence | `SC-TC-009122` |
| `SC-HO-` | Handoff | Sequence | `SC-HO-0231` |
| `SC-WI-` | Work item | Sequence | `SC-WI-0087` |
| `SC-TASK-` | Task | Sequence | `SC-TASK-0451` |
| `SC-REQ-` | Requirement | Sequence | `SC-REQ-0034` |
| `SC-AC-` | Acceptance criterion | Requirement-scoped | `SC-AC-0034-2` |
| `SC-NFR-` | Non-functional requirement | Sequence | `SC-NFR-0012` |
| `SC-BR-` | Business rule | Sequence | `SC-BR-0076` |
| `SC-DEC-` | Decision | Sequence | `SC-DEC-0044` |
| `SC-ADR-` | Architecture/technology decision | Sequence | `SC-ADR-0012` |
| `SC-CR-` | Change request | Sequence | `SC-CR-0019` |
| `SC-PROP-` | Proposal | 4 digits | `SC-PROP-0231` |
| `SC-OBS-` | Observation | Sequence | `SC-OBS-1204` |
| `SC-ESC-` | Escalation | Sequence | `SC-ESC-0055` |
| `SC-RISK-` | Risk | Sequence | `SC-RISK-003` |
| `SC-OQ-` | Open question | Sequence | `SC-OQ-007` |
| `SC-EV-` | Evidence | UUID | `SC-EV-<uuid>` |
| `SC-GR-` | Gate result | Sequence | `SC-GR-0921` |
| `SC-CTX-` | Context bundle | UUID | `SC-CTX-<uuid>` |
| `SC-INC-` | Incident | Sequence | `SC-INC-0004` |
| `SC-REL-` | Release | Version-based | `SC-REL-1.2.0` |
| `SC-LL-` | Lesson learned | Sequence | `SC-LL-0031` |
| `SC-PROJ-` | Project | Sequence | `SC-PROJ-003` |

### 1.1 Cross-reference notation

Within this document set, a bare backtick-quoted number (`` `16` ``) refers to the document of that number. A section reference is `` `16` §3.2 ``. Entity references use the full identifier.

---

## 2. Canonical Enumerations

These are authoritative **except** where a value set is owned by `31` (outcome vocabularies) or is a catalogue of instances owned by `30`. Any other document using a different value for the same concept is a defect (`DC-8`).

| Kind | Owner |
|---|---|
| Outcome vocabularies (criterion results and bases, `ValidityState`, gate verdicts, artifact verifier results, run outcomes, process states) | `31` |
| Catalogues of instances (departments, agents, runtime components, stages, gates, workflows, policies) | `30` |
| All other **governed** vocabularies and every term | this document |
| **Local tool-result vocabularies** | not governed — see §2.0 |

### 2.0 Which vocabularies are governed (R3)

R2 claimed every enumeration not owned by `30`/`31` was owned by `26`, without a rule to decide what counts. Audit R3 found unowned literals. The rule:

> A value set is a **governed vocabulary** — and MUST have exactly one canonical owner — if **any** of the following holds:
>
> | # | Test |
> |---|---|
> | `GV-1` | It is **persisted** in the Knowledge Store as the value of an entity field (`08` §3) |
> | `GV-2` | It **crosses a component boundary** — between agent and runtime, between departments, or into a gate criterion |
> | `GV-3` | A **normative rule branches on it** — a policy, gate criterion, invariant or algorithm |
> | `GV-4` | It is **displayed to the owner** as a state or outcome (`20`) |
>
> A value set failing all four is a **local tool-result vocabulary**: the raw output of one runtime component, consumed only by the component that captured it. It is not governed, MUST NOT be relied on by any normative rule, and MUST be translated into a governed vocabulary before it is persisted or gated on.

**Worked distinction.** A test runner emitting `PASS`/`FAIL`/`SKIP`/`ERROR` per test case is a *local* vocabulary — it is whatever the tool prints. The moment those results are counted into coverage and fed to a gate, the governed vocabulary `TestCaseOutcome` (§2.31) applies, and `SKIP` must map to "not executed" (`15` TE-2) rather than being silently counted as a pass. The translation point is where governance begins.

### 2.1 Outcome vocabularies — owned by `31`

**Corrected in R2.** R1 listed a single eight-value "Verdicts" enumeration here, conflating criterion-level and gate-level values. There is no single verdict enumeration. See `31`:

| Vocabulary | Values | `31` §|
|---|---|---|
| `CriterionResult` | `MET · NOT_MET · INDETERMINATE · NOT_APPLICABLE · WAIVED` + basis `MEASURED · JUDGED · DERIVED` | §2 |
| `ValidityState` (derived) | `VALID · STALE · EXPIRED · REVOKED · DISPUTED · INADMISSIBLE` — `INADMISSIBLE` applies to `Evidence` only | §3 |
| `GateVerdict` | `PASS · PASS_WITH_QUALIFICATION · FAIL · NOT_VERIFIED · BLOCKED · ESCALATED` | §4 |
| `RunOutcome` | `COMPLETED · PARTIAL · BLOCKED · ESCALATED · REFUSED · FAILED · INVALID_OUTPUT · SCOPE_VIOLATION · EVIDENCE_VIOLATION` | §5 |
| `ProcessState` | per subject | §6 |

### 2.2 Evidence classes (`16` §3)
`EXECUTION · OBSERVATION · ARTIFACT · ANALYSIS · JUDGMENT · ATTESTATION`
Strength order: `S1 EXECUTION > S2 OBSERVATION > S3 ARTIFACT > S4 ANALYSIS > S5 JUDGMENT`. `ATTESTATION` sits outside the ordering (human authority).

### 2.3 Validity state
Owned by `31` §3 as `ValidityState`, applied to `Evidence`, `GateResult`, `ArtifactVerifierResult` and `CriterionEvaluation`. **Derived, never stored as a mutable field** (`08` §2.1, `31` VD-1).

*Historical note:* R2 called the `Evidence`-specific case `EvidenceState`. That name is retired — it is not a vocabulary and must not be defined or consumed as one (`31` TX-1b).

### 2.4 Durability tiers (`08` §2)
`T-CANON · T-WORKING · T-TRACE · T-DERIVED`

### 2.5 Magnitude (`04` §3.3)
`M0 TRIVIAL · M1 MINOR · M2 MODERATE · M3 MAJOR · M4 STRUCTURAL`

### 2.6 Decision classes (`09` §3)
`TRIVIAL · MINOR · SIGNIFICANT · MAJOR · STRUCTURAL · CONSTITUTIONAL`

### 2.7 Request classes (`04` §3.1)
`RC-01 NEW_PROJECT · RC-02 SMALL_CHANGE · RC-03 BUG · RC-04 FEATURE · RC-05 MAJOR_FEATURE · RC-06 ARCHITECTURE_CHANGE · RC-07 SECURITY_ISSUE · RC-08 DESIGN_CHANGE · RC-09 RESEARCH · RC-10 RELEASE · RC-11 INCIDENT · RC-12 OPERATIONAL_CHANGE · RC-13 DOCUMENTATION · RC-90 QUERY · RC-91 GOVERNANCE`

### 2.8 Run outcomes (`31` §5; detail in `05` §7)
`COMPLETED · PARTIAL · BLOCKED · ESCALATED · REFUSED · FAILED · INVALID_OUTPUT · SCOPE_VIOLATION · EVIDENCE_VIOLATION`

### 2.9 Authority levels (`05` §2.1)
`DECIDE · RECOMMEND · EXECUTE · VERIFY · ADVISE`

### 2.10 Agent archetypes (`05` §3)
`ANALYST · DEFINER · ARCHITECT · PRODUCER · VERIFIER · GOVERNOR`

### 2.11 Output determinism (`05` §2.2)
`GENERATIVE · JUDGMENT` — declared **per output**, not per agent. `DETERMINISTIC` was removed from the agent model in R2; deterministic work belongs to runtime components (`30` §5).

### 2.12 Stage dispositions (`03` §10)
`EXECUTED · IN_PROGRESS · BLOCKED · SKIPPED · NOT_APPLICABLE · FAILED · ABANDONED`

### 2.13 Dependency types (`03` §1.2)
`HARD · SOFT · INFORM · FEEDBACK`

### 2.14 Proposal classes (`10` §3)
`BLOCKING · ESSENTIAL · RECOMMENDED · OPPORTUNITY · EXPERIMENT · HYGIENE · OPTIONAL`

### 2.15 Proposal states (`10` §6)
`RAISED · TRIAGE · ASSESSED · NEEDS_INVESTIGATION · AWAITING_DECISION · APPROVED · CONDITIONALLY_APPROVED · DEFERRED · SCHEDULED · IN_PROGRESS · IMPLEMENTED · REJECTED · MERGED · DUPLICATE · INVALID · WITHDRAWN · SUPERSEDED · EXPIRED`

### 2.16 Violation severity (`01` §1.3)
`V1 CRITICAL · V2 MAJOR · V3 MINOR`

### 2.17 Finding severity — code review (`14` §7.2)
`BLOCKING · MAJOR · MINOR · SUGGESTION`

### 2.18 Defect severity (`15` §5)
`CRITICAL · MAJOR · MINOR · COSMETIC`

### 2.19 Security finding severity (`17` §10)
`CRITICAL · HIGH · MEDIUM · LOW · INFO`

### 2.20 Incident severity (`23` §6.1)
`SEV1 · SEV2 · SEV3 · SEV4`

### 2.21 Security risk classes (`17` §3)
`R0 MINIMAL · R1 LOW · R2 MODERATE · R3 HIGH · R4 CRITICAL`

### 2.22 Configuration classes (`12` §4)
`OWNER_CONFIGURABLE · ADMIN_CONFIGURABLE · DEVELOPER_ONLY · PROTECTED_INVARIANT`

### 2.23 Source markings (`08` §3)
`OWNER_STATED · DERIVED · RESEARCHED(citation) · INFERRED · SYSTEM`

### 2.24 Competitive claim markings (`11` §3.2)
`SOURCED(url, retrieved_at) · OWNER_PROVIDED · INFERRED(reasoning) · UNKNOWN`

### 2.25 Trust levels (`19` §4.2)
`TRUSTED · UNTRUSTED`

### 2.26 Enforcement classes (`01` §1.2)
`MECHANICAL · GATE · PROCESS · ADVISORY`

### 2.27 Policy tiers (`01` §1.1)
`FOUNDATIONAL · OPERATIONAL · PROTECTIVE`

### 2.28 Failure classes (`22` §2)
`F1 Engine · F2 Agent behavior · F3 Tool · F4 Runtime · F5 Store · F6 Workspace · F7 Process · F8 Governance · F9 Resource · F10 Human`

### 2.29 Requirement priority (`03` §3)
`MUST · SHOULD · COULD · WON'T_NOW`

### 2.29b Feasibility verdict (`03` SC-STAGE-015)
`FEASIBLE · FEASIBLE_WITH_CHANGES · NOT_FEASIBLE`
Governed by `GV-1` (persisted on `FeasibilityAssessment`) and `GV-3` (the Feasibility Gate branches on it).

### 2.29c Qualification-requirement result (`33` §6)
`PASS · FAIL · NOT_VERIFIED`
Governed by `GV-1` and `GV-3`. **Deliberately a three-value set, not a `GateVerdict`**: a qualification requirement is a platform capability test, not a gate over project artifacts, and it has no criteria to qualify or waive. `PASS_WITH_QUALIFICATION`, `BLOCKED` and `ESCALATED` are not meaningful for it. Recorded in `33` §6 and consumed by `24` R13.5.

### 2.29d Test case outcome (`15` §7)
`PASS · FAIL · SKIP · ERROR`
Governed by `GV-1` (persisted on `TestRun.results[]`) and `GV-3` (`15` TE-2 branches on `SKIP`). This is the **governed** form; the raw printed output of a test runner is a local vocabulary that must be translated into it (§2.0).

### 2.29e Capability enforcement class (`33` PC-5)
`HARD · SOFT · NONE`

### 2.29f Contract field resolution (`32` §8)
`LOCAL · INHERITED(block) · DERIVED(rule) · NONE`

### 2.29g Reconciliation divergence class (`21` §10)
`EXPECTED · NEW_UNTRACKED · MODIFIED · DELETED · MOVED`

### 2.29h Handoff completeness and acceptance (`07` §3.2)
Completeness: `COMPLETE · PARTIAL(missing[])`
Acceptance: `ACCEPTED · REJECTED(reason) · ACCEPTED_WITH_CONCERNS(concerns[])`

### 2.29i Reconciliation join outcome (`07` §4.1)
`CONSISTENT · COMPLEMENTARY · CONTRADICTORY`

### 2.29j Product validation recommendation (`03` SC-STAGE-004)
`PROCEED · PROCEED_REDUCED · PIVOT · DO_NOT_BUILD`

### 2.29k Assumption status (`08` §3.1)
`VALIDATED · UNVALIDATED · INVALIDATED`

### 2.29l Differentiator defensibility (`11` §6)
`STRUCTURAL · TEMPORARY · EXECUTION_DEPENDENT`

### 2.29m Configuration effect timing (`12` §4.2)
`IMMEDIATE · NEXT_REQUEST · RESTART · SCHEDULED`

### 2.29n Protection reason (`12` §5)
`SECURITY · FINANCIAL · STRUCTURAL · LEGAL · HISTORICAL_INTEGRITY`

### 2.29o Reversal cost (`09` §4)
`LOW · MEDIUM · HIGH · IRREVERSIBLE`

### 2.29p Research depth (`09` §7)
`NONE · LIGHT · STANDARD · DEEP`

### 2.29q Session policy (`19` §3)
`NEW · CONTINUE(session_ref)` — renamed from `FRESH` in R3 to remove the collision with the retired validity value (`31` VD-5).

### 2.30 Governance state (`20` §2)
`ACTIVE · INACTIVE · DEGRADED · SUSPENDED · UNKNOWN`

---

## 3. Glossary

Terms with a specific meaning in Serva Code. Where a term has a common meaning that differs, the difference is noted.

**Acceptance** — The final cross-cutting verdict that work is what was agreed, provable end to end, and operable. *Distinct from QA*, which verifies behavior against tests.

**Agent** — An **AI-invoked** executable role contract (`05` §2). Not a persona, not a model, not a session, and not a deterministic component — see *Runtime component*.

**Agent Existence Test** — The rule determining whether a role warrants a separate agent (`05` §3.1). Roles differing only by prompt wording are merged.

**Basis** — How a criterion result was determined: `MEASURED`, `JUDGED` or `DERIVED` (`31` §2). Distinct from the result value itself.

**Capability enforcement class** — `HARD`, `SOFT` or `NONE`, depending on the isolation substrate available (`33` §3). Determines whether `SC-POL-026` is satisfied at L1 or L3.

**Agent Run** — The **logical execution** of one agent contract against one task. It is a concept, not a record. It is persisted in three distinct forms (`05` §4):

| Form | Tier | Mutability |
|---|---|---|
| `AgentRunEvent` | `T-TRACE` | Immutable, append-only, digest-chained — **the authority** |
| `AgentRun` (live projection) | `T-WORKING` | Mutable cache; never authoritative (`RI-8`) |
| `AgentRunRecord` | `T-TRACE` | Immutable terminal snapshot |

R2 introduced this three-part model but left the glossary describing a single immutable record.

**Artifact** — Any produced thing: a file, a record, a document. Carries a version and a digest.

**Blast radius** — The set of things a change can affect, computed from the link graph, not estimated.

**Canon (`T-CANON`)** — Baselined truth. Changes only through versioning under a governed decision.

**Claim marking** — The `SOURCED`/`OWNER_PROVIDED`/`INFERRED`/`UNKNOWN` annotation that keeps evidenced facts distinguishable from reasoned ones.

**Context bundle** — The complete, snapshot, trust-annotated input to one agent run. An agent sees nothing else.

**Department** — A bounded responsibility with unique authority, a unique refusal surface, a distinct failure mode, and a reason not to be merged (`02` §1).

**Differentiator** — A reason a user would choose this product that alternatives do not offer. Requires evidence, not assertion.

**Evidence** — A record binding a claim to something the runtime actually captured or a role actually judged (`16`).

**Forgery boundary** — The architectural separation ensuring agents cannot author the record of executions they did not perform (`16` §3.2).

**Gate** — A deterministic evaluation of stored state and evidence against declared criteria, composing per-criterion results into a `GateVerdict` via `31` §4.1. *It evaluates the store; it does not interview the worker.*

**Criterion evaluation** — The immutable record of one criterion's outcome: value, basis, reason, severity, bound evidence (`31` §2.1).

**Existence-testing criterion** — A criterion whose subject *is* the presence of something (`tests_existence: true`, `18` §2.1). For it alone, absent evidence resolves `NOT_MET` rather than `INDETERMINATE`: absence is the proven negative.

**Unverified aspect** — The qualification attached when a `MAJOR` criterion could not be verified. Caps its gate at `PASS_WITH_QUALIFICATION` and travels to release (`31` §4.1.1).

**Artifact verifier result** — A VERIFIER agent's judgement about an artifact, in the V3b vocabulary (`31` §4.3). An input to a gate criterion; never itself a gate verdict.

**Handoff** — Transfer of typed artifacts between workflow steps through the store. Never conversational, never carrying reasoning.

**Judged basis** — A criterion determined by a VERIFIER agent against named criteria, where no stronger evidence class is obtainable. `JUDGED` is a **basis, never a verdict** (`31` TX-2); it caps its gate at `PASS_WITH_QUALIFICATION` and is always visible as such.

**Loop breaker** — The mechanism halting repeated same-root-cause gate failures (`04` §8.3).

**Magnitude** — The size classification of a change, driving approval authority and research depth.

**Observation** — A finding raised by an agent outside its task scope. Must reach terminal triage.

**Orphan** — A traceability break: a requirement with no implementation, or implementation with no requirement.

**Owner** — The single human who owns Serva Code and its projects. Tier 0. Holds all business authority and all reserved actions.

**Owner-reserved action** — An action no agent may perform under any configuration (`28` §3).

**Profile** — A named selection of lifecycle stages, gates and departments for a class of work.

**Proposal** — A recorded improvement that has not been authorized. The mechanism by which `SC-POL-008` and `SC-POL-009` coexist.

**Protected invariant** — A rule that must not be changeable at runtime for security, financial, structural, legal or historical-integrity reasons.

**Qualification** — A caveat attached to a `PASS_WITH_QUALIFICATION` verdict or an artifact verifier result: a judged basis, an active waiver, an unvalidated assumption, an unverified aspect, degraded enforcement, or unavailable research. Propagates downstream (`31` §8).

**Quarantine** — Preservation of untrusted artifacts pending owner disposition. Never deletion, never silent adoption.

**Reconciliation** — Comparing the workspace to the store and classifying divergence (`21` §10).

**Refusal surface** — What a role must decline even when instructed. A department without one is not a department.

**Runtime component** — A deterministic checker or executor (`30` §5). Contains **no model invocation**, is reproducible from its inputs, and is the only producer of `EXECUTION` and `OBSERVATION` evidence. Not an agent.

**Qualification requirement (`QR-##`)** — A future test that must pass before a platform or provider capability may be claimed normatively (`33` §6).

**Re-evaluation trigger** — The condition under which a decision must be revisited. A decision without one is incomplete.

**Scope boundary** — The declared write set of a task. Exceeding it is a mechanically detected violation.

**SSOT** — Single Source of Truth. One authoritative location per truth element.

**Stage ledger** — The per-work-item record accounting for every lifecycle stage's disposition. Makes "we skipped nothing" checkable.

**Validity state** (`ValidityState`) — The derived usability of any validity-bearing record: `VALID`, `STALE`, `EXPIRED`, `REVOKED`, `DISPUTED`, `INADMISSIBLE`. The R2 name `EvidenceState` is retired. **Never stored**; computed per `31` §3.2 from the immutable record, artifact versions, time, revocation/dispute records and the dependency graph.

**Staleness** — The `STALE` validity state: a covered artifact version changed, or a depended-on record is not `VALID`. Propagates without mutating anything.

**Table stakes** — Capabilities whose absence disqualifies the product. Not differentiators.

**Trace (`T-TRACE`)** — Immutable **events and terminal snapshots** of what happened. Never edited, never deleted; corrected only by appending. Carries no mutable lifecycle or validity field (`08` `KI-1b`).

**Waiver** — A scoped, expiring, recorded acceptance of one unmet criterion. Not an override; not a policy exception.

**Work item** — A unit of governed work from request to terminal state.

---

## 4. Notation Conventions

| Convention | Meaning |
|---|---|
| **MUST / MUST NOT** | Mandatory; violation is a defect and a blocking condition |
| **SHOULD / SHOULD NOT** | Strong default; deviation requires a recorded Decision |
| **MAY** | Permitted without justification |
| **DERIVED** | Added during Phase 1 analysis; not in the original assignment; carries a justification |
| **DEFERRED** | Deliberately unresolved; has an entry in `25` |
| `CODE_STYLE` | An enumeration value or identifier |
| *Italic* | Emphasis, or a defined term at first use |

---

## 5. Maintenance

This document is `T-CANON`. Adding an enumeration value, an identifier scheme or a term is a governed change (`29`). A value used anywhere in the document set but absent here is a specification defect, detectable by scanning for enumeration values not listed in §2 — which is the mechanical check that keeps this document honest.
