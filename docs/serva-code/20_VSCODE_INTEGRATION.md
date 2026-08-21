# 20 — VS CODE INTEGRATION

**Document ID:** SC-DOC-020
**Status:** BASELINE R4
**Type:** Normative / Interface Specification
**Owns:** Human surface model, governance visibility, information contracts, owner interaction points.
**Does not own:** Runtime storage (`21`), engine protocol (`19`), authority definitions (`28`).

**Phase 1 note:** no extension is implemented. This specifies surfaces, states and information contracts only.

---

## 1. Position

VS Code is the **primary human surface**. The AI chat is not.

```
   OWNER
     │
     ▼
┌────────────────────────────────────────────┐
│  VS CODE  ·  SERVA CODE SURFACE            │  ← the owner works here
│  state · next action · questions · evidence│
└──────────────────┬─────────────────────────┘
                   ▼
              SERVA CODE  (orchestration, governance, store)
                   ▼
              AI ENGINE   (one of Serva's capabilities, 19)
```

### 1.1 The confusion problem

The assignment names the core UX risk: *"is Claude working, or is Serva Code working?"* This is not cosmetic. If the owner cannot tell which system is acting, they cannot know whether governance applied, whether evidence exists, or whether state was recorded.

Resolution — three rules:

- **UX-1 · Attribution is always explicit.** Every action, output and message displays its actor: Serva Code (which department/agent), the AI engine under a role, or an ungoverned engine session the owner started themselves.
- **UX-2 · Governance state is always visible.** A governed project displays its governance state persistently, not on demand.
- **UX-3 · Ungoverned work is visibly ungoverned.** If the owner uses the AI engine directly, outside Serva Code, the result is **not** silently absorbed into project truth. It appears as a workspace divergence at reconciliation (`SC-POL-032`) and requires an explicit disposition.

UX-3 is the important one. The alternative — quietly adopting direct edits as governed work — would make every guarantee in this specification false, because it would mean the store's claims about how artifacts were produced could not be trusted.

---

## 2. Governance State

```
GovernanceState {
  value  : ACTIVE | INACTIVE | DEGRADED | SUSPENDED | UNKNOWN
  since  : timestamp
  basis  : what proves this state
}
```

| State | Meaning | Displayed as |
|---|---|---|
| `ACTIVE` | A valid store exists, integrity checks pass, workspace reconciled, capability enforcement is `HARD` | `SERVA GOVERNANCE = ACTIVE` |
| `DEGRADED` | Store present but with unresolved divergence, integrity warnings, stale critical verdicts, **or capability enforcement below `HARD`** (`33` PC-7) | `ACTIVE (DEGRADED)` + reason, e.g. `CAPABILITY_ENFORCEMENT: SOFT` |
| `SUSPENDED` | Owner explicitly paused governance | `SUSPENDED` + since when |
| `INACTIVE` | This workspace is not a Serva project | No governance indicator |
| `UNKNOWN` | Store unreadable or being recovered | `UNKNOWN — recovery required` |

**Rule GS-1:** the indicator is **derived from a real check**, never from a configuration flag. A badge that can display `ACTIVE` while the store is corrupt is worse than no badge, because it converts uncertainty into false confidence.

**Rule GS-2:** `DEGRADED` must state *what* is degraded and *what it blocks*. A warning without a consequence is ignored within a week.

---

## 3. Surfaces

Six surfaces. Each has a defined information contract — what it must be able to show, sourced from the store (`08` §8).

### 3.1 Project Status
Answers: *where is this project, and what happens next?*

| Element | Source |
|---|---|
| Governance state | §2 |
| Current stage(s) and profile | Stage ledger (`03` §10) |
| **Next action** (single, prominent) | `nextAction()` (`04` §9) |
| Blocked items and the blocking chain | `08` Q2 |
| Awaiting owner (count + urgency) | `08` Q3 |
| Health summary: unverified, stale, open risks, active waivers, budget | `08` Q6, Q10, Q17 |

**The next action is the single most important element in the entire interface.** It is what makes the system usable after three weeks away, and it is computable without an AI session (`R12`).

### 3.2 Work
Work items, features, tasks; state, department, dependencies, budget, blockers. Filterable by state and by what is stalled (`SC-POL-033`).

### 3.3 Assurance
Answers: *what do we actually know?*

| Element | Source |
|---|---|
| Gate results with verdicts and qualifications | `18` §4.2 |
| Evidence per verdict, with class and freshness | `16` §9 |
| **Unverified items** — first-class, not hidden in a report | `08` Q6 |
| Stale and expired verdicts | `SC-POL-031` |
| Traceability status and orphans | `08` §5.1 |
| Active waivers with expiry | `09` §9 |
| Test/defect/security/performance status | `15`, `17` |

**Rule AS-1:** `NOT_VERIFIED` and `PASS_WITH_QUALIFICATION` are displayed as visually distinct from `PASS`. Collapsing them into a green checkmark would defeat `16` §5.1 at the last step — the point where it matters most.

### 3.4 Decisions & Knowledge
Decisions with rationale and alternatives; ADRs; assumptions with validation status; the SSOT register; requirements with traceability; the competitive position; the configuration register and protected rules.

Answers `08` Q4 and Q15 — *why is it this way?* and *why does this win?*

### 3.5 Attention
Everything requiring the owner, in one place:

| Item | Must show |
|---|---|
| Questions | The question, why it blocks, **Serva's recommendation and reasoning**, cost of delay, what proceeds regardless (`04` §10) |
| Approvals | What is being approved, at what authority, what it unblocks, what it commits |
| Reserved actions | What is staged, what has been verified, what will happen (`28` §3) |
| Expert review required | The five mandatory fields (`05` §9.1) |
| Escalations | Type, question, options, recommendation |
| Proposal digests | Batched per `10` §7 |
| Divergence | What changed outside Serva, and the disposition options |

