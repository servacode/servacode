# 07 — WORKFLOW MODEL

**Document ID:** SC-DOC-007
**Status:** BASELINE R4
**Type:** Normative / Execution Semantics
**Owns:** Workflow definition structure, step semantics, handoff protocol, parallelism and join semantics, compensation, standard workflow catalogue.
**Does not own:** Lifecycle stages (`03`), routing decisions (`04`), gate criteria (`18`).

---

## 1. What a Workflow Is

A **Workflow** is a versioned, declarative definition of how a class of work moves from an input state to a terminal state: which steps run, in what order, what may run in parallel, what evidence each step must produce, what gates evaluate it, and what happens on every failure branch.

Distinctions that matter:

| Concept | Scope | Lifetime |
|---|---|---|
| **Lifecycle** (`03`) | The macro path from idea to operation | Per project |
| **Profile** (`03` §7) | Which lifecycle stages apply to a work item | Per work item |
| **Workflow** (here) | How one stage or one cross-stage procedure actually executes | Definition: versioned; instance: per work item |
| **Task** (`08`) | One unit of assignable work inside a workflow step | Per step occurrence |
| **Agent Run** (`05`) | One execution of one agent against one task | Immutable record |

**Why workflows are declarative and not prompts:** a workflow is executed by the runtime, which dispatches runs and evaluates conditions. If workflow control flow lived inside model reasoning, step-skipping would be a probabilistic event. `SC-POL-024` requires it to be a recorded one.

---

## 2. Workflow Definition Schema

```
Workflow {
  id                : SC-WF-###
  name              : string
  version           : semver
  applies_to        : { request_classes[], profiles[], stages[] }
  trigger           : MANUAL | STAGE_ENTRY | EVENT | SCHEDULE | GATE_FAIL
  inputs            : InputSpec[]        # required state before start
  preconditions     : Condition[]        # evaluated against store; must all hold
  steps             : Step[]
  parallel_groups   : ParallelGroup[]
  gates             : GateBinding[]      # which gate runs after which step
  outputs           : OutputSpec[]
  postconditions    : Condition[]        # must hold at completion
  failure_paths     : FailurePath[]
  compensation      : CompensationRule[] # what to undo on abort
  terminal_states   : [COMPLETED, FAILED, ABORTED, SUPERSEDED]
  idempotency       : IdempotencyRule
  budget            : BudgetSpec
  invariants        : Invariant[]        # must hold at every step boundary
}
```

### 2.1 Step schema

```
Step {
  id                : string                    # unique in workflow
  name              : string
  department        : SC-DEPT-###
  agent_selector    : capability requirement -> SC-AGENT-###
  role_in_step      : PRODUCER | REVIEWER | VERIFIER | ANALYST | GOVERNOR
  inputs            : { from: step_id | store_query, required: bool }[]
  outputs           : artifact types produced
  scope_boundary    : PathScope                 # declared write set
  required_evidence : EvidenceRequirement[]
  exit_condition    : Condition                 # store-evaluable, not agent-asserted
  on_success        : next step | join | END
  on_fail           : FailurePath ref
  on_escalate       : route
  retry_policy      : RetryPolicy
  timeout           : duration
  conflict_check    : actor must not equal producer of {input artifacts}
  optional          : bool + skip_condition
}
```

**Critical property:** `exit_condition` is evaluated by the runtime **against stored state**, never satisfied by the agent declaring itself finished. A step whose exit condition cannot be expressed as a store query is a workflow design defect and must either gain a mechanical criterion or be explicitly marked `JUDGMENT_EXIT` with a named verifier role (`16` §5).

---

## 3. Handoff Protocol

The assignment asks specifically how information moves between departments. Handoff in Serva Code is **never conversational**. There is no message passing between agents, no shared scratchpad, and no inherited context.

### 3.1 The rule

> **Departments hand off through the Knowledge Store, not to each other.**
> A producer writes typed artifacts. The runtime constructs the consumer's context from those artifacts. The consumer never sees the producer's reasoning, prompt, or session.

### 3.2 Handoff record

