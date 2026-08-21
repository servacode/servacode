# 09 — DECISION GOVERNANCE

**Document ID:** SC-DOC-009
**Status:** BASELINE R4
**Type:** Normative / Process
**Owns:** Authority matrix, decision classification, decision records, change requests, impact analysis, research depth, approval and waiver mechanics.
**Does not own:** Proposal schema (`10`), gate mechanics (`18`), owner-reserved actions (`28`).

---

## 1. What Counts as a Decision

A **Decision** is any commitment that constrains future work and would be expensive or confusing to reverse silently.

Three tests — if any is true, it is a Decision requiring a record:

| Test | Question |
|---|---|
| **Constraint** | Does this bind future work? |
| **Alternatives** | Was there a real alternative that a competent engineer might have chosen? |
| **Reversal** | Would reversing this later cost materially more than making it differently now? |

If none is true, it is `TRIVIAL` and needs no record (`SC-POL-002` exception). **Classify upward when unsure** — an agent that is uncertain whether something is a Decision MUST treat it as one.

---

## 2. Authority Matrix

Authority is the pair `(who may decide, at what magnitude)`. It is enforced by the store: a Decision record whose `authority` does not match the required level for its class/magnitude is invalid.

| Decision class | M0–M1 | M2 | M3 | M4 |
|---|---|---|---|---|
| **Product scope / priority** | PM | PM | PM + owner informed | **Owner** |
| **Requirement content** | RE | RE | RE + PM | RE + PM + owner informed |
| **Business rule** | BA | BA | BA + owner confirm | **Owner** |
| **Architecture** | Arch | Arch | Arch + review | Arch + review + owner informed |
| **Technology selection** | Arch | Arch | Arch + FinOps + Sec | Arch + FinOps + Sec + **owner** (if cost/lock-in) |
| **Data model / migration** | DataArch | DataArch | DataArch + Sec | DataArch + Sec + **owner** (if irreversible on real data) |
| **Security design** | SecArch | SecArch | SecArch | SecArch + **owner** (residual HIGH risk) |
| **Design tokens / system** | DS | DS | DS + impact analysis | DS + **owner** (brand) |
| **UX flows** | UX | UX | UX + PM | UX + PM |
| **Configuration classification** | AdminX | AdminX | AdminX + Sec | AdminX + Sec + **owner** (protected → configurable) |
| **Infrastructure** | Infra | Infra | Infra + FinOps | Infra + **owner** (cost/accounts) |
| **Test strategy** | QA | QA | QA | QA + Acceptance |
| **Risk acceptance** | — | dept owner | Governance | **Owner** |
| **Policy waiver** | — | — | — | **Owner only** |
| **Constitutional amendment** | — | — | — | **Owner only** |
| **Process / profile / workflow** | Orch | Orch | Orch + Governance | Orch + Governance + **owner** (if removing rigor) |
| **Owner-reserved actions (`28` §3)** | **Owner** | **Owner** | **Owner** | **Owner** |

### 2.1 Authority rules

- **AU-1** No agent may decide above its contract's magnitude ceiling (`05` §2.1).
- **AU-2** No department may decide outside its authority column, even at M0.
- **AU-3** Owner approval cannot be delegated to an agent by configuration or by instruction (`SC-POL-030`).
- **AU-4** "Owner informed" is not approval; it is a notification obligation that does not block.
- **AU-5** Where two departments appear on a cell, both must record concurrence. Disagreement escalates; it is not resolved by the first mover.
- **AU-6** Assurance verdicts (Tier 5) are not decisions and are not subject to this matrix — they cannot be overridden by any authority except the owner recording an explicit risk acceptance, which is itself a Decision.

---

## 3. Decision Classification

| Class | Criteria | Record required | Alternatives required | Impact analysis | Research depth |
|---|---|---|---|---|---|
| `TRIVIAL` | Local, reversible, no constraint on others | No | No | No | None |
| `MINOR` | Bounded, reversible, affects one module | Lightweight | 1 alternative noted | No | Minimal |
| `SIGNIFICANT` | Constrains other work, reversible with effort | Full | ≥2 | Yes if changing existing truth | Proportional |
| `MAJOR` | Cross-cutting, costly to reverse | Full | ≥2 with scoring | **Yes** | Substantial |
| `STRUCTURAL` | Architecture/data/technology; near-irreversible | Full + ADR | ≥3 where they exist | **Yes** | Deep |
| `CONSTITUTIONAL` | Changes Serva's own governance | Full + amendment procedure | ≥2 including "no change" | **Yes** | Deep |