**Rule AT-1:** a question without a recommendation is a defect (`04` §10). Presenting the owner with an unrecommended engineering choice violates `SC-POL-001` at the interface layer, where all the upstream discipline is either honored or wasted. A **business-consequence question** — a recommended option plus the business trade-off of the alternatives — is required, not forbidden (`01` SC-POL-001 business-consequence clause). The surface MUST render the recommendation first and the alternatives as the trade-off, never as an undifferentiated menu.

**Rule AT-2:** approvals are captured explicitly through this surface. Consent is never inferred from a chat message, from silence, or from the owner continuing to work (`09` §8 AP-4).

### 3.6 Activity
The live and historical record: current runs (agent, role, task, elapsed, consumption), the run history with inputs and outputs, tool calls including denials, audit events, and consumption against budget.

It also displays, persistently (`33` PC-13, `SC-POL-035`): the **capability enforcement class** in force (`HARD` / `SOFT` / `NONE`), the **provider authentication route** in use, and the **usage and billing mode**. The owner must never be uncertain about which route their work is running through or how it is being counted.

**Rule AC-1:** the owner can always see what is running right now and stop it. An autonomous system the owner cannot interrupt is not acceptable on their own machine.

---

## 4. Editor Integration

| Integration | Behavior |
|---|---|
| Governed file indicator | Files under governance are marked; ungoverned files in the workspace are visibly not governed |
| Requirement/decision linkage | Where an artifact links to a requirement or decision, that link is reachable from the file |
| Scope indication | During an active run, the files within the current task's write scope are indicated |
| Divergence marking | Files changed outside Serva are marked pending reconciliation |
| Design/config lint surfacing | Token violations, hard-coded strings, unregistered configurable values surface as diagnostics in-editor, not only at review |
| Protected-rule marking | Code implementing a `ProtectedRule` is marked, so a future edit is a deliberate act |

The last row is a small feature with outsized value: it puts `12` §5 in front of the person most likely to accidentally weaken it.

---

## 5. Commands

Minimum command surface:

| Command | Effect |
|---|---|
| Initialize project | Create the store; run intake |
| Show status / next action | Project Status surface |
| Submit request | Enter a request; classification is shown before work begins |
| Answer question / grant approval | Attention surface |
| Run gate | Evaluate a gate on demand |
| Reconcile workspace | `SC-WF-015` |
| Show evidence for… | Evidence chain for a verdict (`16` §9) |
| Show why… | Decision rationale for an artifact |
| Show impact of… | `08` Q14 |
| Raise proposal | Owner-originated proposal |
| Pause / resume governance | With recorded reason |
| Stop run | Terminate an in-flight run |
| Export handover package | `23` §5 |
| Backup / restore store | `21` §7 |

**"Show classification before work begins" is deliberate.** It gives the owner a cheap moment to correct a misclassification (`04` OF-1/OF-2) before the cost of a wrong profile is incurred.

---

## 6. Notifications

| Event | Urgency |
|---|---|
| Owner input required and work is blocked | High |
| Reserved action ready | High |
| `EXPERT_REVIEW_REQUIRED` | High |
| V1 violation (fabricated evidence, scope violation, boundary crossed) | High |
| Security `CRITICAL`/`HIGH` finding | High |
| Budget threshold reached | High |
| Gate FAIL requiring a decision | Medium |
| Rework loop detected | Medium |
| Work item stalled | Medium |
| Long-running run completed | Low |
| Proposal digest | Low, batched |
| Time-bound evidence expiring soon | Low |

**Rule NT-1:** notification volume is itself a health metric. An owner who stops reading notifications has lost the interface to `SC-POL-008` and `SC-POL-012` simultaneously — the two policies that depend entirely on the owner actually seeing something.

---

## 7. Information Contracts

Every surface element is **derived from the store**. No surface may compute, cache or infer a state the store does not hold.

- **IC-1** UI reads through the store's query interface (`08` §8). It never reads product files to determine governance state.
- **IC-2** A surface unable to source an element shows `UNKNOWN`, never a plausible default. A UI that guesses is a UI that lies.
- **IC-3** Every displayed verdict shows its freshness and its evidence class.
- **IC-4** Every displayed claim is traceable to its record with one interaction.
- **IC-5** The UI never invokes the engine to answer a state question. `R12` requires state answerable from the store alone — the UI is where that requirement is proven true or false in practice.

---

## 8. Multi-Project

One VS Code workspace maps to one Serva project by default. Rules:

- **MP-1** Projects are isolated (`21` §8). No surface shows another project's data except through the Organizational Learning interface, marked `CANDIDATE` (`SC-POL-021`).
- **MP-2** A cross-project view (if provided) shows state and attention items only, never content.
- **MP-3** Switching projects switches the entire governance context; there is no partial or blended state.

---

## 9. Degraded Operation

| Condition | Behavior |
|---|---|
| Store unreadable | `UNKNOWN`; only recovery commands offered; no work dispatched |
| Store integrity failure | `DEGRADED`; affected areas marked; gates depending on them blocked |
| Engine unavailable | State, history and evidence remain fully browsable; dispatch disabled with the reason shown |
| Workspace diverged | `DEGRADED`; reconciliation offered; gates blocked (`XC-7`) |
| Run stuck | Surfaced with elapsed time and a stop control |

**Rule DG-1:** Serva Code is fully useful in read mode with no engine available. Everything the owner needs to *understand* their project comes from the store. Only *new work* requires the engine.

This property is the practical test of `SC-POL-020`: if the interface goes blank when the AI is unavailable, project memory was never really independent of it.
