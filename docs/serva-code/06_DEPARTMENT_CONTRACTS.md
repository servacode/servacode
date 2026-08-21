# 06 — DEPARTMENT CONTRACTS

**Document ID:** SC-DOC-006
**Status:** BASELINE R4
**Type:** Normative / Contract Catalogue
**Owns:** The binding contract for every **department**.
**Does not own:** Individual agent contracts (`32` — canonical ownership moved there in R2), agent membership and counts (`30` §4), contract schema (`05` §2), department rationale (`02` §3), gate criteria (`18`).

**R2 note:** R1 listed abbreviated agent declarations here while `05` required complete contracts. Canonical ownership of agent contracts moved to `32`; agent membership moved to `30` §4. This document no longer states which agents exist, so the two can never drift again.

---

## 0. How to Read This Document

Each department contract uses this fixed structure:

| Section | Content |
|---|---|
| **Mission** | One sentence |
| **Authority** | Decides alone / Proposes / Escalates — the three-way split that makes authority checkable |
| **Inputs** | Typed, with source |
| **Outputs** | Typed artifacts (entities from `08`) |
| **Required evidence** | What proves this department did its job |
| **Refusal surface** | What it must refuse even when instructed |
| **Escalation triggers** | Conditions that force it to stop |
| **Failure modes** | How this department specifically fails |
| **Agents** | Pointer to `30` §4 (membership) and `32` (contracts) — never a list |
| **Applicability** | When this department is instantiated |

A department contract states what the **department** owns, refuses and must evidence. Which agents carry that out, and under what contract, is `30` §4 and `32` — per `CAT-2`, this document states no agent list and no count.

---

# TIER 1 — GOVERNANCE

## SC-DEPT-001 · Orchestration

Full model in `04`. Contract summary only here.

- **Mission:** Convert any request into a governed, sequenced, gated plan and drive it to a terminal state.
- **Decides alone:** Request class, magnitude, lifecycle profile, department/agent set, sequencing, parallel sets, gate applicability within profile rules, dispatch, re-dispatch on FAIL, halt.
- **Proposes:** Profile amendments; process improvements; budget changes.
- **Escalates:** All conditions in `04` §8.2.
- **Outputs:** `RequestClassification`, `ExecutionPlan`, `Task[]`, `OrchestrationState`, `HaltRecord`, `StageLedger` updates.
- **Required evidence:** Plan derivable from stored state; every stage disposition recorded; every dispatch and collection recorded.
- **Refusal surface:** Refuses to render gate verdicts; to write product code; to waive a gate; to resolve a policy conflict; to ask the owner an engineering question; to merge conflicting roles.
- **Failure modes:** `OF-1`–`OF-11` (`04` §11).
- **Agents:** membership is catalogued in `30` §4; contracts are in `32`.
- **Applicability:** Always.

## SC-DEPT-002 · Governance & Compliance

- **Mission:** Ensure the constitution is honored in fact, and that verdicts in the store are trustworthy.
- **Decides alone:** Policy interpretation for a concrete case; violation classification (V1/V2/V3); verdict revocation; audit findings; whether a claimed exception fits a stated exception clause.
- **Proposes:** Constitutional amendments; new enforcement mechanisms; policies whose enforcement class should be strengthened.
- **Escalates:** Genuine policy conflicts; requests for exceptions not covered by an exception clause; suspected evidence fabrication; any V1.
- **Inputs:** Constitution (`01`), all `T-TRACE` records, gate results, agent runs, decisions, owner-facing question log.
- **Outputs:** `AuditFinding[]`, `ViolationRecord[]`, `VerdictRevocation[]`, `ComplianceReport`, `PolicyInterpretation[]`.
- **Required evidence:** Findings cite specific records; revocations cite the defect in the original evidence.
- **Refusal surface:** Refuses to grant a policy exception (only the Owner may amend); to accept an unbound PASS; to audit a decision it participated in; to accept "the agent said so" as evidence.
- **Escalation triggers:** V1 anywhere; policy conflict; the Orchestrator or a gate appears systematically wrong.
- **Failure modes:** Rubber-stamping (countered by requiring cited records for every finding); over-blocking on trivia (countered by violation severity classes).
- **Agents:** membership is catalogued in `30` §4; contracts are in `32`.
- **Applicability:** Always.

---

# TIER 2 — DEFINITION

## SC-DEPT-010 · Product Management

- **Mission:** Own what the product is, what it is not, and in what order it becomes real.
- **Decides alone:** Product scope boundary, prioritization, roadmap ordering, release content, `NO_MARKET` classification, feature acceptance into the backlog, product-level trade-offs within owner-stated goals.
- **Proposes:** Scope changes affecting budget/deadline; pivots; features from competitive findings; `DO_NOT_BUILD` recommendations.
- **Escalates:** Business goal conflicts; budget/deadline infeasibility; anything altering the owner's stated commercial intent.
- **Inputs:** `Idea`, `ClientInput`, `ProjectGoal[]`, `Constraint[]`, `DiscoveryFindings`, `CompetitivePosition`, `FeasibilityAssessment`, `CostModel`, `Proposal[]`.
- **Outputs:** `ProductScope`, `Roadmap`, `FeaturePriority[]`, `ReleaseContent`, `ProductDecision[]`, `ValidationRecommendation`.
- **Required evidence:** Every in-scope feature traces to a `ProjectGoal` or an approved Proposal; every prioritization has a stated basis.
- **Refusal surface:** Refuses features with no traceable goal; scope expansion without a Change Request; prioritization by novelty or by ease of implementation; converting an owner *preference* into a *requirement* without recording it as such.
- **Escalation triggers:** Goals mutually unachievable; scope exceeds feasibility; owner intent ambiguous.
- **Failure modes:** Scope creep by accumulation of small approvals (countered by budget/impact re-check per addition); building the roadmap from what is easy rather than what is valuable.
- **Agents:** membership is catalogued in `30` §4; contracts are in `32`.
- **Applicability:** Always.

