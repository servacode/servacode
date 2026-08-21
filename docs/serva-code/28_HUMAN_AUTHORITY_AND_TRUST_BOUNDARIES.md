# 28 — HUMAN AUTHORITY AND TRUST BOUNDARIES

**Document ID:** SC-DOC-028
**Status:** BASELINE R4
**Type:** Normative / Protective
**Derived:** YES — added in Phase 1.
**Owns:** Owner-reserved actions, trust points, approval boundaries, the trust model of Serva Code's own execution.
**Does not own:** Policy text (`01`), product security design (`17`).

**Why this document exists:** the assignment asks Phase 1 to discover trust points and human approval boundaries. Those boundaries are referenced by `SC-POL-030` and by nearly every runtime rule. They need one authoritative location, and they need to be constitutional rather than configurable — otherwise autonomy grows by default until something irreversible happens.

---

## 1. The Trust Question

Serva Code runs autonomously on the owner's machine, with filesystem access, command execution, and network capability, driven by a non-deterministic model that reads untrusted content.

Three questions must be answered explicitly:

1. **What can it do without asking?**
2. **What must it never do?**
3. **What does it trust, and how much?**

The organizing principle:

> **Autonomy is bounded by reversibility.**
> The less reversible an action, the higher the authority required. Actions that cannot be undone require a human, permanently.

This is not caution for its own sake. It follows from `07` §5.1: the compensation model can undo store changes and workspace changes. It cannot undo anything that left the machine, spent money, or reached another person.

---

## 2. Authority Tiers (recap)

| Tier | Holder | Authority |
|---|---|---|
| **T0** | Owner (human) | Business authority, constitutional amendment, reserved actions, risk acceptance, waivers |
| **T1** | Governance & Orchestration | Process authority within the constitution |
| **T2–T4** | Definition, Design, Production | Domain authority within their contracts and magnitude ceilings |
| **T5** | Assurance | Verdict authority; overridable only by owner-recorded risk acceptance |
| **T6** | Operation | Operational authority within owner-approved bounds |

Full structure: `02` §2. Approval matrix: `09` §2.

---

## 3. Owner-Reserved Actions

`SC-POL-030`. **No agent may perform these under any configuration.** They are not gated, not approvable per-instance by an agent, and not delegable — the owner may not grant them to an agent even by explicit instruction, because such an instruction cannot be distinguished from an injected one (`SC-POL-027`) and because the whole point is a floor that does not move.

Serva Code MAY prepare, stage, verify and recommend every one of these. It may not execute them.

### 3.1 Irreversible external effects

| # | Action |
|---|---|
| R-01 | Deploying to a production environment |
| R-02 | Applying migrations to production data |
| R-03 | Deleting or overwriting production data |
| R-04 | Any destructive operation on real user data |
| R-05 | Disabling or bypassing a production security control |
| R-06 | Purging backups or audit records beyond the retention floor |

### 3.2 Money

| # | Action |
|---|---|
| R-07 | Incurring a financial commitment (subscriptions, paid APIs, cloud resources, domains, certificates) |
| R-08 | Executing a real payment or financial transaction |
| R-09 | Accepting terms of service or a license agreement |

### 3.3 Communication and publication

| # | Action |
|---|---|
| R-10 | Sending communication to any third party (email, message, notification, ticket, post) |
| R-11 | Publishing to a public repository, registry, or app store |
| R-12 | Making a private artifact publicly accessible |
| R-13 | Transmitting project data to any external service beyond the declared research scope |

### 3.4 Credentials and identity

**Refined in R2 (Correction 12).** R1's wording — "using a real credential" — would have made ordinary operation impossible, because invoking the owner's already-authenticated local tooling technically "uses" a credential. That reading would have banned Serva Code from doing the one thing it exists to do. The protection was right; the boundary was drawn in the wrong place.

R2 defines three credential classes. Only Class A is reserved.