Every handoff produces records so that "who gave what to whom, and was it complete" is answerable. **Corrected in R2:** the offer and the acceptance are separate append-only events (`HandoffOffered`, `HandoffAccepted` / `HandoffRejected`); the `Handoff` below is the `T-DERIVED` view composed from them, not a mutable record that acquires its acceptance later (`08` §2.1).

```
Handoff {
  handoff_id     : SC-HO-###
  workflow_run   : SC-WFR-###
  from_step      : step_id
  to_step        : step_id
  artifacts      : { id, type, version, digest }[]
  completeness   : COMPLETE | PARTIAL(missing[])
  open_items     : { assumptions[], escalations[], known_gaps[] }
  accepted_by    : step_id
  acceptance     : ACCEPTED | REJECTED(reason) | ACCEPTED_WITH_CONCERNS(concerns[])
  at             : timestamp
}
```

### 3.3 Handoff rules (normative)

- **HO-1** A consumer step MUST verify that its required inputs exist, are the expected version, and are non-stale before starting. Missing inputs produce `BLOCKED`, never a best-effort attempt.
- **HO-2** A consumer MAY reject a handoff (`REJECTED`) with a reason. Rejection returns work to the producer step; it does not fail the workflow.
- **HO-3** Assumptions and known gaps propagate. A consumer inherits the producer's open assumptions and MUST NOT treat an assumption-based artifact as settled truth.
- **HO-4** A handoff MUST NOT include agent reasoning, chain-of-thought, or session transcripts as authoritative input. Those may exist only as evidence attachments (`SC-POL-020`).
- **HO-5** Cross-tier handoffs are always downward-specification / upward-evidence (`02` §2). A Tier 4 step cannot hand a *decision* upward; it hands an escalation or a proposal.
- **HO-6** `ACCEPTED_WITH_CONCERNS` records the concerns as `Observation` items, which are triaged like any other (`SC-POL-008`).

### 3.4 Why this design

Three failure modes are eliminated structurally:

| Failure | Prevented by |
|---|---|
| Telephone-game degradation across agents | Typed artifacts, not summaries |
| A later agent inheriting an earlier agent's mistaken reasoning as authority | No reasoning in handoffs |
| Silent information loss on context truncation | Explicit required-input verification (HO-1) |

---

## 4. Parallelism and Join Semantics

```
ParallelGroup {
  id            : string
  steps         : step_id[]
  write_sets    : must be pairwise disjoint      # verified at plan time
  join          : ALL | ANY | QUORUM(n) | FIRST_SUCCESS
  join_action   : RECONCILE | MERGE | SELECT
  on_conflict   : FAIL | ESCALATE | RECONCILE_STEP(step_id)
  timeout       : duration
  partial_policy: WAIT | PROCEED_WITH_PARTIAL(record) | ABORT
}
```

### 4.1 Reconciliation is mandatory

Steps that ran in parallel and produced overlapping conclusions MUST be reconciled at the join. **Contradiction between parallel outputs is a failure condition, not a merge decision.** The system must never resolve a contradiction by taking whichever result arrived last.

Reconciliation outcomes:

| Outcome | Meaning |
|---|---|
| `CONSISTENT` | Outputs agree or are orthogonal; proceed |
| `COMPLEMENTARY` | Outputs differ in scope; merged per `join_action` |
| `CONTRADICTORY` | Outputs conflict on the same question; triggers `on_conflict` |

A `CONTRADICTORY` join involving a design-authority decision escalates to the accountable department in the RACI (`02` §5). If two accountable departments contradict each other, it escalates to Tier 1, then Tier 0.

### 4.2 Parallel safety preconditions

Before dispatching a parallel group, the runtime MUST verify (per `04` §6.2): disjoint write sets, no `HARD` dependency, no producer/reviewer pairing, budget headroom, and no shared pending owner question. Failure of any check serializes the group; it does not proceed hopefully.

---

## 5. Failure Paths and Compensation