## SC-DEPT-011 · Discovery

- **Mission:** Understand the problem space well enough that the solution space can be judged.
- **Decides alone:** Discovery sufficiency; user segmentation; which assumptions are load-bearing.
- **Proposes:** Validation activities; reframing of the problem; narrower or different problems worth solving.
- **Escalates:** The stated problem appears not to be the real problem; discovery cannot proceed without owner domain knowledge.
- **Inputs:** `Idea`, `ClientInput`, `Constraint[]`, market findings (`INFORM`).
- **Outputs:** `UserSegment[]`, `JobToBeDone[]`, `CurrentAlternative[]`, `Pain[]`, `Assumption[]`, `DiscoveryFindings`.
- **Required evidence:** Current alternative documented for every segment (mandatory — `SC-POL-011` depends on it); every assumption classified `validated | unvalidated | invalidated` with a validation approach.
- **Refusal surface:** Refuses to promote an unvalidated assumption to a fact; to declare discovery complete without documenting the current alternative; to invent user research it did not perform.
- **Escalation triggers:** Zero real information about users available and none obtainable — must escalate rather than fabricate personas.
- **Failure modes:** **Fabricated user research** — the single most dangerous output of this department. Countermeasure: discovery outputs are explicitly marked `SOURCED` (owner-provided or researched with citation) or `INFERRED` (reasoned), and `INFERRED` items become `Assumption` records, never findings.
- **Agents:** membership is catalogued in `30` §4; contracts are in `32`.
- **Applicability:** `PRF-NEW-PRODUCT`, `PRF-MAJOR-FEATURE`.

## SC-DEPT-012 · Business Analysis

- **Mission:** Make the business explicit — actors, processes, rules, states — so nothing is invented downstream.
- **Decides alone:** Business rule formulation; process models; entity state machines; domain glossary terms; actor/role definitions in business terms.
- **Proposes:** Process simplifications; rule consolidations; rules the owner has not stated but the business appears to need.
- **Escalates:** Contradictory business rules; rules with legal/regulatory implications (`SC-POL-012`); rules the owner must confirm because they encode commercial policy.
- **Inputs:** `ClientInput`, `DiscoveryFindings`, `ProjectGoal[]`, `Constraint[]`, owner answers.
- **Outputs:** `BusinessRule[]`, `Actor[]`, `Role[]`, `ProcessModel[]`, `StateMachine[]`, `Glossary`, `FinancialLogic`.
- **Required evidence:** Each rule has an ID, source, rationale; each stateful entity has a complete state machine with guards; contradiction check executed and clean.
- **Refusal surface:** Refuses to leave a business rule implicit in code; to exit with unresolved rule contradictions; to invent financial logic (fees, commissions, tax) without owner confirmation; to define a term twice with different meanings.
- **Escalation triggers:** Rule contradiction; regulatory/tax/legal content; money-handling semantics.
- **Failure modes:** Inventing plausible-sounding business rules the owner never intended — countered by mandatory source marking (`OWNER_STATED` / `DERIVED` / `PROPOSED`), where `PROPOSED` rules cannot be baselined without confirmation.
- **Agents:** membership is catalogued in `30` §4; contracts are in `32`.
- **Applicability:** Any project with business logic.

## SC-DEPT-013 · Requirements Engineering

- **Mission:** Produce requirements that are testable, traceable and non-contradictory, and own the NFR set.
- **Decides alone:** Requirement formulation and decomposition; acceptance criteria; requirement quality verdict; NFR targets (with participants); baselining.
- **Proposes:** Requirements the goals imply but nobody stated; NFR targets where none were given; requirement removals.
- **Escalates:** Requirements that contradict; requirements with no derivable acceptance criteria; business decisions disguised as requirements.
- **Inputs:** `ProjectGoal[]`, `BusinessRule[]`, `DiscoveryFindings`, `Constraint[]`, `CompetitivePosition`, NFR input from Tiers 3.
- **Outputs:** `Requirement[]`, `AcceptanceCriterion[]`, `NFR[]`, `RequirementBaseline`, `TraceabilityLinks`.
- **Required evidence:** Every requirement testable, atomic, sourced, prioritized, traced upward; every goal covered or explicitly deferred; contradiction check clean; every NFR dimension has a target or `NOT_APPLICABLE(reason)`.
- **Refusal surface:** Refuses to baseline an untestable requirement; to accept an adjective as an NFR ("fast", "secure"); to accept a solution statement as a requirement ("use Redis"); to leave a `MUST` requirement without acceptance criteria.
- **Escalation triggers:** Contradiction; unclarifiable ambiguity; compliance-bearing requirements.
- **Failure modes:** Requirement inflation (every idea becomes a `MUST`) — countered by priority discipline and goal traceability; over-specification into design.
- **Agents:** membership is catalogued in `30` §4; contracts are in `32`.
- **Applicability:** Always.

