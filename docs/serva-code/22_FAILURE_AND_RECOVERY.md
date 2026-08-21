# 22 — FAILURE AND RECOVERY

**Document ID:** SC-DOC-022
**Status:** BASELINE R4
**Type:** Normative / Operational Specification
**Owns:** Failure taxonomy for Serva Code itself, detection, retry policy, recovery procedures, quarantine, degraded operation.
**Does not own:** Product incident management (`23` §6), gate failure routing (`18` §5).

---

## 1. Scope and Principle

This document covers failures **of Serva Code**, not failures of the products it builds.

Governing principle:

> **A failure that is detected and recorded is acceptable. A failure that produces false truth is not.**

Every mechanism below is ordered by that priority: it is always better to halt with `NOT_VERIFIED` than to proceed with a plausible-looking wrong answer.

---

## 2. Failure Taxonomy

| Class | Examples | Primary risk |
|---|---|---|
| `F1 — Engine` | Unavailable, rate-limited, timeout, context exceeded, invalid output | Work stops |
| `F2 — Agent behavior` | Scope violation, fabricated evidence, silent assumption, injection followed | **False truth** |
| `F3 — Tool` | Command fails, tool unavailable, permission denied, external system down | Work stops or evidence missing |
| `F4 — Runtime` | Process crash, kill, machine restart, sleep, resource exhaustion | Partial state |
| `F5 — Store` | Corruption, partial write, integrity violation, schema mismatch | **Truth loss** |
| `F6 — Workspace` | External modification, git operations, deleted artifacts, permission changes | Plan invalidity |
| `F7 — Process` | Rework loops, deadlock, starvation, stalled items, unresolvable classification | Work never completes |
| `F8 — Governance` | Unenforceable policy, contradictory baselined artifacts, erosion of gates | **Systemic false confidence** |
| `F9 — Resource` | Budget exhausted, disk full, concurrency saturation | Work stops |
| `F10 — Human` | Owner unavailable, ambiguous consent, contradictory instruction | Blocking |

`F2`, `F5` and `F8` are the dangerous classes because they can produce confident wrong answers. Everything else merely stops work, which is recoverable.

---

## 3. Detection

Detection must not depend on the failing component reporting its own failure.

| Failure | Detected by | Independent of the failing part? |
|---|---|---|
| Scope violation | Runtime scope diff (`05` §4.1) | Yes |
| Fabricated evidence | Collection check 4 (`04` §7.1) + integrity checker | Yes |
| Silent assumption | Mandatory `assumptions_made` schema field | Partially — schema-enforced presence, not truthfulness |
| Injection followed | Tool denials, scope diff, `INJECTION_SUSPECTED` observation | Yes (capability layer) |
| Invalid output | Schema validation | Yes |
| Crash mid-run | Run record without terminal outcome + lease expiry | Yes |
| Store corruption | Integrity checker digests (`21` §6) | Yes |
| Workspace divergence | Reconciliation (`21` §10) | Yes |
| Rework loop | `(gate, root_cause)` counter (`04` §8.3) | Yes |
| Deadlock | Cycle detection at plan time | Yes |
| Stalled item | Scheduler threshold (`SC-POL-033`) | Yes |
| Budget exhaustion | Consumption tracking | Yes |
| Gate erosion | Governance trend metrics (`18` §7) | Yes |
| Policy unenforceability | `policy_refs` coverage check (`18` §2) | Yes |

**Rule DT-1:** every `F2` detection mechanism is external to the agent. An agent asked "did you stay in scope?" is not a detector.

---

## 4. Interruption and Resumption

Interruption is normal, not exceptional: machines sleep, processes are killed, owners close their laptop.

### 4.1 What survives

| State | Survives? | Mechanism |
|---|---|---|
| Project truth | Yes | Durable store (`21` §4) |
| Workflow position | Yes | Checkpoints (`07` §6.1) |
| Run record | Yes | Created before invocation (`05` RI-1) |
| Run output | Only if collected | Otherwise the run is `ABORTED` |
| Engine session | No | Disposable by design (`19` §3) |
| In-flight reasoning | No | Nothing depends on it (`SC-POL-020`) |
| Locks | Released via lease expiry | `21` LK-5 |

### 4.2 Recovery on startup

```
onStartup():
    verify store integrity                       # 21 §6
    if corrupt:            -> recovery procedure §5
    detect abandoned runs  (no terminal outcome, lease expired)
        mark ABORTED; quarantine any partial artifacts
    reconcile workspace                          # 21 §10
    recompute staleness                          # SC-POL-031
    detect stalled items                         # SC-POL-033
    resume workflows from last checkpoint
    report to owner: what was interrupted, what was quarantined, what is stale
```