```
FailurePath {
  id            : string
  trigger       : GATE_FAIL | STEP_FAIL | TIMEOUT | ESCALATION_UNRESOLVED |
                  SCOPE_VIOLATION | EVIDENCE_VIOLATION | BUDGET_EXCEEDED |
                  CONTRADICTION | EXTERNAL_CHANGE | LOOP_DETECTED
  action        : RETRY | REWORK(step_id) | ROLLBACK(step_id) |
                  ESCALATE(target) | ABORT | QUARANTINE
  max_attempts  : int
  backoff       : none | linear | exponential
  record        : required record type
  notify        : OWNER | GOVERNANCE | NONE
}
```

### 5.1 Compensation

A workflow that aborts mid-flight may have produced partial artifacts and partial filesystem changes. Compensation defines what is undone:

| Artifact class | Compensation |
|---|---|
| `T-TRACE` records (runs, evidence, audit) | **Never undone** (`SC-POL-022`) — they record what happened |
| `T-WORKING` drafts | Marked `ABANDONED(workflow_run)`, retained |
| `T-CANON` baselined artifacts | Never modified by an aborted workflow; baselining is a separate, gated act |
| Workspace file changes | Quarantined (`22` §5): moved to a recovery area, workspace restored to the last known-good digest set, divergence reported |
| External side effects | **Cannot be compensated** — which is precisely why they are owner-reserved (`SC-POL-030`) |

**Design consequence:** the set of actions that cannot be compensated is the set that must never be automated. This is the engineering justification for `SC-POL-030`, not merely a caution.

### 5.2 Idempotency

```
IdempotencyRule {
  key           : deterministic function of (work_item, step, input digests)
  on_duplicate  : SKIP | REUSE_RESULT | RERUN_AND_SUPERSEDE
  scope         : STEP | WORKFLOW
}
```

Required because workflows are resumable after interruption (`22` §4). Rules:

- **ID-1** Re-entering a completed step with identical input digests MUST NOT duplicate its artifacts.
- **ID-2** Re-running a step with *changed* inputs creates a new run that supersedes the old; dependent results then derive to `ValidityState.STALE` (`31` §3.2). Nothing is written on them.
- **ID-3** Steps with external side effects (none are automated in 1.0) would require an idempotency key carried to the external system. Since such steps are owner-reserved, 1.0 has no automated non-idempotent steps — this is stated so that future versions cannot introduce one silently.

---

## 6. Workflow Instance and Resumption

```
WorkflowRun {
  id              : SC-WFR-###
  workflow_ref    : SC-WF-### @ version
  work_item       : SC-WI-###
  state           : PENDING | RUNNING | WAITING | GATING | REWORK |
                    COMPLETED | FAILED | ABORTED | SUPERSEDED
  current_steps   : step_id[]          # more than one when parallel
  step_ledger     : StepRecord[]       # disposition per step, mirrors SC-POL-024
  handoffs        : SC-HO-###[]
  gate_results    : SC-GR-###[]
  consumption     : aggregated
  checkpoints     : Checkpoint[]
  started_at, updated_at, ended_at
}
```

### 6.1 Checkpointing

A checkpoint is written at every step boundary and every gate boundary, recording: workflow state, completed steps, artifact versions, and store version. Resumption after any interruption (crash, kill, machine restart, engine failure) restarts from the last checkpoint after re-running reconciliation (`SC-POL-032`).

**Invariant:** a workflow run interrupted at any point is resumable or explicitly declared unrecoverable with a diagnosis. Silent loss of a run is a V1 store defect (`21` §6).

### 6.2 Long-running work

Workflows may span days. Consequences that must be handled:

| Concern | Handling |
|---|---|
| Inputs change while a step is in flight | Context snapshot isolates the run; on completion, staleness check runs before acceptance |
| A gate passed weeks ago | `SC-POL-031` staleness; verdicts re-evaluated against current artifact versions |
| Owner forgot the context | `nextAction` (`04` §9) always explains state from the store |
| A workflow definition is upgraded mid-run | The run stays bound to its version; upgrading a live run requires an explicit migration decision |

---

## 7. Standard Workflow Catalogue

These are the binding workflow definitions for 1.0. Each names its steps, its gates and its critical failure paths. Detailed gate criteria live in `18`.

