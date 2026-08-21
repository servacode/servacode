# 10 — PROPOSAL SYSTEM

**Document ID:** SC-DOC-010
**Status:** BASELINE R4
**Type:** Normative / Process
**Owns:** Proposal schema, classification, assessment, triage, states, routing, batching.
**Does not own:** Decision records (`09`), competitive analysis method (`11`), observation emission rules (`05` §10).

---

## 1. Purpose

The Proposal system resolves the tension between two policies that would otherwise contradict each other:

- `SC-POL-008` — never silently discard an improvement.
- `SC-POL-009` — never implement an unapproved major change.

**Resolution:** improvements become *records*, not edits. Capture is mandatory and cheap; implementation is gated and deliberate.

A Proposal is how Serva Code says *"you didn't ask for this, and I'm not doing it, but you should know"* — in a form that can be evaluated, prioritized, deferred or rejected, and that will still be there in six months.

---

## 2. Proposal Schema

```
Proposal {
  id                : SC-PROP-####
  title             : string                     # one line, specific
  source_agent      : SC-AGENT-###
  source_department : SC-DEPT-###
  source_run        : SC-RUN-<uuid>
  origin            : OBSERVATION | RESEARCH | REVIEW | INCIDENT | TESTING |
                      COMPETITIVE | OPERATIONS | OWNER | AUDIT
  raised_at         : timestamp
  project_ref       : SC-PROJ-###

  observation       : what was noticed — factual, with evidence or reasoning
  proposal          : what should be done — specific and actionable
  reason            : why it matters, tied to a goal, requirement, risk or finding

  value : {
    user_value        : { statement, magnitude: NONE|LOW|MEDIUM|HIGH, basis }
    business_value    : { statement, magnitude, basis }
    competitive_value : { statement, magnitude, basis }     # SC-POL-011
    engineering_value : { statement, magnitude, basis }     # maintainability, debt, velocity
    operational_value : { statement, magnitude, basis }     # DERIVED
  }

  cost : {
    development_cost  : { estimate, confidence, basis }
    operational_cost  : { estimate, confidence, basis }
    opportunity_cost  : what this displaces                  # DERIVED
  }

  complexity        : LOW | MEDIUM | HIGH | UNKNOWN
  risk              : { of_doing[], of_not_doing[] }         # both directions, DERIVED
  impact_areas      : dimensions from 09 §6 (indicative, not a full impact analysis)
  reversibility     : LOW | MEDIUM | HIGH | IRREVERSIBLE
  magnitude         : M0..M4                                 # drives approval authority

  classification    : see §3
  priority          : computed, see §5
  recommendation    : DO_NOW | DO_NEXT | SCHEDULE | DEFER | INVESTIGATE | DECLINE
  required_approval : per 09 §2
  depends_on        : SC-PROP-#### []
  conflicts_with    : SC-PROP-#### []
  supersedes        : SC-PROP-#### []
  evidence_refs     : SC-EV-<id>[]

  state             : see §6
  decision_ref      : SC-DEC-### | null
  outcome_reason    : required for every terminal state
  work_item_ref     : SC-WI-### | null                       # if it became work
}
```

### 2.1 Mandatory-field rationale

| Field | Why |
|---|---|
| `observation` separate from `proposal` | Forces the finding to be stated as fact before the suggestion. Without this separation, proposals become opinions with no verifiable basis. |
| `risk.of_not_doing` | Prevents the register from being purely a wish list. A proposal with no cost of inaction is optional by definition. |
| `opportunity_cost` | The scarcest resource is the owner's attention and budget, not implementation capacity. |
| `operational_value` | Directly serves `SC-POL-019`; otherwise operability improvements score as "no user value" and never get prioritized. |
| `outcome_reason` on terminal states | `SC-POL-008` — a proposal that dies silently is the failure this system exists to prevent. |
| `magnitude` | Binds proposals to the same authority matrix as decisions (`09` §2); avoids a parallel governance path. |

---

## 3. Classification

The assignment offered `CRITICAL / RECOMMENDED / OPPORTUNITY / EXPERIMENT / OPTIONAL / REJECTED` and invited a better model. Phase 1 keeps five of those but makes two structural corrections:

**Correction 1 — `REJECTED` is a state, not a class.** A class describes *what a proposal is*; a state describes *where it is*. Mixing them makes it impossible to answer "how many critical proposals were rejected?" `REJECTED` moves to §6.

**Correction 2 — `CRITICAL` is split.** "Critical" was doing two different jobs: *must fix, it is broken or unsafe* versus *must have, or the product fails in the market*. These route to different authorities and different urgency, so they are separate classes.