**Rule RC-1:** an aborted run is never assumed to have completed correctly. Its partial output is quarantined and either re-run or discarded — never partially adopted, because a half-applied change is more dangerous than no change.

---

## 5. Recovery Procedures

### 5.1 Store corruption

```
1  Halt all dispatch immediately
2  Set governance state = UNKNOWN (20 §2)
3  Diagnose: which records, which tier, when introduced (store version)
4  Snapshot the corrupt state before touching it   # never discard forensic evidence
5  Attempt targeted repair:
      broken links        -> mark, do not fabricate targets
      partial transaction -> roll back per TX-1
      unreadable record   -> isolate, mark affected verdicts NOT_VERIFIED
6  If repair is insufficient -> restore from the last verified backup (21 §7)
7  Recompute derived views; recompute staleness
8  Report: what was lost, what was restored, what must be re-verified
9  Audit event; lesson capture
```

- **SR-1** Repair never invents data. A missing record stays missing and is reported; a fabricated repair would be the worst possible outcome for a system whose value is truth.
- **SR-2** Restoring to an earlier point loses work. What was lost is enumerated explicitly, and re-verification of anything the lost records supported is required.
- **SR-3** The corrupt state is retained for diagnosis before any repair.

### 5.2 Quarantine

Used when artifacts exist but cannot be trusted: aborted runs, scope violations, suspected fabrication, unresolved divergence.

```
quarantine(artifacts, reason):
    move to the project's quarantine area (not deleted)
    restore workspace to the last known-good digest set
    record: what, why, which run, what the owner may do
    block gates that depend on the affected artifacts
```

Owner dispositions: **discard**, **inspect and adopt** (which becomes an owner-originated change requiring re-verification), or **re-run the task**.

- **QR-1** Quarantined artifacts are never silently deleted or silently restored.
- **QR-2** Quarantine is not punishment; it is preservation of uncertainty until it can be resolved.

### 5.3 Response to fabricated evidence (V1)

```
1  Halt the work item immediately
2  Revoke every verdict citing the fabricated evidence; cascade staleness
3  Quarantine the run's artifacts
4  Audit event; notify owner immediately
5  Governance investigation: contract gap? context gap? enforcement gap?
6  Corrective action:
      contract gap    -> contract amendment (05 §12)
      enforcement gap -> new mechanical check (this is the important outcome)
      systemic        -> constitutional amendment proposal
7  Re-run the task with the corrected controls
8  Lesson capture
```

**Rule FB-1:** the corrective action must be **mechanical wherever possible**. Responding to fabrication by adding stronger instruction text is not a fix (`05` §8 — L5 is the weakest layer). The correct response is a check that makes the fabrication detectable or impossible.

### 5.4 Scope violation

```
1  Reject the run output
2  Quarantine changes outside the declared scope
3  Classify: misunderstanding | task under-scoped | contract gap | injection
4  If the task was genuinely under-scoped -> re-scope and re-dispatch (this is common and legitimate)
5  If the agent exceeded a correct scope   -> contract review; check enforcement
6  Record; notify if V1
```

Distinguishing an under-scoped task from a misbehaving agent matters: the first is a planning defect, the second is a control defect, and the corrective actions are entirely different.

---

## 6. Retry Policy

| Failure | Retry? | Policy |
|---|---|---|
| Engine unavailable | Yes | Exponential backoff, capped, then halt and notify |
| Rate limited | Yes | Backoff per signal, then halt |
| Timeout | Once | Then escalate; investigate task size |
| Invalid output | Once | With the validation error appended, then `INVALID_OUTPUT` |
| Tool transient failure | Yes | Bounded |
| Tool permission denied | **No** | This is a routing/contract signal, not a transient error |
| Scope violation | **No** | Re-scope first |
| Fabricated evidence | **No** | Investigate first |
| Context exceeded | **No** | Split the task; never retry the same oversized request |
| Budget exceeded | **No** | Owner decision required |
| Store corruption | **No** | Recovery procedure |
| Gate FAIL | Rework, not retry | Bounded by the loop breaker |

- **RT-1** Retry never widens capability, extends scope, or raises budget. Retrying with more permission is how a contained failure becomes an uncontained one.
- **RT-2** Every retry is a new run record (`05` RI-7). Retry history is visible; a run that succeeded on the fourth attempt is not the same evidence as one that succeeded immediately.
- **RT-3** Retries consume budget and count toward it.

