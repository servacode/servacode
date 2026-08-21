# 21 — LOCAL RUNTIME MODEL

**Document ID:** SC-DOC-021
**Status:** BASELINE R4
**Type:** Normative / Runtime Specification
**Owns:** Storage layout requirements, transactional semantics, concurrency and locking, integrity checking, backup/restore, project isolation, reconciliation, retention.
**Does not own:** Entity definitions (`08`), engine protocol (`19`), failure recovery procedures (`22`).

**Phase 1 note:** this specifies requirements and semantics, not an implementation. No storage technology is selected (`SC-POL-016`, `27`).

---

## 1. Runtime Shape

Serva Code runs **locally, for one owner, on one machine**, primarily inside VS Code.

Non-goals restated for the runtime (`00` §3.1): no multi-tenancy, no clustering, no HA, no orchestration platform, no server deployment of Serva Code itself.

**But single-user does not mean single-threaded.** The runtime must handle:

- multiple concurrent agent runs;
- long-running work spanning days;
- background research and monitoring;
- the owner editing files while runs are in flight;
- process kills, crashes, sleeps and restarts mid-operation.

Treating "one user" as "no concurrency" is the most common and most damaging simplification available here, and it is explicitly rejected (`SC-POL-028`, `04` §6.3).

---

## 2. Components

| Component | Responsibility |
|---|---|
| **Store** | Persist all entities (`08`); transactional; append-only where required |
| **Store integrity checker** | Verify invariants (`08` §7) and detect corruption |
| **Lock manager** | Grant and enforce write-set locks (§5) |
| **Runtime executor** | Dispatch runs, capture evidence, enforce capability (`19` §5) |
| **Tool mediator** | Every tool call passes through it; enforces allowlist, records calls and denials; enforcement strength depends on the substrate (`33` §3) |
| **Substrate detector** | Determines and declares the capability enforcement class at startup (`33` PC-5) |
| **Evidence capturer** | Creates `EXECUTION`/`OBSERVATION` evidence with provenance (`16` §4) — the only writer of evidence |
| **Workspace reconciler** | Detect and classify divergence (`SC-POL-032`) |
| **Gate engine** | Deterministic criterion evaluation (`18`) |
| **Orchestrator** | `04` |
| **Engine adapter** | `19` §1.1 |
| **Scheduler** | Long-running work, expiry checks, re-evaluation triggers, stall detection |
| **Backup manager** | Snapshot, verify, restore (§7) |
| **Audit writer** | Sole writer of `AuditEvent` (`SC-POL-029`) |

**Separation that matters:** the evidence capturer and the audit writer are distinct from the executor and are not reachable by any agent tool. This is the mechanical basis of `SC-POL-023` and `SC-POL-029`.

---

## 3. Storage Layout Requirements

No technology is chosen. These are the binding requirements.

| ID | Requirement |
|---|---|
| `ST-1` | All project truth on local disk, under a defined per-project root |
| `ST-2` | The store is inspectable by the owner without Serva Code running — their data is not hostage to the tool |
| `ST-3` | Store and product workspace are distinguishable; the store never lives inside a path the product build may clean |
| `ST-4` | `T-TRACE` storage is append-only at the storage layer, not merely by convention |
| `ST-5` | Large evidence artifacts (logs, screenshots, reports) are content-addressed by digest and referenced, not inlined |
| `ST-6` | The store has a schema version; migrations are versioned and reversible |
| `ST-7` | The store is portable — copying the root to another machine yields a working project |
| `ST-8` | No implicit network transmission of store contents (`00` §13) |
| `ST-9` | Records are individually addressable and queryable to satisfy `08` §8 |
| `ST-10` | Store size is bounded by retention policy (§9), not unbounded growth |

`ST-2` is a deliberate constraint on technology selection: a format that requires Serva Code to be readable would make the owner's project memory dependent on a tool that might break — which contradicts the entire purpose of `SC-POL-020`.

---

## 4. Transactional Semantics

| ID | Requirement |
|---|---|
| `TX-1` | Multi-record state changes are atomic. A crash mid-transition leaves either the old or the new state, never a partial one |
| `TX-2` | Every write is durable before it is reported as committed |
| `TX-3` | Reads within a run see a consistent snapshot (`19` §4, CX-8) |
| `TX-4` | `T-TRACE` appends are atomic and never lost on rollback of a related transaction — a failed operation still leaves its record |
| `TX-5` | Store version increments monotonically; every record carries the version at which it was written |
| `TX-6` | Idempotency keys (`07` §5.2) prevent duplicate application after a retry |

`TX-4` is subtle and important: if a workflow transaction rolls back, the *record that it was attempted and failed* must survive. Otherwise failed attempts vanish and the loop breaker (`04` §8.3), the audit trail, and post-incident analysis all lose their input.

---

## 5. Concurrency and Locking