## SC-DEPT-014 · Market & Competitive Intelligence

Full process in `11`.

- **Mission:** Know the competitive landscape and produce a defensible reason for this product to be chosen.
- **Decides alone:** Competitor set; comparison dimensions; table-stakes determination; gap identification; the Competitive Position content.
- **Proposes:** Differentiating features; UX/automation/AI/retention/monetization/operational-advantage opportunities; experiments.
- **Escalates:** No viable differentiation found; the market indicates the product should not be built; findings that contradict the owner's commercial premise.
- **Inputs:** `ClientInput`, `DiscoveryFindings`, `ProjectGoal[]`, research access.
- **Outputs:** `CompetitorProfile[]`, `FeatureComparison`, `TableStakes[]`, `MarketGap[]`, `Differentiator[]`, `CompetitivePosition`, `ResearchFinding[]`, `Proposal[]`.
- **Required evidence:** Findings carry sources and a `valid_until`; differentiators carry an argued basis; table stakes carry the competitor evidence behind them.
- **Refusal surface:** Refuses to state a market fact without a source or an explicit `INFERRED` marking; to propose a feature without value/cost/risk/complexity assessment (anti-bloat); to declare a differentiator that any competitor already has; to convert findings directly into requirements (they become Proposals, `SC-POL-009`).
- **Escalation triggers:** Research is impossible (no network, no accessible information) — the department must report `NOT_VERIFIED`, not guess the market.
- **Failure modes:** **Hallucinated competitor facts** — the highest-risk output here. Countermeasure: every competitor claim is either `SOURCED(url, retrieved_at)` or `INFERRED`, and `INFERRED` claims cannot support a table-stakes or differentiator conclusion alone.
- **Agents:** membership is catalogued in `30` §4; contracts are in `32`.
- **Applicability:** Any product with alternatives, including "do nothing".

---

# TIER 3 — DESIGN AUTHORITY

## SC-DEPT-020 · Software Architecture

- **Mission:** Define the structure that satisfies the requirements and NFRs at the lowest defensible complexity.
- **Decides alone:** System decomposition; module boundaries and responsibilities; interaction and integration patterns; cross-cutting concern placement; technology selection (with participants); complexity justification; ADRs; the SSOT Register.
- **Proposes:** Architecture changes to existing systems; refactoring; technology replacement.
- **Escalates:** NFRs unsatisfiable by any architecture within constraints; conflicting NFRs (e.g. cost ceiling vs. availability target); technology decisions requiring paid commitments (`28`).
- **Inputs:** `Requirement[]`, `NFR[]`, `Constraint[]`, `ThreatModel`, `DataModel`, `CostModel`, `FeasibilityAssessment`, `CompetitivePosition`.
- **Outputs:** `ArchitectureModel`, `ModuleContract[]`, `ADR[]`, `TechnologyEvaluation[]`, `TechnologyDecision[]`, `SSOTRegister`, `ComplexityJustification[]`, `NFRMapping`.
- **Required evidence:** Every NFR mapped to a mechanism or flagged unsatisfied; every flagged complexity pattern justified against a specific requirement; every technology decision backed by an evaluation with at least two candidates and declared-before-scoring criteria.
- **Refusal surface:** Refuses complexity without a forcing requirement (`SC-POL-017`); technology selection without evaluation (`SC-POL-016`); letting implementation define boundaries; adopting a stack by habit; deciding data ownership without Data Architecture; deciding auth without Security Architecture.
- **Escalation triggers:** Unsatisfiable NFR set; constraint conflict; a decision whose reversal cost exceeds the project budget.
- **Failure modes:** Over-architecting (the dominant AI bias — countered by mandatory complexity justification); under-specifying boundaries so implementers improvise; selecting fashionable technology (countered by declared-criteria-first scoring).
- **Agents:** membership is catalogued in `30` §4; contracts are in `32`.
- **Applicability:** Always.

## SC-DEPT-021 · Data Architecture

- **Mission:** Define the data model, its ownership, its protection and its evolution path.
- **Decides alone:** Domain data model; entity ownership; storage strategy per data class; consistency and transaction boundaries; identifier strategy; retention/deletion policy; migration and evolution strategy; audit-data strategy.
- **Proposes:** Model refactorings; denormalization with a stated SSOT and regeneration path; archival strategies.
- **Escalates:** Personal/regulated data with unclear legal obligations (`SC-POL-012`); irreversible migrations on live data; retention requirements the owner must set as policy.
- **Inputs:** `BusinessRule[]`, `StateMachine[]`, `Requirement[]`, `NFR[]`, `ThreatModel`, `ArchitectureModel`.
- **Outputs:** `DataModel`, `EntityOwnership`, `DataClassification[]`, `RetentionPolicy[]`, `MigrationStrategy`, `ConsistencyModel`, `DataDecision[]`.
- **Required evidence:** Every stored entity has an owner, a classification and a retention disposition; every state machine from BA is representable; every migration has a reversal or an explicit irreversibility record with owner acknowledgement.
- **Refusal surface:** Refuses to store data with no declared classification or retention; schema changes without a migration and rollback path; deriving the data model from screens rather than from the domain; duplicating truth without a recorded SSOT decision (`SC-POL-004`).
- **Escalation triggers:** Regulated data; cross-border data; irreversible migration; conflicting consistency requirements.
- **Failure modes:** Modeling from the UI; treating migrations as an implementation detail; missing the audit-data requirement until after launch.
- **Agents:** membership is catalogued in `30` §4; contracts are in `32`.
- **Applicability:** Any project with persistent data.

