# 23 — OPERATIONS AND RELEASE

**Document ID:** SC-DOC-023
**Status:** BASELINE R4
**Type:** Normative / Process
**Owns:** Release readiness and process, operational readiness scoping, handover, operations, incident management, continuous improvement loop.
**Does not own:** Serva Code's own failures (`22`), gate mechanics (`18`), security testing (`17`).

---

## 1. Mandate

`SC-POL-019`: a product is not complete because its features work. Operational readiness is a release criterion, not a follow-up.

This document covers the **product's** operation, not Serva Code's runtime.

---

## 2. Operational Readiness Scoping

Every dimension receives a disposition. **Silence is not scoping.**

```
OperationalReadiness {
  project_ref, release_ref,
  dimensions : [ { dimension, disposition: IN_SCOPE | NOT_APPLICABLE(reason),
                   requirement, evidence_ref, verified: bool } ]
}
```

| # | Dimension | Typical `NOT_APPLICABLE` case |
|---|---|---|
| 1 | Logging | Never — even a local tool logs errors |
| 2 | Log retention & rotation | No persistent logs |
| 3 | Metrics | Single-user local tool with no operational questions |
| 4 | Error tracking | — |
| 5 | Health checks | Not a service |
| 6 | Monitoring | Not a service |
| 7 | Alerting | No one to alert / no operational SLO |
| 8 | Backup | No persistent data |
| 9 | **Restore (tested)** | No backup in scope |
| 10 | **Rollback (tested)** | Immutable/replaceable deployment |
| 11 | Disaster recovery | Bounded by data value; must be argued |
| 12 | Incident procedure | No production operation |
| 13 | Versioning | Never — every release has a version |
| 14 | Release notes | Never |
| 15 | Runbooks | No operational procedures exist |
| 16 | Configuration documentation | No configuration |
| 17 | Diagnostic capability | Never (`12` §6) |
| 18 | Dependency currency process | No third-party dependencies |
| 19 | Data retention execution | No retained data |
| 20 | Capacity / quota awareness | No external quotas or limits |

Dimensions 2, 9, 10, 17, 18, 19, 20 are **DERIVED**. Rationale: the assignment lists backup and rollback as capabilities but not as *tested* capabilities — untested backup and untested rollback are the two most common false assurances in software operations. Log retention, dependency currency, retention execution and quota awareness are omitted from most readiness lists and each is a recurring source of production failure.

**Rule OR-1:** dimensions 9 and 10 require **executed** evidence (`16` S1), not a documented procedure. A rollback plan that has never been run is a hypothesis.

---

## 3. Release Process (`SC-WF-010`)

```
 1  Scope the release            features/fixes with non-stale acceptance
 2  Verify acceptance freshness  SC-POL-031 — re-verify anything stale
 3  Operational readiness        every dimension dispositioned and evidenced
 4  Security posture             open findings, accepted risks re-surfaced (17 FD-3)
 5  Rollback test                executed, evidence captured
 6  Backup verification          executed restore where in scope
 7  Version assignment           per the versioning decision
 8  Release notes                content, known limitations, active waivers
 9  Handover package             §5
10  Release Gate                 SC-GATE-RELEASE
11  Go/no-go recommendation      Release Management -> Owner
12  OWNER EXECUTES THE RELEASE   SC-POL-030 — reserved
13  Post-release verification    smoke checks, evidence captured
14  Record deployment            who, when, what, outcome
```

**Step 12 is absolute.** Serva Code prepares, stages, verifies and recommends. It does not deploy to production. Rationale (`07` §5.1): production deployment is not compensatable — the set of actions that cannot be undone is precisely the set that must not be automated.

### 3.1 Release content rules

- **RL-1** Only work with a fresh `PASS`/`PASS_WITH_QUALIFICATION` acceptance verdict may be included.
- **RL-2** Qualifications, waivers and accepted risks appear in the release notes. The owner sees what they are shipping, including its assurance shape (`16` §5.1).
- **RL-3** A release with an unmet blocking criterion cannot be recommended, only escalated with an explicit risk statement.
- **RL-4** Partial releases declare what was excluded and why.

---

## 4. Release Gate Criteria (summary)

Full mechanics in `18`.

