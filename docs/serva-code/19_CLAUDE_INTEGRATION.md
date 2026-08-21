# 19 — CLAUDE INTEGRATION

**Document ID:** SC-DOC-019
**Status:** BASELINE R4
**Type:** Normative / Integration Specification
**Owns:** Engine abstraction, invocation model, context construction, tool restriction, session management, structured output, engine failure handling.
**Does not own:** Agent contracts (`05`), runtime storage and locking (`21`), trust boundaries policy (`28`).

**Phase 1 note:** this document specifies the integration. No integration code is implemented.

---

## 1. Position of the Engine

Claude Code is the **AI Execution Engine**: a subordinate capability invoked by Serva Code, under a role, with a constructed context, a restricted toolset, and a required output schema.

```
OWNER
  │  (VS Code — the primary human surface, 20)
  ▼
SERVA CODE
  │  Orchestrator: classify → plan → dispatch (04)
  ▼
ENGINE ADAPTER  ──────────────────────────────────┐
  │  invoke(role, context, tools, schema, budget)  │  runtime-enforced
  ▼                                                │  capability boundary
AI EXECUTION ENGINE (Claude Code)                  │  (SC-POL-026)
  │  reasons · calls permitted tools               │
  ▼                                                │
TOOL LAYER (mediated by the runtime) ◄─────────────┘
  │  every call recorded; every result captured
  ▼
RESULT → schema validation → scope check → evidence verification
  ▼
SERVA VERIFICATION (gates, 18) → STORE (08)
```

**The engine never talks to the store.** It receives a context bundle and returns structured output. All persistence, all evidence, and all state transitions are performed by Serva Code. This is what makes `SC-POL-020`, `SC-POL-023` and `SC-POL-029` enforceable rather than aspirational.

### 1.1 Engine agnosticism

The engine sits behind an adapter interface so that changing engines is a Technology Decision (`09`), not a rewrite. The adapter interface is the contract; `27` records this as a self-requirement.

```
EngineAdapter {
  invoke(InvocationRequest) -> InvocationResult
  capabilities() -> { supports_tools, supports_structured_output,
                      supports_session_continuation, context_limit, models[] }
  health() -> status
  estimate(request) -> { expected_cost, expected_duration }
}
```

Serva Code MUST NOT depend on behavior outside this interface. Engine-specific features are used through capability negotiation, and their absence degrades gracefully or is reported as a capability limit — never silently changes governance behavior.

**`SC-POL-035` applies in full here** (`33` §5): the authentication route is capability-detected, the usage and billing mode is visible to the owner, there is no silent fallback to a separately billed route, unsupported authentication fails visibly, and no governance rule may depend on a provider behavior that is not detected and qualified.

---

## 2. Invocation Model

```
InvocationRequest {
  run_id            : SC-RUN-<uuid>          # created BEFORE invocation (05 RI-1)
  role              : agent contract summary (mission, responsibilities,
                                              forbidden, refusal surface)
  context_bundle    : SC-CTX-<id>            # 05 §5
  task              : task definition + scope boundary + acceptance expectations
  tools             : resolved allowlist     # capability, not text
  filesystem_scope  : { read[], write[] }
  network_scope     : NONE | DECLARED_HOSTS
  output_schema     : schema reference       # contractual
  budget            : { max_tokens, max_tool_calls, max_wall_time, max_cost }
  determinism_hint  : sampling posture per determinism class (05 §2.2)
  session_policy    : NEW | CONTINUE(session_ref)      # renamed from FRESH in R3
}

InvocationResult {
  run_id, status, structured_output, tool_calls[], consumption,
  engine_diagnostics, session_ref, terminated_by
}
```

### 2.1 Invocation rules

- **IV-1** A run record exists before invocation and is never deleted (`05` RI-1) — a crash mid-invocation leaves a record of an incomplete run, not silence.
- **IV-2** Every invocation is bound to exactly one agent contract at one version.
- **IV-3** Budgets are enforced by the runtime; exceeding them terminates the invocation with `BUDGET_EXCEEDED`, which is a defined failure (`22`), not a partial success.
- **IV-4** `determinism_hint` sets a low-variance posture for `DETERMINISTIC`-class agents. It reduces variance; it does not create reproducibility, and the system MUST NOT assume it does (`16` §10).
- **IV-5** No invocation may be issued without a resolved tool allowlist. An empty allowlist is valid (analysis-only roles); an unresolved one is a fault.