### 5.1 Write-set locking

Every dispatched run declares a write set (its scope boundary, `14` §3). The lock manager grants locks before invocation.

| Rule | Detail |
|---|---|
| `LK-1` | A run cannot start until all its write-set locks are granted |
| `LK-2` | Locks are held for the run's duration and released on any terminal outcome, including crash (via lease expiry) |
| `LK-3` | Conflicting dispatch is refused at plan time (`04` §6.2), not discovered at write time |
| `LK-4` | Locks cover both workspace paths and store record ranges |
| `LK-5` | Leases expire, so a killed process does not deadlock the project permanently |
| `LK-6` | Lock acquisition is ordered to prevent deadlock; cycles are detected at plan time |

### 5.2 Snapshot isolation

A run's context is a snapshot at dispatch (`19` §4). Concurrent changes do not alter it. On collection, a staleness check runs before the output is accepted (`SC-POL-031`).

### 5.3 The owner as a concurrent actor

The owner is a writer the runtime does not control. Handling:

| Situation | Response |
|---|---|
| Owner edits a file inside an active run's write set | Detected at collection; run's output quarantined; divergence reported; owner chooses |
| Owner edits a file outside any active run | Detected at next reconciliation; digests updated; affected verdicts stale |
| Owner runs an ungoverned AI session that edits files | Same as above — appears as divergence, is not silently adopted (`20` UX-3) |
| Owner performs git operations (branch switch, reset, merge) | Reconciliation detects broad divergence; may invalidate the plan (`04` OF-3) |

**Rule CN-1:** the runtime never assumes it is the only writer. Every gate evaluation is preceded by reconciliation (`XC-7`).

---

## 6. Integrity Checking

Runs at session start, before gate evaluation, after recovery, and on a schedule.

| Check | Detects | Severity |
|---|---|---|
| `T-TRACE` digest verification | Mutated immutable records | V1 |
| Evidence provenance completeness | Forged or malformed evidence (`16` §8) | V1 |
| Verdict-evidence binding | Unbound `PASS` | V1 |
| Actor separation | `SC-POL-006` violations | V1 |
| Link resolution | Broken references | V2 |
| Stage ledger completeness | `SC-POL-024` gaps | V2 |
| Schema conformance | Malformed records | V2 |
| Artifact digest vs. workspace | Divergence (`SC-POL-032`) | V2 |
| Orphan detection | Traceability gaps (`08` §5.1) | V2/V3 |
| Configuration/protected-rule consistency | `KI-17` | V1 |
| Store version consistency | Partial write / corruption | V1 |

**Rule IG-1:** integrity failure sets governance state to `DEGRADED` (`20` §2), blocks gates whose inputs are affected, and reports precisely what is affected. It does not silently continue, and it does not block everything indiscriminately.

**Rule IG-2:** integrity checks are performed by the runtime, never by an agent. An agent cannot be asked to verify the integrity of the records it may have corrupted.

---

## 7. Backup and Restore

The store **is** the project memory (`SC-POL-020`). Losing it loses everything except the code — including every decision, every piece of evidence, and every reason anything is the way it is. Backup is therefore a 1.0 requirement, not an operational nicety.

| ID | Requirement |
|---|---|
| `BK-1` | Automatic snapshots at defined points: before migrations, before recovery, before destructive operations, and on schedule |
| `BK-2` | Snapshots are self-consistent (taken transactionally, not by copying a live directory) |
| `BK-3` | Snapshots are verified — a snapshot that has never been restored is an unverified backup (`16` §3.1) |
| `BK-4` | Restore is a tested procedure with captured evidence |
| `BK-5` | Retention is configurable with a floor; snapshots covering an active release are not pruned |
| `BK-6` | Backups are local by default; any remote destination is an explicit owner action (`SC-POL-030`) |
| `BK-7` | Partial restore (a single project) is supported without affecting others |
| `BK-8` | Restore records what was restored, from when, and what was lost — restoring to an earlier point is itself an auditable event |

---

## 8. Project Isolation

| ID | Rule |
|---|---|
| `PI-1` | Each project's store is separate; no shared mutable state |
| `PI-2` | An agent run's filesystem and store scope never spans projects |
| `PI-3` | Cross-project knowledge flows **only** through the Organizational Learning interface (§8.1) |
| `PI-4` | A project's evidence, decisions, requirements and code never appear in another project's context bundle |
| `PI-5` | Deleting a project affects nothing else |

### 8.1 The Organizational Learning interface (`SC-POL-021`)

The single permitted cross-project channel, owned by `SC-DEPT-064`.

```
learn(query, new_project_context) -> CandidateItem[]

CandidateItem {
  kind        : PATTERN | LESSON | FAILED_APPROACH | RISK
  content     : generalized, no project-identifying detail
  origin      : anonymized reference
  context_applied      : where it worked
  context_not_applicable : where it did not
  status      : CANDIDATE                  # never DECIDED
}
```