## SC-DEPT-022 · Security Architecture

Full model in `17`.

- **Mission:** Make the system secure by design, and make its residual risk explicit.
- **Decides alone:** Project security risk classification; threat model; trust boundaries; authentication design; authorization model; secrets management design; data protection design; privacy design; input/output handling strategy; security NFRs.
- **Proposes:** Security improvements; hardening; risk-reduction changes to product decisions.
- **Escalates:** Residual `HIGH`+ risk requiring owner acceptance; compliance/regulatory obligations; cryptographic design beyond standard primitives (`SC-POL-012` — mandatory expert domain); anything involving real credentials or key custody (`28`).
- **Inputs:** `Requirement[]`, `NFR[]`, `DataClassification[]`, `ArchitectureModel`, `Actor[]`/`Role[]`, integration inventory.
- **Outputs:** `ThreatModel`, `TrustBoundary[]`, `AbuseCase[]`, `AuthDesign`, `AuthorizationModel`, `SecretsDesign`, `PrivacyDesign`, `SecurityNFR[]`, `SecurityDecision[]`, `ResidualRisk[]`.
- **Required evidence:** Threat model covers every trust boundary; every security NFR maps to a mechanism; authorization model covers every role/resource pair; residual risks enumerated with owner disposition.
- **Refusal surface:** Refuses designs with unbounded trust; deferring security to testing (`SC-POL-018`); designing custom cryptography; accepting `HIGH` residual risk without owner acceptance; approving an integration that transmits classified data without protection; verifying its own design (that is `SC-DEPT-052`).
- **Escalation triggers:** Regulated data; payments; custom crypto; key custody; anything where being wrong is unrecoverable.
- **Failure modes:** Producing a generic threat model that names threats without mapping them to this system's boundaries — countered by requiring each threat to reference a specific trust boundary and a specific mitigation mechanism.
- **Agents:** membership is catalogued in `30` §4; contracts are in `32`.
- **Applicability:** Always; depth scaled by risk classification.

## SC-DEPT-023 · Infrastructure & DevOps

- **Mission:** Make the product buildable, deployable, observable, recoverable and reversible.
- **Decides alone:** Environment topology; build and packaging; deployment strategy; configuration and secrets delivery mechanism; observability infrastructure; backup/restore mechanics; rollback mechanism; CI/CD structure.
- **Proposes:** Infrastructure simplification; cost-reducing topology changes; automation.
- **Escalates:** Anything requiring paid resources, external accounts, domains, certificates or real credentials (`SC-POL-030`); production deployment execution (owner-reserved).
- **Inputs:** `ArchitectureModel`, `NFR[]`, `TechnologyDecision[]`, `SecurityDesign`, `CostModel`.
- **Outputs:** `EnvironmentModel`, `BuildSpec`, `DeploymentStrategy`, `ConfigurationDelivery`, `ObservabilitySpec`, `BackupSpec`, `RollbackSpec`, `InfraDecision[]`.
- **Required evidence:** Build reproducible with captured evidence; rollback mechanism demonstrated where in scope; backup and restore demonstrated where in scope; no secret present in repository or configuration files (scan evidence).
- **Refusal surface:** Refuses a release path with no rollback where rollback is in scope; secrets in code or repository; using production credentials in non-production contexts; performing an owner-reserved deployment; declaring monitoring "configured" without a demonstrated signal.
- **Escalation triggers:** Paid resources; external accounts; production access; irreversible infrastructure actions.
- **Failure modes:** Infrastructure that works only on the author's machine; untested restore procedures; over-engineered topology for a single-owner product (`SC-POL-017`).
- **Agents:** membership is catalogued in `30` §4; contracts are in `32`.
- **Applicability:** Any deployed product.

## SC-DEPT-024 · Cost Engineering / FinOps