---

## 3. Session Management

Renamed in R3 from `FRESH` to `NEW`, because `FRESH` collided with the retired validity value (`31` VD-5) and the two concepts are unrelated.

| Policy | When used | Rationale |
|---|---|---|
| `NEW` | Default for all runs | Prevents cross-run contamination; guarantees the context bundle is the whole input |
| `CONTINUE` | Only within one run's multi-turn tool loop | The engine needs its own tool results, which is intra-run |

Rules:

- **SM-1** **Executor and reviewer never share a session** (`SC-POL-006`). A reviewer that inherits the executor's reasoning is not an independent reviewer.
- **SM-2** Sessions do not persist project state. Session loss costs nothing but the in-flight run (`SC-POL-020`).
- **SM-3** A session is never reused across work items, across tasks, or across days.
- **SM-4** Session identifiers are recorded on the run for diagnostics only. They are not authoritative for anything.
- **SM-5** An interrupted session's run is re-dispatched from the store, not resumed from the engine's memory.

**Why sessions are deliberately disposable:** the entire value of `SC-POL-020` is that Serva Code's memory is independent of the engine's. Any design that lets useful state accumulate inside a session recreates exactly the fragility the policy forbids.

---

## 4. Context Construction

The most consequential component in the integration. Context is **built**, never inherited.

```
buildContext(task, agent_contract, project_state):
    bundle := new ContextBundle

    # 1 — role (from contract, not free text)
    bundle.role := { mission, responsibilities, non_responsibilities,
                     forbidden_actions, refusal_surface, output schema,
                     required evidence, escalation conditions }

    # 2 — task
    bundle.task := { definition, scope_boundary, inputs, expected outputs,
                     acceptance expectations, budget }

    # 3 — canon (query-driven, relevance-ranked, version-stamped)
    bundle.canon := selectRelevantCanon(task)
        # requirements & ACs in scope · applicable business rules ·
        # module contracts · data model extracts · design tokens & component specs ·
        # authorization model extracts · applicable decisions & ADRs ·
        # coding standards · SSOT register entries · open assumptions

    # 4 — working artifacts in scope
    bundle.working := inFlightArtifacts(task)

    # 5 — workspace excerpts within read scope
    bundle.workspace := readScopedExcerpts(task.scope, budget)

    # 6 — trust annotation on EVERY element
    for e in bundle.elements: e.trust := TRUSTED | UNTRUSTED     # SC-POL-027

    # 7 — exclusions: what was withheld and why
    bundle.exclusions := recordExclusions(budget, relevance, role restrictions)

    # 8 — snapshot & stamp
    bundle.store_version := currentStoreVersion()
    persist(bundle)                                              # reconstructible
    return bundle
```

### 4.1 Context rules

- **CX-1** No conversation history from any prior run enters a bundle (`SC-POL-020`).
- **CX-2** No other agent's reasoning enters a bundle. Only typed artifacts (`07` §3.4).
- **CX-3** Every element carries `{ source, trust, version, digest }`.
- **CX-4** `exclusions` is mandatory and non-empty whenever anything was withheld. An agent that does not know something was withheld will fill the gap by invention (`05` AF-7).
- **CX-5** The bundle is persisted and reconstructible. `08` Q12 ("what did this run see?") must be answerable later.
- **CX-6** Role-based context restriction: a test-design run's bundle **excludes the implementation** (`15` §4.2 TD-8). This is a context-construction rule, not an instruction to the model — instructions are the weakest enforcement layer (`05` §8).
- **CX-7** Budget-driven truncation drops **lowest-relevance** elements and records each drop in `exclusions`. It never silently truncates mid-artifact.
- **CX-8** If required inputs do not fit the budget, the run is not dispatched. The task is split or escalated. **Dispatching a run with known-insufficient context is a design error, not a degraded mode.**