### SC-WF-001 · New Project Initiation
`Trigger:` RC-01.
Steps: capture Idea → structure Intake → `[GATE-INTAKE]` → Discovery ∥ Market Research → `[GATE-DISCOVERY]` `[GATE-COMPETITIVE]` → Product Validation → `[GATE-PRODUCT_VALIDATION]` → **owner decision** → establish project store, profile, budgets.
Critical failure paths: `DO_NOT_BUILD` recommendation → workflow completes with a terminal `NOT_PURSUED` state, retaining all findings; owner non-response → `STALLED` surfacing.

### SC-WF-002 · Requirements Definition
Steps: Business Analysis ∥ Market findings intake → Requirements authoring → NFR authoring (with Tier 3 participants) → Requirements Quality Verification (**separate agent**, `SC-AGENT-052`) → contradiction check → `[GATE-REQUIREMENTS]` → baseline.
Invariant: baselining is a distinct step; authoring never baselines its own output.

### SC-WF-003 · Architecture & Technology
Steps: parallel group {Architecture, Data Architecture, Security Architecture} → **reconciliation step** → Technology Evaluation → Technology Decision → Cost Assessment → Complexity Justification → Architecture Review (`SC-AGENT-072`) → `[GATE-ARCHITECTURE]` `[GATE-TECHNOLOGY]` → ADRs baselined, SSOT Register established.
Join: `ALL`, `on_conflict: RECONCILE_STEP`. A contradiction between data and security architecture is the archetypal case this exists for.

### SC-WF-004 · Design Definition
Steps: UX flows and state coverage → parallel group {Design System tokens/components, Admin Operability design review} → UX Review + Design System Review → accessibility design check → `[GATE-DESIGN]`.
Failure path: undefined state found → REWORK(UX step), never "implement and decide later".

### SC-WF-005 · Feature Implementation *(the most-executed workflow)*
```
 1  Task preparation        (Orchestrator: scope boundary, inputs, evidence spec)
 2  Admin Operability Review for the feature      [SC-POL-010]
 3  Implementation          (Tier 4 PRODUCER, scope-bounded)
 4  Self-review + observations                    [SC-POL-007]
 5  Build + static analysis + token scan          (runtime-captured evidence)
 6  Code Review             (SC-DEPT-050, actor != step 3 actor)   [GATE-CODE_REVIEW]
 7  Test design from requirements (SC-AGENT-211, not from the code)
 8  Test execution          (SC-RTC-012, runtime-captured)          [GATE-QA]
 9  parallel { Security Testing | Performance }   [GATE-SECURITY] [GATE-PERFORMANCE]
10  Traceability link verification (SC-RTC-007)
11  Acceptance              (SC-DEPT-054)                           [GATE-ACCEPTANCE]
12  Observation triage -> Proposals                                 [SC-POL-008]
```
Failure paths: step 6 FAIL → REWORK(3); step 8 FAIL → REWORK(3) with defect records; `SCOPE_VIOLATION` at any step → QUARANTINE + owner notification; loop breaker after 3 same-root-cause failures (`04` §8.3).

### SC-WF-006 · Bug Fix
Steps: reproduce (evidence required) → classify (defect vs. requirement gap vs. incident) → root cause → scope boundary → implement → **regression test written first** → Code Review → QA (including the regression test) → Acceptance → lesson capture if the class recurs.
Invariant: a bug fix with no reproduction evidence and no regression test cannot pass QA. "Fixed" without a failing-then-passing test is `NOT_VERIFIED`.

### SC-WF-007 · Security Fix (expedited)
Steps: assess exposure → classify severity → contain if live (may invoke incident path) → minimal-scope fix → Security Review → Security Testing re-test → Code Review → expedited Acceptance → release preparation → retroactive full records.
Rules: scope is limited to removing the exposure (`SC-POL-009` exception); every relaxation taken is recorded retroactively; the owner is notified at classification, not at completion.

### SC-WF-008 · Change Request
Steps: CR intake → classify magnitude → Impact Analysis (`SC-POL-013`, no `UNKNOWN` permitted) → cost/schedule assessment → approval at required authority (`09` §2) → if approved: re-enter the lifecycle at the originating stage → affected results derive to `STALE` (`31` §3.2).
Failure path: `UNKNOWN` in impact → dispatch investigation tasks; never approve around it.