---

## 7. Loop and Deadlock Prevention

| Pattern | Detection | Response |
|---|---|---|
| Rework oscillation | Same `(gate, root_cause)` N times | Halt; present all attempts and what changed (`04` §8.3) |
| Proposal ping-pong | Proposal reopened repeatedly | Escalate to owner as an unresolved decision |
| Escalation loop | Escalation routed back to its origin | Structural defect; route to Governance |
| Task deadlock | Cycle in the dependency graph | Refuse the plan at design time |
| Lock deadlock | Ordered acquisition + lease expiry | Prevented by ordering; broken by expiry |
| Starvation | Stall threshold | Surface to owner |
| Infinite decomposition | Task tree depth/count limit | Halt; escalate as a planning defect |

`Infinite decomposition` is a real risk specific to AI planning: an agent asked to decompose work can decompose indefinitely. Hard limits on depth and breadth are required, and hitting them is a planning signal rather than a resource error.

---

## 8. Degraded Operation

Serva Code must remain useful when parts are unavailable.

| Unavailable | Still possible | Not possible |
|---|---|---|
| Engine | All reads, all queries, all gate evaluations on existing evidence, reporting, planning review | New agent runs |
| Network | Everything except research and dependency scanning | Research; freshness refresh of external findings |
| Store (read-only) | Reads and reporting | Any state change |
| Store (corrupt) | Recovery operations | Everything else |
| A tool (e.g. test runner) | Everything else | Evidence requiring that tool → `NOT_VERIFIED`, never assumed |
| Owner | All non-blocking work | Anything requiring approval or a reserved action |

**Rule DG-1:** unavailability of a verification tool yields `NOT_VERIFIED`, never `PASS`. This is the single most likely place for the system to quietly degrade into false assurance, and it is closed by making tool absence produce an explicit unverified state.

**Rule DG-2:** degraded state is visible (`20` §9) with what is degraded and what it blocks.

---

## 9. Failure Records and Learning

Every failure produces a record. Failure records feed `SC-DEPT-064`.

```
FailureRecord {
  id, class (F1..F10), subject (run/workflow/gate/store),
  detected_by, detected_at, symptoms, diagnosis | UNDIAGNOSED,
  impact : { work lost, verdicts invalidated, truth affected },
  response_taken, corrective_action_ref,
  recurrence_count, prevention : MECHANICAL | PROCESS | CONTRACT | NONE_POSSIBLE
}
```

- **FR-1** Recurring failures of the same class are a systemic signal, and are escalated as a Proposal or a constitutional amendment.
- **FR-2** `prevention: NONE_POSSIBLE` requires justification and becomes a documented accepted risk (`25`).
- **FR-3** Failure rate by class is a health metric (`24`).
- **FR-4** A failure whose diagnosis is `UNDIAGNOSED` stays open. Closing an undiagnosed failure is how the same failure recurs indefinitely.

---

## 10. Failure Mode Summary — the ten that matter most

| # | Failure | Why it is dangerous | Primary control |
|---|---|---|---|
| 1 | Fabricated evidence | Falsifies the entire assurance chain | `SC-POL-023` runtime capture (`16` §3.2) |
| 2 | Silent scope expansion | Unrequested change enters the product | Runtime scope diff |
| 3 | Store corruption | Loses irreplaceable project memory | Integrity checks + verified backups |
| 4 | Stale verdict authorizing release | Ships unverified work with a governance record behind it | `SC-POL-031` staleness cascade |
| 5 | Workspace divergence unnoticed | All reasoning applies to a system that does not exist | `SC-POL-032` reconciliation + `XC-7` |
| 6 | Gate erosion over time | Governance becomes ceremonial while appearing intact | Weakening requires owner approval (`18` §9) |
| 7 | Self-certification creeping in | Removes the only real check on AI output | Actor binding in the store (L2) |
| 8 | Rework loop consuming budget | Unbounded cost, oscillating changes | Loop breaker |
| 9 | Prompt injection via repository content | Agent acts on attacker intent | Capability boundary + trust marking |
| 10 | Owner stops reading notifications | `SC-POL-008` and `SC-POL-012` fail silently | Notification volume as a health metric (`20` NT-1) |

Failure 10 is the one no technical control fixes. It is listed anyway, because a governance system that overwhelms its only human eventually governs nothing — and pretending otherwise would be exactly the kind of overclaiming `16` §10 forbids.