### 4.2 Trust marking (`SC-POL-027`)

| Source | Trust |
|---|---|
| Serva-governed canon, contracts, task definitions | `TRUSTED` |
| Repository file contents | `UNTRUSTED` |
| Dependency documentation, README files, code comments | `UNTRUSTED` |
| Web research results | `UNTRUSTED` |
| Client-supplied documents | `UNTRUSTED` |
| Issue/ticket text, commit messages | `UNTRUSTED` |
| Tool output from external systems | `UNTRUSTED` |

Untrusted content is delimited in the bundle and accompanied by the contract's `untrusted_content_rule`: it is data to be analyzed, never instruction to be followed. Instructions found inside untrusted content are reported as an `INJECTION_SUSPECTED` observation (`05` §10) and not obeyed.

**Critical:** trust marking reduces the probability of injection succeeding; it does not prevent it. The actual protection is the capability boundary (§5) — an injected instruction cannot cause harm the tool allowlist does not permit. Trust marking is defense in depth, not the defense.

---

## 5. Tool Restriction (`SC-POL-026`)

Tools are granted by the runtime per run, resolved from the agent contract's allowlist. The engine can call only what it was granted.

```
ToolGrant {
  tool_id, permitted_operations[],
  scope        : path patterns / host patterns / record types
  constraints  : { max_calls, timeout, requires_confirmation, dry_run_only }
  audit        : ALL_CALLS
}
```

### 5.1 Tool categories

| Category | Typical grants | Notes |
|---|---|---|
| Read | file read within read scope; store query within role scope | Broad grants are common |
| Write | file write within write scope only | Scope is the task boundary |
| Execute | declared commands only (build, test, lint, scan) | Never arbitrary shell for a producer role |
| Network | declared hosts, research roles only | `NONE` by default |
| Store | typed record creation within the role's permitted types | **No agent may write Evidence provenance or Audit Events** (`SC-POL-029`) |

### 5.2 Enforcement rules

- **TR-1** Enforcement is in the runtime. Prompt text is not a boundary (`05` §8 L5). **Enforcement strength depends on the isolation substrate** (`33` §2–§3): on a supported substrate the boundary is `CB-4`/`CB-5`-backed and satisfies L1; on an unsupported one it is harness-level only and satisfies L3, which MUST be detected, declared and qualified (`33` PC-5 … PC-10).
- **TR-2** Every tool call is recorded — including **denied** calls. Denials are diagnostic gold: they reveal contract mismatches, mis-assignment, and injection attempts.
- **TR-3** A denied call is returned to the engine as a denial, not as an error to be worked around. The engine may then escalate or refuse — both valid outcomes.
- **TR-4** Repeated denials within a run terminate it with `CAPABILITY_MISMATCH`, which is a routing signal for the Orchestrator, not an agent failure.
- **TR-5** Owner-reserved operations (`28` §3) are rejected at the runtime **regardless of contract content**. A contract that requested one is itself a defect.
- **TR-6** Write scope is enforced per-path at call time, not validated after the fact. Post-hoc detection is the backstop (`05` §4.1 `scope_actual`), not the control.

---

## 6. Structured Output

Output is contractual: schema-valid or the run is invalid.

- **SO-1** Every invocation declares an output schema (`05` §2).
- **SO-2** Invalid output → one retry with the validation error → then `INVALID_OUTPUT` (`05` §7).
- **SO-3** Prose is never parsed into state. Anything the system will act on is a schema field.
- **SO-4** The universal envelope (`05` §6) — `status`, `self_review`, `observations`, `escalations`, `evidence_claims`, `unresolved` — is required on every output.
- **SO-5** `evidence_claims` are *claims*. The runtime verifies each against actual captured evidence before acceptance (`04` §7.1 check 4). A claim without a matching record is `EVIDENCE_VIOLATION` (V1).

---

## 7. Engine Failure Handling