- **OL-1** Items are always `CANDIDATE`. They inform evaluation; they never conclude it.
- **OL-2** Content is generalized. Raw requirements, code, evidence or client data never cross (`PI-4`).
- **OL-3** A Decision citing a candidate must include an `ApplicabilityAssessment` (`09` §4.1).
- **OL-4** The interface is read-only from the consuming project's side.

---

## 9. Retention

Append-only storage grows. Retention is governed so that growth is bounded without destroying auditability.

| Data | Retention |
|---|---|
| `T-CANON` (all versions) | Indefinite |
| Gate results, verdicts | Indefinite |
| Audit events | Indefinite |
| Agent run records (metadata) | Indefinite |
| Evidence content (large artifacts) | Configurable; **never pruned while bound to a valid verdict** |
| Engine session references | Short |
| Raw tool call payloads | Configurable |
| Workspace snapshots | Configurable with a floor |

- **RT-1** Pruning requires owner authorization and produces an audit record of what was pruned (`SC-POL-022` exception).
- **RT-2** Pruning never removes a record a valid verdict depends on. Where evidence content is pruned, its digest, provenance and metadata are retained, and the verdict is marked `EVIDENCE_CONTENT_PRUNED` — the claim remains auditable in structure even if the artifact is gone.
- **RT-3** Retention settings are `OWNER_CONFIGURABLE` with a protected floor (`12` §4).

---

## 10. Reconciliation (`SC-POL-032`)

`SC-WF-015`. Runs at session start, before gate evaluation, after recovery, and on demand.

```
reconcile(project):
    scan workspace within governed paths (minus ignore list)
    compute digests
    compare to stored Artifact records
    classify each divergence:
        EXPECTED       build output, caches, ignore-listed
        NEW_UNTRACKED  file added outside Serva
        MODIFIED       governed artifact changed outside Serva
        DELETED        governed artifact removed
        MOVED          digest match at a new path
    for MODIFIED/DELETED/MOVED governed artifacts:
        (dependent results now derive to STALE per 31 3.2; nothing is written)
        record divergence
    report to owner with disposition options
```

Disposition options: **adopt** (accept the change, record it as an owner-originated modification, re-verify), **revert** (restore the stored version), or **investigate** (open a work item).

- **RE-1** Divergence is never silently adopted. Adoption is an explicit owner act, because adopting means the store's account of how that artifact was produced is now incomplete.
- **RE-2** Unresolved divergence sets `DEGRADED` and blocks gates (`XC-7`).
- **RE-3** Ignore lists are per-project, recorded, and reviewable — an over-broad ignore list is how reconciliation quietly stops working.

---

## 11. Scheduler

Handles time-driven obligations that would otherwise be forgotten:

| Duty | Trigger |
|---|---|
| Expiry checks | `valid_until` on evidence, research, competitive position, waivers |
| Re-evaluation triggers | Decision conditions becoming true (`09` §10) |
| Stall detection | Work items, proposals, escalations past threshold (`SC-POL-033`) |
| Scheduled integrity checks | Interval |
| Scheduled backups | Interval |
| Long-running run supervision | Deadline enforcement |
| Budget threshold checks | Consumption crossing thresholds |

**Rule SC-1:** the scheduler produces **surfacings**, not autonomous actions. It never starts work, spends budget, or changes state on its own — it tells the Orchestrator and the owner that something needs attention. A background process that acts unattended on the owner's machine is outside the trust model (`28`).

---

## 12. Resource Governance

| Resource | Control |
|---|---|
| Concurrent runs | Configurable cap; default conservative |
| Engine consumption | Budgets at run/task/work-item/project (`SC-POL-028`) |
| Disk | Retention policy + growth monitoring + owner alert on threshold |
| CPU/memory | Bounded concurrency; long operations are interruptible |
| Network | Only for declared research scopes; default `NONE` (`19` §5) |
| Wall time | Run deadlines; long-running work is checkpointed, not open-ended |

---

## 13. Reproducibility

An `AgentRun` MUST be **reconstructible**: its inputs, contract version, context bundle, tool calls and outputs are all stored. Re-invoking would not necessarily produce identical output (models are non-deterministic), and Serva Code does not claim otherwise (`16` §10).

What reproducibility means here:

| Reproducible | Not reproducible |
|---|---|
| What the run was given | What the model would say next time |
| What it did (tool calls, denials) | Its internal reasoning |
| What it produced | — |
| What evidence was captured | — |
| Why a gate reached its verdict | — |

**Gate verdicts are fully reproducible**, because they are deterministic functions of stored state and evidence (`18` §1). This is the property that makes the governance layer auditable even though the execution layer is not — and it is the central reason the Orchestrator and gate engine are deterministic rather than model-driven (`04` §12).