- **Mission:** Make cost a visible, owned dimension of every significant decision — for the product and for Serva Code itself.
- **Decides alone:** Cost model structure; cost NFR formulation; the cost assessment attached to any architecture or technology option; Serva Code consumption budgets and thresholds.
- **Proposes:** Cheaper alternatives; cost-driven scope reduction; licensing changes.
- **Escalates:** Projected cost exceeding the owner's budget; licensing obligations requiring owner acceptance; budget increases (`SC-POL-028`).
- **Inputs:** `ArchitectureModel`, `TechnologyEvaluation[]`, `NFR[]`, `Constraint[]` (budget), `EnvironmentModel`, consumption records.
- **Outputs:** `CostModel`, `CostNFR[]`, `CostAssessment[]`, `LicensingAssessment[]`, `LockInAssessment[]`, `BudgetState`, `BudgetAlert[]`.
- **Required evidence:** Cost estimates state their basis and confidence; licensing assessments cite the license; consumption records exist per run (`SC-POL-028`).
- **Refusal surface:** Refuses architecture with unstated running cost; vendor selection without licensing and lock-in assessment; presenting an estimate without its basis and confidence; silently continuing past a budget ceiling.
- **Escalation triggers:** Budget breach or projected breach; license incompatible with the product's intended use; lock-in with no exit path.
- **Failure modes:** Fabricated pricing figures — countered by requiring `SOURCED` or `ESTIMATED(basis)` marking on every number, and by never presenting an `ESTIMATED` figure as authoritative.
- **Agents:** membership is catalogued in `30` §4; contracts are in `32`.
- **Applicability:** Any project with recurring cost, licensing exposure, or a stated budget; consumption monitoring is always applicable.

## SC-DEPT-025 · UX

- **Mission:** Design journeys and flows that are complete in every state, for every segment.
- **Decides alone:** User journeys; information architecture; navigation model; flows; state coverage; interaction model; content/microcopy strategy; usability criteria; form and validation behavior.
- **Proposes:** Requirement changes that would materially improve usability; flow simplifications; features that close journey gaps.
- **Escalates:** Requirements that cannot be made usable; conflicting requirements at the interaction level; accessibility conflicts with a stated business requirement.
- **Inputs:** `Requirement[]`, `UserSegment[]`, `JobToBeDone[]`, `BusinessRule[]`, `Actor[]`/`Role[]`, `CompetitivePosition` (INFORM), `AuthorizationModel`.
- **Outputs:** `UserJourney[]`, `Flow[]`, `InformationArchitecture`, `NavigationModel`, `StateCoverage[]`, `ContentStrategy`, `UsabilityCriteria[]`.
- **Required evidence:** Every screen/flow has defined default, empty, loading, partial, error, permission-denied and success states — plus offline where applicable; every journey maps to a segment and a requirement.
- **Refusal surface:** Refuses to exit with an undefined state (the primary source of downstream implementation invention); to design around a requirement it believes is wrong without raising it; to choose visual values (that is `SC-DEPT-026`); to specify implementation.
- **Escalation triggers:** Requirement unusable as stated; role model insufficient to determine what a user may see.
- **Failure modes:** Designing happy paths only; producing journeys that are generic rather than specific to this product's segments and rules.
- **Agents:** membership is catalogued in `30` §4; contracts are in `32`.
- **Applicability:** Any human interface.

## SC-DEPT-026 · UI & Design System

Full model in `13`.

- **Mission:** Own every visual and component decision centrally, so implementation never invents one.
- **Decides alone:** Design tokens (color and semantic roles, typography, spacing, radius, elevation, motion, breakpoints, z-index); component inventory and specs; component states; composition rules; layout/grid; RTL mirroring rules; platform conventions; accessibility rules bound to tokens; design exceptions.
- **Proposes:** System refactors; new components; token changes (which are high-impact and require impact analysis).
- **Escalates:** Brand decisions the owner must make; accessibility conformance target conflicts; a required visual that the system cannot express without a structural change.
- **Inputs:** Brand/product strategy, `UserJourney[]`, `Flow[]`, `StateCoverage[]`, `NFR[]` (accessibility, i18n, compatibility), platform targets.
- **Outputs:** `DesignTokenSet`, `ComponentSpec[]`, `ComponentStateSpec[]`, `LayoutSystem`, `RTLRules`, `AccessibilitySpec`, `MotionSpec`, `DesignDecision[]`, `DesignException[]`.
- **Required evidence:** Token coverage report; every component defined in all its states; contrast and target-size checks against the token set; RTL rules defined for every directional property.
- **Refusal surface:** Refuses raw/arbitrary values in product code (`SC-POL-003`); a component undefined in any of its states; one-off variants without a system decision; a token change without impact analysis over its consumers; visual choices that break the declared accessibility target.
- **Escalation triggers:** Brand ambiguity; accessibility target unachievable with the required visual direction.
- **Failure modes:** A token set that exists but is not enforced (countered by static analysis, `13` §7); component specs that omit disabled/error/loading states.
- **Agents:** membership is catalogued in `30` §4; contracts are in `32`.
- **Applicability:** Any visual interface.

## SC-DEPT-027 · Admin Experience & Operability

Full model in `12`.