### SC-WF-009 · Proposal Lifecycle
Steps: creation → deduplication/merge → completeness check → assessment (value, cost, complexity, risk, impact) → classification → routing to decision authority → decision → if approved, conversion into a governed work item.
Detail: `10`.

### SC-WF-010 · Release
Steps: verify acceptance non-stale → operational readiness verification → rollback test (where in scope) → backup verification (where in scope) → release notes → handover package → `[GATE-RELEASE]` → **owner go/no-go** → owner-executed release → post-release verification → handover.

### SC-WF-011 · Incident Response
Steps: detect/receive → classify severity → notify owner (threshold-based) → contain → restore → verify restoration with evidence → root cause (by a different actor than the responder) → corrective actions as governed work items → post-incident review → retroactive records → lesson capture.
Detail: `23` §6.

### SC-WF-012 · Research
Steps: frame the question → declare the evaluation criteria **before** researching → gather with sources → assess source quality → synthesize findings with `valid_until` → produce recommendation (not decision) → route to the deciding department.
Invariant: produces no code. A research workflow that modifies product code is a `SCOPE_VIOLATION`.

### SC-WF-013 · Design System Change
Steps: change intake → impact analysis over every token consumer → migration plan → token change → component updates → visual regression verification → Code Review → Acceptance.
Reason for existence: a token change is a low-effort, high-blast-radius change — the shape most likely to be under-classified. This workflow forces `M3` treatment.

### SC-WF-014 · Operational Change
Steps: verify the element is `OWNER_CONFIGURABLE` or `ADMIN_CONFIGURABLE` in the Configuration Register → if `PROTECTED_INVARIANT`, refuse and route to a CR → apply via the configuration mechanism → verify → audit record.
Reason for existence: makes `SC-POL-010` bidirectional — configuration changes must go through configuration, not through code edits.

### SC-WF-015 · Project Reconciliation *(DERIVED)*
`Trigger:` session start, pre-gate, or detected divergence.
Steps: scan workspace → compute digests → compare with store → classify divergences (expected build output, untracked additions, modified governed artifacts, deletions) → affected results derive to `STALE` → report to owner → offer resolution options (adopt, revert, investigate).
Reason for existence: `SC-POL-032`. Without this workflow, every other workflow may be operating on a false premise.

---

## 8. Workflow Invariants

Checked at every step boundary. Violation halts the run.

| ID | Invariant |
|---|---|
| `WI-1` | Every step has a store-evaluable exit condition or an explicit `JUDGMENT_EXIT` with a named verifier |
| `WI-2` | No step's actor equals the producer of an artifact that step verifies (`SC-POL-006`) |
| `WI-3` | Every artifact consumed exists, is the expected version, and is non-stale |
| `WI-4` | Every parallel group's write sets are pairwise disjoint |
| `WI-5` | Every step disposition is recorded (`SC-POL-024`) |
| `WI-6` | Every observation reaches triage before the run completes (`SC-POL-008`) |
| `WI-7` | Consumption is recorded and within budget (`SC-POL-028`) |
| `WI-8` | No `T-TRACE` record was modified (`SC-POL-022`) |
| `WI-9` | Every gate binding executed or explicitly `NOT_APPLICABLE` |
| `WI-10` | The run is checkpointed and resumable |
| `WI-11` | No owner-reserved action was performed (`SC-POL-030`) |
| `WI-12` | Every escalation raised has a route and is not silently dropped |

---

## 9. Workflow Governance

Workflow definitions are `T-CANON`. Changes follow `09`:

| Change | Governance |
|---|---|
| Add a step, gate, or evidence requirement | Decision Record |
| Remove a step, gate, or evidence requirement | Decision + Impact Analysis + **owner approval** |
| Change parallelism or join semantics | Decision + Impact Analysis |
| Change a failure path | Decision Record |
| Change compensation or idempotency | Decision + owner approval |

**Asymmetry is deliberate:** adding rigor is cheap to approve; removing it requires the owner. This prevents gradual erosion of the assurance structure under throughput pressure — the most likely long-term failure of the whole system.