| Class | Definition | Disposition |
|---|---|---|
| **A — Real external/production credentials** | Any credential, key, token or certificate that authenticates to a production, paid, or externally-consequential system | **Reserved.** Never created, read, stored, transmitted or used by an agent |
| **B — Pre-authorized local tooling** | A local process the owner has already authenticated (the AI engine itself; a version-control client using the owner's existing credential helper), invoked through an approved tool grant | **Permitted**, under the conditions below |
| **C — Disposable non-production credentials** | Ephemeral credentials for a local test or sandbox environment that cannot reach a paid or production system | **Permitted**, under the conditions below |

| # | Reserved action |
|---|---|
| R-14 | Creating, reading, storing, transmitting, logging or embedding a **Class A** credential value |
| R-15 | Authenticating **as the owner** to an arbitrary external service — that is, initiating a new authentication, or directing an authenticated session to a service outside the approved tool grant |
| R-16 | Modifying access control on a real system |
| R-17 | Generating or installing certificates for real use |
| R-32 | Escalating a Class B invocation into Class A reach — using pre-authorized local tooling to touch a production or paid system |

*(Numbered R-32 because R-18 … R-31 are already assigned in §3.5–§3.7; reserved-action identifiers are permanent and never reused.)*

**Conditions on Class B (all required):**

| # | Condition |
|---|---|
| `CR-1` | The tool is named in the agent's tool grant with its permitted operations and scope (`19` §5) |
| `CR-2` | **The credential value never enters a context bundle.** The agent invokes a capability; it never sees a secret |
| `CR-3` | The tool's reach is bounded to non-production targets by the grant, and enforced by the runtime |
| `CR-4` | Every invocation is recorded, including denials |
| `CR-5` | The owner can see which pre-authorized tools are reachable by agents, and revoke any of them |

**Conditions on Class C (all required):** generated for a named ephemeral environment; expiring; never reused across environments; never able to reach an external paid or production system; recorded; and — because a test credential that reaches something real is simply a Class A credential with a misleading name — verified as unreachable before use.

**What did not change:** agents still never see secret values, never create real credentials, never transmit credentials, never mutate production credentials, and never authenticate the owner to a service outside an approved grant. The relaxation is precisely and only this: *Serva Code may invoke a local tool the owner has already authenticated, through a bounded grant, without ever handling the credential itself.*

### 3.5 Legal and representational

| # | Action |
|---|---|
| R-18 | Making a compliance or conformance claim on the owner's behalf |
| R-19 | Committing to a contractual obligation |
| R-20 | Making a public statement attributed to the owner |

### 3.6 Serva Code's own integrity

| # | Action |
|---|---|
| R-21 | Amending the constitution |
| R-22 | Modifying, deleting or reordering `T-TRACE` records |
| R-23 | Granting itself or another agent capability beyond a contract |
| R-24 | Waiving a policy or overriding a gate |
| R-25 | Disabling reconciliation, integrity checking, or audit |
| R-26 | Deleting a project or its store |
| R-27 | Pruning evidence bound to a valid verdict |

### 3.7 Outside the workspace

| # | Action |
|---|---|
| R-28 | Writing outside the project workspace and store, except to declared temporary locations |
| R-29 | Modifying system configuration, environment variables, or installed software outside the project |
| R-30 | Starting long-lived background processes that outlive the run |
| R-31 | Modifying another Serva project |

### 3.8 Enforcement

- **RE-1** Enforced by the runtime, independent of agent contract content (`19` TR-5). A contract requesting a reserved capability is itself a defect.
- **RE-2** No configuration setting can enable them. There is no flag.
- **RE-3** An attempt is an `AuditEvent` and a V1 violation, whether or not it succeeded.
- **RE-4** They remain reserved during incidents (`23` IN-2). The delay is a recorded, accepted cost.
- **RE-5** They remain reserved when the owner instructs otherwise in a prompt. Instruction is not authorization; the owner authorizes by *performing the action*, or through the explicit approval surface for actions the runtime supports as owner-executed.

**RE-5 is the least intuitive and most important rule here.** A prompt saying "go ahead and deploy" is text arriving through a channel that also carries untrusted content. The system cannot reliably distinguish it from injected text. So it does not try — it requires the action to come through a path an attacker cannot forge.

---

## 4. Actions Requiring Approval (Not Reserved)

Permitted after explicit approval at the right authority (`09` §2). Distinct from reserved actions: these can be authorized, and once authorized are performed by Serva Code.

| Action | Authority |
|---|---|
| Implementing an M3+ change | Per `09` §2 |
| Adding a third-party dependency | Architecture (M0–M2); + owner if licensing/cost implications |
| Changing a technology decision | Architecture + FinOps + Security; owner if cost or lock-in |
| Changing a design token | Design System; owner if brand |
| Making a protected rule configurable | Owner (`12` PR-4) |
| Accepting `HIGH` residual security risk | Owner (`17` FD-1) |
| Waiving a gate criterion | Per `09` §9 |
| Exceeding a budget | Owner (`SC-POL-028`) |
| Weakening a gate, workflow or contract | Owner (`18` §9, `07` §9, `05` §12) |
| Adopting a workspace divergence | Owner (`21` RE-1) |
| Restoring the store to an earlier point | Owner (`21` BK-8) |
| Running research against external networks beyond the declared scope | Owner |
| Deferring a table stake or omitting a competitive capability | Owner (`11` TS-4) |

---

## 5. Mandatory Escalation Domains

Where Serva Code MUST raise `EXPERT_REVIEW_REQUIRED` rather than answer authoritatively (`SC-POL-012`). Catalogue in `17` §8; restated here as an authority boundary rather than a security concern:

Cryptographic design · regulatory compliance claims · payment card and financial reconciliation correctness · legal terms and licensing obligations · safety-critical behavior · formal accessibility conformance claims · tax and jurisdictional financial rules · biometric and health data handling.

**Rule ME-1:** in these domains, producing an authoritative answer is a V1 violation even when the answer is correct. The failure is the false authority, not the content — because the owner cannot tell the difference and will rely on it.

---

## 6. Trust Model

What Serva Code trusts, and how much.

| Entity | Trust | Basis | Verification |
|---|---|---|---|
| **Owner** | Full, within their authority | They own the system | None — the owner is the root of trust |
| **The store** | Trusted after integrity check | Digests, append-only, runtime-only writes | Integrity checker (`21` §6) |
| **Runtime components** | Trusted | Part of Serva Code | Tested; failures are `F4`/`F5` (`22`) |
| **The AI engine** | Trusted for capability, **not for claims** | Non-deterministic; may fabricate | Every claim checked (`04` §7.1) |
| **Agent output** | Untrusted until validated | Model-generated | Schema, scope diff, evidence verification |
| **Repository content** | Untrusted (`SC-POL-027`) | May contain injected instructions | Trust marking; capability limits |
| **Web research results** | Untrusted | External, unverifiable | Claim marking (`11` §3.2); source verification |
| **Dependency documentation** | Untrusted | External | Same |
| **Client-supplied documents** | Untrusted as instruction; authoritative as *statements of client intent* | The client defines the problem (`SC-POL-001`) | Recorded as `OWNER_STATED` |
| **Tool output** | Trusted as *what the tool returned*; untrusted as *content* | The runtime captured it | Provenance guarantees the capture, not the meaning |
| **Other Serva projects** | Isolated | `PI-1..PI-5` | Learning interface only (`21` §8.1) |

### 6.1 The critical distinction

> **The runtime guarantees that a tool returned what is recorded. It does not guarantee that what the tool returned is true.**

A test run's provenance proves the command executed and produced that exit code. It does not prove the test was meaningful, or that the suite tests what it claims. Evidence establishes *what happened*, and separate mechanisms — test derivation rules (`15` §4.1), coverage against acceptance criteria, independent review — establish *whether what happened means anything*.

Conflating these two would be the most sophisticated way for this system to fool itself, and it is why `16` §10 exists.

---

## 7. Trust Boundaries in Serva Code's Own Architecture

```
┌──────────────────────────────────────────────────────────┐
│ OWNER                                    ROOT OF TRUST   │
└──────────────────────┬───────────────────────────────────┘
                       │ explicit approval surface (not prompts)
┌──────────────────────▼───────────────────────────────────┐
│ SERVA RUNTIME              TRUSTED                       │
│  orchestrator · gate engine · store · lock manager ·     │
│  evidence capturer · audit writer · tool mediator        │
└──────────────────────┬───────────────────────────────────┘
                       │ ══ CAPABILITY BOUNDARY ══  (SC-POL-026)
                       │    allowlist · fs scope · net scope
┌──────────────────────▼───────────────────────────────────┐
│ AI ENGINE                  SEMI-TRUSTED                  │
│  trusted to generate · not trusted for claims            │
└──────────────────────┬───────────────────────────────────┘
                       │ ══ VALIDATION BOUNDARY ══
                       │    schema · scope diff · evidence check
┌──────────────────────▼───────────────────────────────────┐
│ AGENT OUTPUT               UNTRUSTED UNTIL VALIDATED     │
└──────────────────────┬───────────────────────────────────┘
                       │
┌──────────────────────▼───────────────────────────────────┐
│ EXTERNAL CONTENT           UNTRUSTED ALWAYS              │
│  repo files · web · docs · third-party output            │
└──────────────────────────────────────────────────────────┘
```

Two boundaries, two purposes:

- The **capability boundary** limits what damage is possible.
- The **validation boundary** limits what falsehood is recordable.

Neither alone is sufficient. Capability without validation permits a well-behaved agent to record false claims. Validation without capability permits a misled agent to do real harm before validation runs.

---

## 8. Owner Interaction Requirements

| ID | Requirement |
|---|---|
| `OI-1` | Every owner decision point states the question, why it blocks, Serva's recommendation and reasoning, the cost of delay, and what proceeds regardless (`04` §10) |
| `OI-2` | Approval is captured explicitly through the approval surface, never inferred from silence, from a chat message, or from continued work (`09` AP-4) |
| `OI-3` | Approvals bind to a specific version and expire if unacted (`09` AP-1, AP-5) |
| `OI-4` | Reserved actions are presented with what is staged, what was verified, and what will happen |
| `OI-5` | Serva never *delegates* an engineering or design decision to the owner. Where technically valid alternatives carry materially different business consequences, Serva performs the analysis, recommends an option, explains the consequences, and asks only for the business trade-off or the authorization (`SC-POL-001` business-consequence clause, `SC-POL-003`) |
| `OI-6` | Notification volume is a health metric; overwhelming the owner is a system failure (`20` NT-1) |
| `OI-7` | The owner can stop any run at any time (`20` AC-1) |
| `OI-8` | The owner can inspect the store without Serva Code running (`ST-2`) |

`OI-8` is the ultimate trust guarantee: **the owner is never locked inside the system's own account of itself.** If Serva Code were to become untrustworthy, its records would still be readable by other means.

---

## 9. Degradation of Trust

| Signal | Response |
|---|---|
| Evidence fabrication detected | V1; halt; revoke dependent verdicts; investigate the enforcement gap (`22` §5.3) |
| Repeated scope violations by one contract | Contract review; narrow capability; possible suspension of that agent |
| Injection attempt detected | Record; trace the source; review the context construction path |
| Integrity failure | `DEGRADED`; block affected gates; recover |
| Gate erosion trend | Governance report to owner (`18` §7) |
| Systemic contract failures | Constitutional amendment proposal (`SC-DEPT-064`) |

**Rule TD-1:** trust is narrowed by reducing capability, never by adding stronger instructions. Instruction is the weakest layer (`05` §8 L5); a system that responds to misbehavior by writing firmer prompts has learned nothing.

---

## 10. What This Document Cannot Guarantee

Stated plainly, in keeping with `16` §10:

| Cannot guarantee | Why |
|---|---|
| That the engine never produces harmful output | Only that its capability to act on it is bounded |
| That injection never succeeds | Only that a successful injection is capability-limited and leaves a trace |
| That the owner reads what they are shown | No technical control exists for attention |
| That an owner-approved action was well-understood | Approval quality is a human matter; Serva can only present clearly |
| That reserved actions are never performed | Only that **Serva Code** never performs them; the owner can do anything |
| That trust boundaries survive future convenience pressure | Only that weakening them requires a constitutional amendment (`09` §2), which is a visible, recorded act |

The last row is the honest one. Every boundary in this document can be removed by an owner who decides the friction is not worth it. What the design guarantees is that removing one is **a deliberate, recorded, reviewable decision** rather than something that happens by default, by accident, or by a prompt.