Classification derives from magnitude (`04` §3.3) plus reversibility plus blast radius. It is recorded, and an agent that classifies downward and is later found wrong triggers a Governance finding.

---

## 4. Decision Record

```
Decision {
  id                  : SC-DEC-### | SC-ADR-### (architecture/technology)
  class               : TRIVIAL..CONSTITUTIONAL
  domain              : PRODUCT | REQUIREMENT | BUSINESS_RULE | ARCHITECTURE |
                        TECHNOLOGY | DATA | SECURITY | DESIGN | UX | ADMIN |
                        INFRASTRUCTURE | TEST | PROCESS | RISK
  title               : string
  status              : PROPOSED | ACCEPTED | SUPERSEDED | DEPRECATED | REVERSED

  context             : the problem and the forces acting on it
  drivers             : requirement/NFR/constraint refs   # MUST be non-empty
  options             : Option[] { name, description, pros, cons, cost, risk, score? }
  chosen              : option ref
  rationale           : why this option, in terms of the drivers
  rejected_reasons    : per rejected option — MUST be specific, not "less suitable"
  consequences        : what this now forces or forbids
  risks               : Risk refs created by this decision
  assumptions         : Assumption refs this rests on
  reversal_cost       : LOW | MEDIUM | HIGH | IRREVERSIBLE
  reevaluation_trigger: condition(s) under which this must be revisited   # MANDATORY
  research_refs       : ResearchFinding refs
  prior_art_refs      : ReusablePattern refs + ApplicabilityAssessment    # SC-POL-021
  authority           : deciding role(s)
  approvals           : Approval[]
  decided_at          : timestamp
  affects             : artifact/entity refs
  supersedes          : Decision ref
}
```

### 4.1 Mandatory-field rationale

| Field | Why mandatory |
|---|---|
| `drivers` | A decision with no driver is a preference. Empty `drivers` is a rejected record. |
| `rejected_reasons` | Prevents theatrical alternatives listed only to satisfy the schema. Must reference a driver. |
| `reevaluation_trigger` | `SC-POL-015`. Without it, correct decisions silently become defects. |
| `reversal_cost` | Determines research depth (§7) and approval level. |
| `prior_art_refs` + applicability | `SC-POL-021` — prior art may inform, never conclude. |

### 4.2 Anti-theater checks

Governance (`SC-DEPT-002`) audits decision records for:

- **Straw-man alternatives** — options whose cons are trivially disqualifying and whose selection was never plausible.
- **Post-hoc rationale** — rationale that restates the chosen option rather than deriving it from drivers.
- **Driver-free rationale** — rationale citing general best practice rather than this project's requirements.
- **Copied prior art** — decisions citing prior projects with no applicability assessment.

These are recorded as findings and can invalidate the decision. This exists because an AI system will happily generate three alternatives to satisfy a schema; the schema alone does not create genuine evaluation.

---

## 5. Change Requests

A **Change Request** is how already-baselined truth changes. Anything in `T-CANON` requires a CR to change: requirements, architecture, data model, tokens, contracts, decisions, business rules, configuration classifications.

```
ChangeRequest {
  id, origin (owner | proposal | escalation | incident | defect | external),
  description, target_artifacts[], magnitude, urgency,
  impact_analysis_ref,          # required at M2+
  cost_estimate, schedule_impact,
  approval_required (per §2), approvals[],
  state: DRAFT | ASSESSING | AWAITING_APPROVAL | APPROVED | REJECTED |
         IMPLEMENTING | COMPLETED | WITHDRAWN | SUPERSEDED,
  resulting_tasks[], staleness_effects[]
}
```

Flow: `intake → classify → impact analysis → cost/schedule → approval → re-enter lifecycle at originating stage → affected results derive to `STALE` → execute → verify` (`SC-WF-008`).