| # | Criterion | Evidence |
|---|---|---|
| 1 | All included work has fresh acceptance | Verdicts, freshness |
| 2 | Operational readiness fully dispositioned | Readiness record |
| 3 | Every `IN_SCOPE` dimension evidenced | Per-dimension evidence |
| 4 | Rollback tested (or `NOT_APPLICABLE` justified) | S1 executed rollback |
| 5 | Restore tested (or `NOT_APPLICABLE` justified) | S1 executed restore |
| 6 | No open `CRITICAL` security finding; `HIGH` accepted by owner | Findings + acceptances |
| 7 | No open `CRITICAL` defect | Defect register |
| 8 | Competitive position current | `11` §6.2 CP-3 |
| 9 | Handover package complete | Package |
| 10 | Version and release notes present | Artifacts |
| 11 | Active waivers listed and unexpired | Waiver register |
| 12 | Cross-cutting criteria `XC-1..XC-11` | `18` §3.1 |

---

## 5. Handover

Handover is a work product of `SC-STAGE-050` RELEASE, not a separate stage — the package is composed *before* the Release Gate evaluates it (§4 criterion 9). It applies even when the owner is the only party, because their future self has none of this context (`03` §1.5, `03` §6).

| Section | Contents |
|---|---|
| **What this is** | Problem, goals, audience, competitive position |
| **How it is built** | Architecture summary, module responsibilities, technology choices |
| **Why it is built this way** | Key decisions with rationale and re-evaluation triggers |
| **Data** | Model, classification, retention, migration history |
| **Security** | Risk class, threat model summary, accepted risks, protected rules |
| **How to run it** | Environments, deployment, configuration, secrets handling **instructions** (never secrets) |
| **How to operate it** | Runbooks, monitoring, alerts, health checks, diagnostics |
| **What you can change** | Configuration register: what is owner-configurable and what is protected, with reasons (`12` §5 PR-5) |
| **What to do when it breaks** | Incident procedure, rollback, restore, escalation |
| **What is not done** | Known limitations, deferred items, active waivers, unvalidated assumptions, `NOT_VERIFIED` areas |
| **Where the truth lives** | The Serva store, how to query it, how to back it up |

**Rule HO-1:** the "what is not done" section is mandatory and specific. A handover that presents only what works is the most common form of dishonest delivery, and it converts every known gap into a future surprise.

---

## 6. Incident Management

Owned by `SC-DEPT-062`; lifecycle stage `SC-STAGE-054`; workflow `SC-WF-011`.

### 6.1 Severity

| Severity | Definition | Owner notification |
|---|---|---|
| `SEV1` | Unavailable, data loss, or active security exposure | Immediate |
| `SEV2` | Major function broken; no workaround | Immediate |
| `SEV3` | Degraded; workaround exists | Within the working period |
| `SEV4` | Minor operational issue | Batched |

### 6.2 Process

```
 1  Detect / receive
 2  Classify severity            (upward under uncertainty)
 3  Notify owner                 per threshold
 4  Contain                      stop the harm — may precede diagnosis
 5  Restore                      service or a safe degraded mode
 6  Verify restoration           with captured evidence, not assumption
 7  Root cause                   by an actor other than the responder (02 §6)
 8  Corrective actions           as governed work items, never silent fixes
 9  Post-incident review
10  Retroactive records          every process relaxation used during response
11  Lesson capture               -> SC-DEPT-064
12  Close                        SC-GATE-INCIDENT_CLOSURE
```

### 6.3 Rules

- **IN-1** Containment may precede diagnosis. Stopping harm outranks understanding it.
- **IN-2** Owner-reserved actions remain reserved during an incident (`SC-POL-030`). If containment requires one, Serva prepares it and waits — and the wait is recorded as part of the timeline. This is a deliberate, accepted cost of the trust model.
- **IN-3** Every relaxation is recorded retroactively. Unrecorded emergency shortcuts are how emergency practice becomes normal practice.
- **IN-4** Root cause is recorded or explicitly `ROOT_CAUSE_UNDETERMINED`. An undetermined root cause keeps the incident's corrective work open.
- **IN-5** The responder does not author the root-cause conclusion alone (self-exoneration bias, `02` §6).
- **IN-6** Corrective actions enter the normal governed path. An incident does not authorize ungoverned change beyond containment.
- **IN-7** Security incidents follow `17` §9 in parallel with this process.