| Class | Meaning | Typical origin | Default routing |
|---|---|---|---|
| `BLOCKING` | Something is wrong, unsafe, or non-compliant now. Not doing it is a defect. | Security, audit, review, incident | Immediate; may bypass batching |
| `ESSENTIAL` | The product will not succeed against alternatives without this (table stakes, `SC-POL-011`) | Competitive, product | Product Management + owner |
| `RECOMMENDED` | Clear net value, sound justification, proportionate cost | Any | Normal triage |
| `OPPORTUNITY` | Real potential upside, less certain value or larger cost | Competitive, innovation, improvement | Scheduled review |
| `EXPERIMENT` | Value is unknown; the proposal is to *learn*, cheaply and reversibly | Innovation, research | Requires a defined learning objective and stop condition |
| `HYGIENE` | Debt, maintainability, operability, consistency; no direct user value | Review, operations, improvement | Batched |
| `OPTIONAL` | Would be nice; no material consequence either way | Any | Low priority backlog |

`HYGIENE` is **DERIVED**. Without it, technical debt and operability work is forced to masquerade as user value in order to be prioritized, which corrupts the register and eventually loses to features every time. Giving it a class makes it schedulable on its own terms — this is how `SC-POL-019` survives contact with a roadmap.

### 3.1 Classification rules

- **PC-1** Anything a Tier 5 department raises as a `BLOCKING` finding is a `BLOCKING` proposal only if it is out of the current scope; in-scope findings are rework, not proposals.
- **PC-2** `ESSENTIAL` requires competitive evidence, not an assertion that "users expect this".
- **PC-3** `EXPERIMENT` requires: a hypothesis, a success/failure signal, a cost ceiling, and a stop condition. Without these it is an `OPPORTUNITY`.
- **PC-4** The raising agent proposes a class; triage may reclassify, and the reclassification is recorded with its reason.

---

## 4. Assessment

Assessment converts a raised observation into a decidable item. It is performed by the department that owns the affected domain (`02` §5 RACI), **not** by the raising agent — an agent that both raises and assesses its own proposal will systematically over-value it.

Assessment steps:

1. **Deduplicate** against open proposals; merge with links rather than accumulate near-duplicates.
2. **Validate the observation** — is the stated fact true? An observation that turns out to be false closes the proposal as `INVALID`, which is a useful record.
3. **Complete the value/cost/risk fields** with basis and confidence.
4. **Check conflicts** with open proposals, current decisions and baselined requirements.
5. **Classify and set magnitude.**
6. **Recommend** with reasoning.

**Rule:** an assessment MUST state what it does not know. An `UNKNOWN` complexity or a `LOW` confidence estimate is legitimate and often leads to `INVESTIGATE`; a fabricated precise estimate is not.

---

## 5. Prioritization

Priority is computed, then adjustable with a recorded reason. The computation exists so that prioritization is explainable, not so that it is automatic.

```
priority_score =
      w1 * max(value.*.magnitude)
    + w2 * risk.of_not_doing.severity
    + w3 * strategic_alignment(project_goals)
    - w4 * normalized(cost.development + cost.operational)
    - w5 * complexity
    - w6 * risk.of_doing.severity
    + w7 * urgency_decay(raised_at, class)
```

| Term | Purpose |
|---|---|
| `strategic_alignment` | Proposals serving a stated `ProjectGoal` outrank those that do not — prevents drift toward interesting-but-irrelevant work |
| `urgency_decay` | `BLOCKING` and `ESSENTIAL` items gain priority with age; `OPTIONAL` items do not. Prevents important items sinking under newer noise |
| `risk.of_doing` | Penalizes proposals that are valuable but destabilizing |

Class overrides ordering: `BLOCKING` always outranks other classes regardless of score. Weights are project-configurable within owner-set bounds and are recorded — a change of weights is a recorded process decision, because it silently reorders the entire register.

---

## 6. Proposal States

```
 RAISED ──► TRIAGE ──► ASSESSED ──► AWAITING_DECISION ──► APPROVED ──► SCHEDULED ──► IN_PROGRESS ──► IMPLEMENTED
   │           │           │               │                 │                                          │
   │           │           │               │                 └──► CONDITIONALLY_APPROVED ───────────────┘
   │           │           │               ├──► DEFERRED ──(trigger)──► AWAITING_DECISION
   │           │           │               └──► REJECTED
   │           │           └──► NEEDS_INVESTIGATION ──► ASSESSED
   │           ├──► MERGED(into)
   │           ├──► DUPLICATE(of)
   │           └──► INVALID(observation false)
   └──► WITHDRAWN(by source)

 Terminal: IMPLEMENTED · REJECTED · MERGED · DUPLICATE · INVALID · WITHDRAWN · SUPERSEDED · EXPIRED
```

### 6.1 State rules