**Rules:**
- **CR-1** No `T-CANON` artifact changes without an approved CR (or an owner Decision, which is its own authority).
- **CR-2** A CR at M2+ without an Impact Analysis cannot be approved.
- **CR-3** An approved CR changes artifact versions, so affected downstream results derive to `ValidityState.STALE` (`31` §3.2). Approval does not preserve prior verification, and nothing is mutated to achieve that.
- **CR-4** A rejected CR is retained with its reason. Rejected CRs are project memory.
- **CR-5** Urgency does not remove the requirement for a record; it may reorder when the record is completed (security path, `17` §9), never whether.

---

## 6. Impact Analysis (`SC-POL-013`)

Mandatory for M2 and above. Each dimension is marked `AFFECTED(detail)`, `NOT_AFFECTED(reason)`, or `UNKNOWN`. **`UNKNOWN` blocks approval.**

| # | Dimension | Typical question |
|---|---|---|
| 1 | Requirements | Which requirements change meaning or coverage? |
| 2 | Business rules | Which rules are altered or contradicted? |
| 3 | Modules | Which modules and contracts change? |
| 4 | Database / schema | Migration needed? Reversible? Data loss? |
| 5 | APIs | Contract change? Consumers affected? Versioning? |
| 6 | Frontend | Screens, flows, states affected? |
| 7 | Mobile | Platform-specific impact? Store implications? |
| 8 | Admin | Configuration, controls, protected rules affected? |
| 9 | Security | Trust boundaries, authz, secrets, data exposure? |
| 10 | Permissions | Role/resource matrix changes? |
| 11 | Notifications | Templates, triggers, recipients? |
| 12 | Analytics | Events, metrics, dashboards? |
| 13 | Tests | Which tests break, which are needed? |
| 14 | Documentation | Which documents become wrong? |
| 15 | Operations | Runbooks, monitoring, alerts, backups? |
| 16 | Cost | Build and run cost delta? |
| 17 | Design system | Tokens, components, consumers? |
| 18 | Third-party integrations | External contracts affected? |
| 19 | Existing verdicts | Which become stale? |
| 20 | Competitive position | Does the reason-to-win change? |

Dimensions 16–20 are **DERIVED** additions. Rationale: cost and design-system blast radius are the two most commonly underestimated impacts; stale verdicts must be computed at change time rather than discovered at acceptance; and a change that erodes the differentiator should be visible before it ships.

### 6.1 How `UNKNOWN` is resolved

By dispatching an investigation task to the department that owns that dimension — never by assumption, and never by marking it `NOT_AFFECTED` for convenience. The Orchestrator blocks CR approval until every dimension resolves (`04` §4).

---

## 7. Research Depth (`SC-POL-016` × `SC-POL-017` × `SC-POL-028`)

Research is scaled by reversal cost and blast radius, resolving the tension between "research everything" and "don't burn budget on trivia".

| Reversal cost | Blast radius | Depth | Requirements |
|---|---|---|---|
| LOW | Local | `NONE` | Decide and record briefly |
| LOW | Wide | `LIGHT` | Name alternatives, brief comparison |
| MEDIUM | Local | `LIGHT` | 2 alternatives, key criteria |
| MEDIUM | Wide | `STANDARD` | 2–3 alternatives, declared criteria, sources, cost |
| HIGH | Any | `DEEP` | 3 alternatives where they exist, declared criteria, sourced findings, cost, licensing, lock-in, longevity, exit path |
| IRREVERSIBLE | Any | `DEEP` + owner informed | As above + explicit irreversibility acknowledgement |

### 7.1 Research procedure (all depths above `NONE`)

1. Frame the question precisely.
2. **Declare evaluation criteria before gathering** — this ordering prevents criteria being fitted to a preferred answer, which is the dominant failure of AI-assisted technology selection.
3. Identify candidates.
4. Gather findings with sources; mark each `SOURCED(citation, retrieved_at)` or `INFERRED`.
5. Assess source quality and recency; set `valid_until`.
6. Score against the declared criteria.
7. Assess: maintenance, ecosystem, support, performance (where meaningful), deployment, cost, licensing, lock-in, long-term viability.
8. Produce a recommendation with the losing options' specific disqualifiers.
9. The deciding department (not the researcher) records the Decision.