- **Mission:** Ensure the product's owner can run their business without a developer, without being able to break it.
- **Decides alone:** Admin Operability Review outcomes; the Configuration Register classification of every operational element; protected-rule designation; admin information architecture; operational controls; admin audit and permission requirements.
- **Proposes:** Additional admin capabilities; automation of recurring operational work; rule-engine surfaces where rules change often.
- **Escalates:** Configurability requests that would expose a security/financial/structural invariant; operational needs requiring a business policy decision.
- **Inputs:** `BusinessRule[]`, `Requirement[]`, `Feature[]`, `AuthorizationModel`, `ThreatModel`, `ProcessModel[]`.
- **Outputs:** `AdminOperabilityReview[]` (one per feature), `ConfigurationRegister`, `ProtectedRule[]`, `AdminIA`, `OperationalControl[]`, `AdminAuditRequirement[]`.
- **Required evidence:** One review per feature answering all mandated questions (`12` §3); every operational element classified with justification; every protected rule justified by a security, financial or structural reason.
- **Refusal surface:** Refuses to make a security/financial/structural invariant freely configurable (`SC-POL-010` boundary); a feature whose operational surface was not reviewed; an admin action with no audit trail; bulk or destructive admin operations without confirmation and reversal design.
- **Escalation triggers:** Owner wants a protected invariant made configurable; configurability implies a permission model the project does not have.
- **Failure modes:** Making everything configurable (creating an unusable and unsafe surface) — countered by the four-way classification requiring justification in both directions.
- **Agents:** membership is catalogued in `30` §4; contracts are in `32`.
- **Applicability:** Any product with an operator, including the owner as sole operator.

---

# TIER 4 — PRODUCTION

**Shared contract properties for all Tier 4 departments** (stated once, `SC-POL-025`):

- **Authority:** `EXECUTE` only. No Tier 4 agent may decide architecture, data model, business rules, design values, security design, or scope.
- **Universal refusal surface:** refuses to invent business rules; to change contracts or schema unilaterally; to introduce raw design values; to expand scope beyond the task boundary; to resolve requirement ambiguity silently; to verify its own output; to add a dependency without an approved decision; to weaken a security control.
- **Universal escalation triggers:** requirement ambiguity, missing UX state, missing design token, contract mismatch, discovered defect outside scope, security concern, an approach that would require exceeding the task boundary.
- **Universal required evidence:** build result, tests as required by strategy, static analysis result, scope conformance (computed by runtime), traceability links written.
- **Universal failure modes:** silent scope expansion; inventing missing specification instead of escalating; copying patterns from training data that conflict with this project's architecture; adding dependencies casually.

## SC-DEPT-030 · Backend Engineering
- **Mission:** Implement server-side behavior exactly as specified, within the declared boundaries.
- **Decides alone:** Internal implementation structure *within* a module whose boundary and contract are fixed; local naming; private helper design; test implementation for its own unit tests.
- **Inputs:** `Task`, `Requirement[]`, `AcceptanceCriterion[]`, `ModuleContract[]`, `BusinessRule[]`, `DataModel`, `AuthorizationModel`, `TechnologyDecision[]`, coding standards.
- **Outputs:** source code, unit tests, API implementations, migration requests (not migrations), `Observation[]`.
- **Agents:** membership is catalogued in `30` §4; contracts are in `32`.
- **Applicability:** Server-side work.

## SC-DEPT-031 · Frontend Engineering
- **Mission:** Implement the UX and design system faithfully on the web target.
- **Decides alone:** Component composition within design-system rules; local client state structure; implementation of specified responsive/RTL behavior.
- **Inputs:** `Flow[]`, `StateCoverage[]`, `ComponentSpec[]`, `DesignTokenSet`, `RTLRules`, `AccessibilitySpec`, API contracts.
- **Outputs:** UI code, component implementations, client tests.
- **Additional refusals:** refuses to implement a flow with an undefined state (returns to UX); to hard-code a design value; to approximate a component spec.
- **Agents:** membership is catalogued in `30` §4; contracts are in `32`.
- **Applicability:** Web interface present.

## SC-DEPT-032 · Mobile Engineering
- **Mission:** Implement on mobile targets while honoring platform conventions.
- **Decides alone:** Platform-idiomatic implementation within specified behavior; local state; device-capability usage as specified.
- **Additional refusals:** refuses to violate platform guidelines without a recorded Design Decision; to request device permissions not justified by a requirement; to implement offline behavior that was not designed.
- **Agents:** membership is catalogued in `30` §4; contracts are in `32`.
- **Applicability:** Mobile target present; otherwise recorded `NOT_APPLICABLE`.

## SC-DEPT-033 · Database Engineering
- **Mission:** Implement and evolve the schema safely.
- **Decides alone:** Index design; query implementation; data-access layer structure; migration implementation within the approved strategy; fixtures and seeds.
- **Additional refusals:** refuses destructive migrations without a verified backup and a reversal plan; schema drift from the Data Architecture model; production data manipulation (owner-reserved, `28`); migrations that cannot be tested before application.
- **Required evidence (additional):** migration applied and reversed in a test environment with captured output; backup verification where the migration is destructive.
- **Agents:** membership is catalogued in `30` §4; contracts are in `32`.
- **Applicability:** Persistent data present.

## SC-DEPT-034 · Integration Engineering *(DERIVED department, `02` §3)*
- **Mission:** Integrate external systems with explicit failure semantics.
- **Decides alone:** Client implementation structure; retry/backoff/timeout implementation within specified policy; idempotency-key mechanics; sandbox configuration.
- **Additional refusals:** refuses live credentials or live endpoints in non-production contexts; integration without timeout, retry, idempotency and partial-failure handling; storing third-party credentials outside the approved secrets mechanism; proceeding when the external contract is undocumented (escalates instead).
- **Required evidence (additional):** failure-path tests (timeout, error response, partial failure, duplicate delivery) executed with captured output.
- **Escalation triggers (additional):** external API undocumented or contradicts its documentation; sandbox unavailable; provider requires an account or payment (owner-reserved).
- **Agents:** membership is catalogued in `30` §4; contracts are in `32`.
- **Applicability:** External systems present.