- **PS-1** Every proposal reaches a terminal state (`SC-POL-033`). None may sit in `RAISED` or `TRIAGE` past the configured threshold without surfacing as `STALLED`.
- **PS-2** Every terminal state requires `outcome_reason`. `REJECTED` without a reason is not a valid record — this is the operative half of `SC-POL-008`.
- **PS-3** `DEFERRED` requires a **re-evaluation trigger** (a date, a milestone, a condition). Deferral without a trigger is rejection wearing a nicer name.
- **PS-4** `EXPIRED` applies to time-sensitive proposals (competitive windows, dependency deprecations) whose moment passed. It is recorded with what was lost — this is a lesson, not an administrative cleanup.
- **PS-5** `APPROVED` does not mean started. Scheduling is Product Management's decision within the roadmap.
- **PS-6** An `IMPLEMENTED` proposal links to the work item and its acceptance verdict. A proposal is not implemented because someone said so.

---

## 7. Triage

Triage runs at step 13 of every Orchestrator cycle (`04` §2) and disposes of every `Observation` from every run.

```
triage(observation):
    if observation is false or unverifiable      -> INVALID(reason)
    if duplicate of open proposal                -> DUPLICATE(of) or MERGED(into)
    if within current task scope and permitted   -> IN_SCOPE_HANDLED (becomes rework, not a proposal)
    if it is a defect in current work            -> Defect record, not a proposal
    if it is a risk                              -> Risk record + proposal if action is proposed
    if it requires an authority decision         -> Proposal
    if it is trivial and free to apply now       -> IN_SCOPE_HANDLED with a record
    else                                         -> Proposal
```

**Anti-flood control.** An autonomous multi-agent organization generates observations continuously; an unmanaged register becomes noise that the owner stops reading — at which point `SC-POL-008` fails in practice while appearing to work. Controls:

| Control | Mechanism |
|---|---|
| Deduplication | Mandatory at triage; similarity-checked against open proposals |
| Batching | `HYGIENE` and `OPTIONAL` proposals are presented in periodic digests, not individually |
| Thresholding | Below a configured value threshold, `OPTIONAL` proposals are auto-batched without owner attention |
| Consolidation | Related proposals merge into a themed parent (e.g. "accessibility gaps in admin") |
| Rate visibility | Proposal creation rate per department is a health metric; a department flooding the register is a contract-tuning signal |
| Expiry | Proposals with no movement and low priority expire with a record rather than accumulate |

**None of these controls may silently discard a proposal.** Batching, consolidation and expiry are all recorded states with reasons — the flood control operates on *presentation*, not on *existence*.

---

## 8. Routing

| Class | Routed to | Owner involvement |
|---|---|---|
| `BLOCKING` | Owning department + Governance | Immediate notification |
| `ESSENTIAL` | Product Management | Required (scope decision) |
| `RECOMMENDED` (M0–M2) | Owning department | Informed |
| `RECOMMENDED` (M3+) | Owning department + Product | Required |
| `OPPORTUNITY` | Product Management | Scheduled review |
| `EXPERIMENT` | Product Management | Required (budget) |
| `HYGIENE` | Owning department, batched | Informed via digest |
| `OPTIONAL` | Backlog, batched | Digest only |

Any proposal whose implementation would cross an owner-reserved boundary (`28` §3) routes to the owner regardless of class.

---

## 9. From Proposal to Work

An approved proposal does not become code. It becomes the appropriate governed artifact:

| Proposal nature | Becomes |
|---|---|
| New capability | `Requirement` + `Feature` (re-enters the lifecycle at REQUIREMENTS) |
| Change to baselined truth | `ChangeRequest` (`09` §5) |
| Design change | `ChangeRequest` targeting design artifacts + `SC-WF-013` if tokens are involved |
| Architecture/technology change | `Decision` (ADR) + `ChangeRequest` |
| Defect | `Defect` record + `SC-WF-006` |
| Debt/hygiene | `Task` under an `ENABLING` work item |
| Investigation | `Research` work item (`SC-WF-012`) |
| Process change | `Decision` (PROCESS domain) |

**Rule:** a proposal never re-enters the lifecycle at IMPLEMENTATION. It re-enters at the stage that owns the kind of truth it changes. This is what prevents the proposal system from becoming a side channel around requirements and design.

---

## 10. Proposal System Health

| Metric | Healthy signal | Failure signal |
|---|---|---|
| Terminal-state rate | Most raised proposals resolve | Growing `RAISED`/`TRIAGE` backlog |
| Time to first disposition | Short | Long — `SC-POL-008` failing quietly |
| Rejection reason quality | Specific, tied to goals/cost | "Not needed", "out of scope" with no reasoning |
| Implemented share by class | `BLOCKING` near 100% | `BLOCKING` items lingering |
| `HYGIENE` implementation rate | Non-zero | Zero — debt is accumulating and `SC-POL-019` is eroding |
| Duplicate rate | Low | High — dedup or agent contracts need tuning |
| Owner digest engagement | Read and acted on | Ignored — flood control has failed |
| Proposals from Tier 5 vs. Tier 4 | Balanced | Only assurance raises anything — producers are not reviewing (`SC-POL-007`) |

These are reported by `SC-DEPT-002` and consumed by `SC-DEPT-064`. The last row is the most diagnostic: if producing departments never raise observations, `SC-POL-007` is being satisfied in form and not in substance.