**Rule:** the agent that researched MUST NOT be the sole agent that decides at `DEEP` depth. Research and decision are separated for the same reason execution and verification are (`SC-POL-006`).

### 7.2 Research honesty rules

- A finding that could not be obtained is recorded as `NOT_FOUND`, never inferred.
- If network research is unavailable, the decision proceeds with `RESEARCH_UNAVAILABLE` recorded, its confidence lowered, and a `reevaluation_trigger` set to "when research becomes possible". It does **not** proceed as if research had been done.
- Findings expire (`08` §6.3). A `DEEP` decision resting on expired research is flagged at the next gate that consumes it.

---

## 8. Approvals

```
Approval { decision_or_cr_ref, authority, actor, verdict: APPROVED|REJECTED|CONDITIONAL(conditions[]),
           rationale, at, conditions_satisfied_ref }
```

- **AP-1** An approval is bound to a specific version of what it approves. Changing the content invalidates the approval.
- **AP-2** `CONDITIONAL` approvals require the conditions to be recorded as tasks or gate criteria; they do not authorize proceeding.
- **AP-3** The proposer may not be the sole approver (`02` §6).
- **AP-4** Owner approvals are captured through the owner interface (`20`), never inferred from silence, and never inferred from an owner message that an agent interpreted as consent. Ambiguous consent is not consent.
- **AP-5** Approvals expire if unacted for a configured period, returning the item to `AWAITING_APPROVAL`. Rationale: an approval given three months ago against a since-changed context is not informed consent.

---

## 9. Waivers

A waiver permits proceeding despite an unmet criterion. It is not an exception to a policy — only the owner may amend policy — it is a recorded, scoped, expiring acceptance of a specific unmet criterion.

```
PolicyWaiver { id, target (gate criterion | finding | standard), scope (specific artifact/feature),
               justification, risk_accepted, authority (per §2), expiry, remediation_plan,
               state: ACTIVE | EXPIRED | REMEDIATED | REVOKED }
```

- **W-1** Waivers are always scoped and always expire. An indefinite waiver is not permitted.
- **W-2** The following can never be waived: evidence fabrication findings, `SC-POL-030` boundaries, `SC-POL-006` separation, `T-TRACE` immutability, `CRITICAL` security findings in a live system.
- **W-3** Active waivers are visible at every gate they affect and are listed in the release package.
- **W-4** An expired waiver re-blocks its gate automatically.
- **W-5** Waiver count and age are health metrics. A growing waiver register is a governance failure signal, reported by `SC-DEPT-002`.

---

## 10. Decision Lifecycle

```
 PROPOSED ──approved──► ACCEPTED ──trigger fires──► UNDER_REEVALUATION
                            │                              │
                            │                              ├──confirm──► ACCEPTED (new version)
                            │                              └──change──► SUPERSEDED ──► new Decision
                            ├──found wrong──► REVERSED (with reversal record + impact)
                            └──context gone──► DEPRECATED
```

- A `SUPERSEDED` decision is retained and remains readable; superseding does not erase why the original was made.
- `REVERSED` requires a record of what the reversal cost and what was learned — this feeds `SC-DEPT-064` (`SC-POL-021`).
- **Re-evaluation triggers are actively monitored.** When a trigger condition becomes true (a dependency deprecated, scale exceeded, cost threshold crossed, a date reached), the Orchestrator raises the decision for re-evaluation. A trigger that is recorded but never checked is decoration; the store must be queryable for fired triggers (`08` Q4).

---

## 11. Decision Quality Metrics

Tracked by `SC-DEPT-064` to improve the organization over time:

| Metric | Signal |
|---|---|
| Decisions reversed within N months | Classification or research depth too shallow |
| Decisions with no re-evaluation trigger fired at the right time | Trigger conditions poorly specified |
| Waivers per release | Erosion of standards |
| `UNKNOWN` rate in impact analyses | Insufficient system knowledge |
| Decisions later found to rest on invalidated assumptions | Assumption tracking failure |
| Rejected-reason quality findings from Governance | Decision theater |

These feed `LessonLearned`, not blame. The purpose is to tune classification thresholds and research depth, which are the two levers that determine whether governance is proportionate.