| Failure | Detection | Response |
|---|---|---|
| Unavailable / not authenticated | Health check, invocation error | Halt; owner notified; work item `BLOCKED` (not failed) |
| Rate limited / quota exhausted | Error | Backoff and retry; then halt and notify |
| Timeout | Runtime deadline | Terminate, record `TIMEOUT`, retry per policy, then escalate |
| Context limit exceeded | Pre-flight estimate or error | Do not truncate silently — split the task or escalate (CX-8) |
| Invalid output | Schema validation | One retry with the error, then `INVALID_OUTPUT` |
| Tool call denied repeatedly | Tool layer | `CAPABILITY_MISMATCH`; Orchestrator re-routes |
| Budget exceeded | Consumption tracking | Terminate; `BUDGET_EXCEEDED`; escalate (`SC-POL-028`) |
| Non-deterministic variance across retries | Comparison of retry outputs | Recorded; verdicts bind to artifacts, not to runs (`05` AF-13) |
| Engine returns confident but fabricated content | Collection checks (`04` §7.1) | `EVIDENCE_VIOLATION` / `SCOPE_VIOLATION` handling |
| Engine ignores role restrictions | Scope diff, tool denials | `SCOPE_VIOLATION`; quarantine; contract review |
| Engine version/behavior changes underneath | Capability probe on session start | Recorded; may invalidate determinism assumptions; reported |

### 7.1 The engine is untrusted for correctness, trusted for capability

Serva Code's stance, stated plainly:

- It **trusts** the engine to generate useful content and call tools competently.
- It does **not trust** the engine's claims about what it did, what it verified, or what state exists.

Every rule in §4–§7 follows from that split. It is the same posture a well-run organization takes toward a capable contractor: use the work, verify the claims.

---

## 8. Concurrency and Long-Running Invocations

| Concern | Handling |
|---|---|
| Multiple concurrent invocations | Permitted within the concurrency cap; write-set disjointness enforced by the runtime (`21` §5) |
| An invocation running for hours | Deadline enforced; checkpointing is at the workflow level (`07` §6.1), not inside a run |
| Owner interrupts | Run terminated with `ABORTED`; the record persists; artifacts quarantined |
| Machine sleeps or restarts mid-run | Run marked `ABORTED` on recovery; workflow resumes from the last checkpoint (`22` §4) |
| Store changes during a run | Run's context is a snapshot; a staleness check runs before its output is accepted |

**Rule:** an in-flight invocation is never assumed to be recoverable. Recovery is at the workflow level, from stored checkpoints — the engine holds nothing that Serva Code needs.

---

## 9. Cost and Consumption (`SC-POL-028`)

Every invocation records: invocations, tokens or equivalent, tool calls, wall time, and cost estimate. Aggregated per task, feature, work item and project.

- **CC-1** Budgets exist at run, task, work item and project level.
- **CC-2** Projected overrun halts expansion of work and escalates rather than proceeding partially (`SQ-6`, `04` §6.1).
- **CC-3** Review and rework loops are the dominant consumption risk; the loop breaker (`04` §8.3) is as much a cost control as a correctness control.
- **CC-4** Consumption per department and per gate is a health metric consumed by `SC-DEPT-024` and `SC-DEPT-064` — it reveals which parts of the process are disproportionately expensive relative to the defects they catch.

---

## 10. What Serva Code Must Never Delegate to the Engine

Stated as an explicit non-delegation list, because the boundary erodes easily:

| Never delegated | Why |
|---|---|
| Gate verdicts | `SC-POL-005`; gates evaluate the store (`18` §1) |
| Evidence creation | `SC-POL-023`; forgery boundary (`16` §3.2) |
| Audit event creation | `SC-POL-029` |
| State transitions | Determinism of the governance layer (`04` §12) |
| Tool permission decisions | `SC-POL-026` |
| Owner-reserved actions | `SC-POL-030` |
| Policy interpretation as final authority | Governance department + owner (`01` §5) |
| Deciding whether its own output is acceptable | `SC-POL-006` |
| Deciding what context it should receive | Context is constructed by the runtime (§4) |
| Deciding its own budget | `SC-POL-028` |

If a future version needs to relax any row, that is a `CONSTITUTIONAL` decision requiring owner approval (`09` §2) — not an implementation convenience.