### 6.4 Post-incident review

Contents: timeline with timestamps; impact (users, data, duration); detection (how, how long); response (what worked, what did not); root cause including contributing factors; **what would have prevented it**; **what would have detected it sooner**; corrective actions with owners; lessons.

**Rule PI-1:** the review examines the system and the process, not the actor. In an AI-driven organization, "the agent made a mistake" is never a root cause — the root cause is the missing control, the missing context, or the missing specification that allowed the mistake to have effect.

---

## 7. Operations

Owned by `SC-DEPT-061`. Continuous stage (`SC-STAGE-052`).

| Duty | Requirement |
|---|---|
| Monitoring | Signals demonstrated, not merely configured (`16` S1) |
| Alerting | Every alert has a runbook and a defined response; alerts nobody acts on are removed |
| Health checks | Meaningful — they verify function, not process liveness |
| Backup verification | On schedule, with executed restore evidence |
| Dependency currency | Periodic vulnerability re-scan; findings enter the normal path |
| Certificate/credential expiry | Tracked with lead time |
| Quota/capacity | Tracked against external limits |
| Log hygiene | Retention enforced; no sensitive data (`IM-12`) |
| Runbook currency | Reviewed after each incident that used one |
| Health review | Periodic: metrics, incidents, debt, risks → improvement proposals |

**Rule OP-1:** "monitoring exists" is not evidence. A demonstrated signal is (`06` SC-DEPT-061 refusal surface).

**Rule OP-2:** an alert with no runbook is an incomplete alert. It will fire at an inconvenient moment and produce panic instead of response.

---

## 8. Continuous Improvement Loop

```
OPERATIONS ─► signals (metrics, incidents, defects, feedback, competitive changes)
     ▼
CONTINUOUS IMPROVEMENT ─► analysis ─► Proposals (10)
     ▼
GOVERNANCE ─► assessment ─► decision ─► prioritization
     ▼
LIFECYCLE ─► re-entry at the stage that owns the affected truth (10 §9)
     ▼
KNOWLEDGE ─► lessons, patterns, failed approaches (SC-DEPT-064)
```

- **CI-1** Improvements are Proposals, never direct work (`06` SC-DEPT-063).
- **CI-2** Re-entry is at the owning stage, not at implementation — a change to a business rule re-enters at BUSINESS_ANALYSIS.
- **CI-3** Every improvement cites a measurement, an incident, a defect pattern, or a clearly argued problem.
- **CI-4** Technical debt is tracked as `HYGIENE`-class proposals (`10` §3) so it competes on its own terms rather than losing silently to features.

---

## 9. Versioning

Versioning strategy is a recorded decision per project (`09`), covering: scheme, what constitutes a breaking change for *this* product, how versions map to releases, and how consumers are informed.

- **VS-1** Every release has a version. No unversioned deployment.
- **VS-2** The version is discoverable at runtime and appears in diagnostics and support output.
- **VS-3** Breaking changes are identified against the product's declared compatibility surface, not by intuition.

---

## 10. Failure Modes

| ID | Failure | Countermeasure |
|---|---|---|
| `OR-1` | Released with untested rollback | Gate criterion 4, executed evidence |
| `OR-2` | Backup exists but restore never verified | Gate criterion 5 |
| `OR-3` | Monitoring configured, never signals | OP-1 demonstrated-signal requirement |
| `OR-4` | Handover omits known gaps | HO-1 mandatory section |
| `OR-5` | Incident closed without root cause | IN-4 |
| `OR-6` | Emergency shortcuts become normal | IN-3 retroactive records; department separation (`02` §3) |
| `OR-7` | Accepted risks forgotten across releases | `17` FD-3 re-surfacing |
| `OR-8` | Release includes stale acceptance | RL-1 + `XC-1` |
| `OR-9` | Alert fatigue | OP-2 runbook requirement; unused alerts removed |
| `OR-10` | Improvement work never scheduled | CI-4 `HYGIENE` class visibility |
| `OR-11` | Post-incident review blames the agent | PI-1 — root cause is the missing control |
| `OR-12` | Operator cannot diagnose without a developer | `12` §6 diagnostics; readiness dimension 17 |