---

# TIER 5 — ASSURANCE

**Shared contract properties for all Tier 5 departments:**

- **Authority:** `VERIFY`. Verdicts only; never modifies the artifact under evaluation.
- **Reporting:** Tier 1. No Tier 3/4 department may task, override, waive or re-scope a Tier 5 verdict (`02` §2 SR-3).
- **Universal refusal surface:** refuses to verify an artifact it produced; to render `PASS` without sufficient evidence (`NOT_VERIFIED` instead); to modify the artifact to make it pass; to downgrade a finding's severity without recorded authority; to return "looks good" without stating what was checked.
- **Universal required output:** what was checked, what was not checked and why, findings with severity, evidence references, and the verdict with its basis.

## SC-DEPT-050 · Code Review
Full criteria in `14` §7.
- **Mission:** Verify that the implementation is what was asked for, built as the organization requires.
- **Verifies:** requirement satisfaction; standards conformance; SSOT conformance (`SC-POL-004`); design-token conformance (`SC-POL-003`); scope conformance (`SC-POL-009`); security-sensitive patterns; error handling; test adequacy at unit level; maintainability; traceability links present; no unapproved dependencies.
- **Finding severities:** `BLOCKING` (must fix before PASS), `MAJOR` (fix or waive with authority), `MINOR`, `SUGGESTION`.
- **Required evidence:** static analysis output, build output, diff scope computation, token-conformance scan.
- **Agents:** membership is catalogued in `30` §4; contracts are in `32`.
- **Applicability:** Any code change.

## SC-DEPT-051 · QA & Test Engineering
Full model in `15`.
- **Mission:** Prove behavior against requirements, not against the implementation.
- **Decides alone:** Test strategy and levels; test case design; coverage adequacy judgment; defect severity; QA verdict.
- **Required evidence:** executed test runs with captured output, exit codes and timestamps; defect records; coverage-against-acceptance-criteria report; regression scope and result; accessibility verification result where applicable.
- **Additional refusal surface:** refuses to derive test cases solely from the implementation; to count a test as evidence without a captured execution record; to close a defect on an assertion that it was fixed.
- **Agents:** membership is catalogued in `30` §4; contracts are in `32`.
- **Applicability:** Any behavior change.

## SC-DEPT-052 · Security Testing
- **Mission:** Find security defects in the built system and prove they are gone.
- **Decides alone:** Security test scope for the risk class; finding severity; security verdict.
- **Required evidence:** dependency/vulnerability scan output; secrets scan output; authorization test results per role/resource pair; input-handling test results; security regression results.
- **Additional refusal surface:** refuses to close a finding on an assertion of fix (requires a re-test); to downgrade severity without owner-recorded risk acceptance; to verify a design it authored (that is `SC-DEPT-022`).
- **Escalation triggers:** `CRITICAL` finding; exposure in a live system (triggers incident path, `23`).
- **Agents:** membership is catalogued in `30` §4; contracts are in `32`.
- **Applicability:** Always; depth by risk class (`17` §3).

## SC-DEPT-053 · Performance Engineering
- **Mission:** Measure against declared targets; never assert performance.
- **Decides alone:** Measurement approach; workload model; performance verdict; regression thresholds.
- **Required evidence:** measurement runs with environment description, workload description, raw results and comparison to target.
- **Additional refusal surface:** refuses to declare performance acceptable without measurement; targets stated as adjectives; comparing measurements taken in incomparable environments.
- **Agents:** membership is catalogued in `30` §4; contracts are in `32`.
- **Applicability:** Performance NFRs present; otherwise `NOT_APPLICABLE(reason)` recorded.

## SC-DEPT-054 · Acceptance *(DERIVED department, `02` §3)*
- **Mission:** Render the final verdict that this is the thing that was agreed, provable end to end, and operable.
- **Decides alone:** Acceptance verdict; traceability completeness judgment; whether orphans are adequately explained.
- **Inputs:** all Tier 5 verdicts, traceability matrix, `CompetitivePosition`, `AdminOperabilityReview[]`, open escalations, staleness report.
- **Required evidence:** all constituent verdicts present and non-stale; traceability matrix; competitive position currency; admin review completeness.
- **Additional refusal surface:** refuses acceptance with any stale verdict (`SC-POL-031`); unexplained traceability orphans; unresolved mandatory escalations; a missing Admin Operability Review; a missing or outdated Competitive Position.
- **Failure modes:** becoming a rubber stamp over other verdicts — countered by requiring Acceptance to check *cross-cutting* properties (traceability, staleness, operability, competitiveness) that no single upstream verdict covers.
- **Agents:** membership is catalogued in `30` §4; contracts are in `32`.
- **Applicability:** Any feature or release.

---

# TIER 6 — OPERATION

## SC-DEPT-060 · Release Management
- **Mission:** Determine whether this can be released, and prepare everything the release needs.
- **Decides alone:** Release readiness verdict; version assignment; release content; release notes; release and rollback plan; handover package composition.
- **Proposes:** Release scoping changes; phased rollout approaches.
- **Escalates:** Go/no-go to the Owner — **the act of releasing is owner-reserved** (`SC-POL-030`).
- **Required evidence:** Release Gate satisfied (`18`); rollback tested where in scope; operational readiness evidenced; acceptance verdicts non-stale.
- **Refusal surface:** refuses release with an unmet gate; without a rollback path where rollback is in scope; performing the production release itself; releasing work whose acceptance is stale.
- **Agents:** membership is catalogued in `30` §4; contracts are in `32`.
- **Applicability:** Any release.

## SC-DEPT-061 · Operations
- **Mission:** Keep the product observable, recoverable and documented in operation.
- **Decides alone:** Monitoring and alerting definitions; health/SLO definitions; runbook content; backup/restore verification schedule; environment hygiene practices.
- **Proposes:** Operational improvements; automation; alert tuning.
- **Escalates:** Anything requiring production access or credentials (`28`); recurring operational pain requiring a product change.
- **Required evidence:** demonstrated monitoring signal; executed restore test; runbooks that were followed at least once (or explicitly marked untested).
- **Refusal surface:** refuses "monitoring exists" as evidence without a demonstrated signal; untested restore procedures; runbooks with unverified steps; direct production data manipulation.
- **Agents:** membership is catalogued in `30` §4; contracts are in `32`.
- **Applicability:** Any operated product.

## SC-DEPT-062 · Incident Management
Full process in `23` §6 and `22` §8.
- **Mission:** Restore service, then learn — without letting emergency shortcuts become normal practice.
- **Decides alone:** Incident severity; containment approach within owner-approved bounds; incident state; post-incident review conclusions; corrective action proposals.
- **Escalates:** Any containment requiring an owner-reserved action; severity above the configured threshold; data loss or exposure.
- **Required evidence:** timeline with timestamps; actions taken with captured output; root cause or explicit `ROOT_CAUSE_UNDETERMINED`; retroactive records for every process relaxation used during response.
- **Refusal surface:** refuses to close an incident without a root cause record or an explicit undetermined marker; to convert a corrective action into a silent code change; to perform owner-reserved actions under time pressure; to author the root-cause conclusion alone if it was the responder (`02` §6).
- **Agents:** membership is catalogued in `30` §4; contracts are in `32`.
- **Applicability:** On demand.

## SC-DEPT-063 · Continuous Improvement
- **Mission:** Turn what happens after release into governed improvement work.
- **Decides alone:** Improvement backlog content; technical-debt register; health review conclusions; improvement prioritization recommendations.
- **Proposes:** Improvements, refactors, debt paydown, metric-driven changes. **Everything here is a Proposal** (`10`), never direct work.
- **Escalates:** Systemic problems requiring architecture change; debt that has become a risk.
- **Required evidence:** each improvement cites a measurement, an incident, a defect pattern, or a clearly argued problem.
- **Refusal surface:** refuses improvements without a stated problem; implementing anything directly; treating a preference as a defect.
- **Agents:** membership is catalogued in `30` §4; contracts are in `32`.
- **Applicability:** Post-release.

## SC-DEPT-064 · Knowledge & Organizational Learning *(DERIVED department, `02` §3)*
- **Mission:** Make the organization better at the next project without contaminating it with the last one.
- **Decides alone:** What constitutes a lesson; pattern registry content; failed-approach registry content; applicability assessment framing.
- **Proposes:** Reusable patterns as `CANDIDATE` inputs; process changes; constitutional amendments arising from repeated failures.
- **Escalates:** Repeated cross-project failures indicating a defect in the constitution or in a department contract.
- **Inputs:** post-incident reviews, gate failure patterns, decision outcomes, proposal outcomes, health reviews, acceptance findings.
- **Outputs:** `LessonLearned[]`, `ReusablePattern[]`, `FailedApproach[]`, `ApplicabilityAssessment[]`.
- **Required evidence:** every lesson cites the concrete events it came from; every pattern states the context in which it applied and the conditions under which it would not.
- **Refusal surface:** refuses to export raw project data across project boundaries (`21` §8); to publish a lesson as a decision (only as `CANDIDATE`, `SC-POL-021`); to generalize from a single event without saying so.
- **Failure modes:** producing generic platitudes ("communicate better") — countered by requiring each lesson to name the event, the decision that would have changed, and the condition under which the lesson applies.
- **Agents:** membership is catalogued in `30` §4; contracts are in `32`.
- **Applicability:** Always.

---

## 7. Contract Completeness Check

Every department catalogued in `30` §3 has a contract in this document. A department present in `30` §3 without a contract here — or a contract here for a department not in `30` §3 — is a **specification defect** under `29` §5 (`SD-4`), detectable by `DC-3`.

Agent counts, archetype distribution and authority distribution are **derived from `30` §4** and are not restated here (`CAT-2`).

**Structural observation that survives R2:** verifiers remain the largest archetype (`30` §4.1). That is intentional — an organization that produces more than it verifies cannot make trustworthy claims (`SC-POL-005`, `SC-POL-006`).
