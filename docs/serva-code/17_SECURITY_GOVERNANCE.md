# 17 — SECURITY GOVERNANCE

**Document ID:** SC-DOC-017
**Status:** BASELINE R4
**Type:** Normative / Process
**Owns:** Security across the lifecycle, risk classification, threat modeling, security-sensitive surfaces, mandatory expert domains, expedited security path.
**Does not own:** Serva Code's own runtime trust boundaries (`28`, `21`), evidence mechanics (`16`).

---

## 1. Mandate

`SC-POL-018`: security is exercised from Requirements onward, not as a pre-release scan.

Two departments, deliberately separated (`SC-POL-006`):

| | Design authority | Verification |
|---|---|---|
| Department | `SC-DEPT-022` Security Architecture (Tier 3) | `SC-DEPT-052` Security Testing (Tier 5) |
| Produces | Threat model, auth design, controls, residual risk | Findings, verdicts, evidence |
| Cannot | Verify its own design | Design the fix it demands |

---

## 2. Security Across the Lifecycle

Security is not one stage. It has an obligation at each of these points, and each obligation has an owner and an artifact.

| Stage | Security obligation | Artifact |
|---|---|---|
| INTAKE | Identify regulated data, compliance context, security-relevant constraints | `Constraint[]` |
| DISCOVERY | Identify who the adversaries are and what they want | Input to threat model |
| BUSINESS_ANALYSIS | Roles and permissions in business terms; sensitive operations | `Actor[]`, `Role[]` |
| REQUIREMENTS | Security requirements as first-class requirements | `Requirement[]` |
| NFR | Security NFRs with measurable targets | `SecurityNFR[]` |
| ARCHITECTURE | Trust boundaries, control placement, blast-radius containment | `ArchitectureModel` |
| DATA_ARCHITECTURE | Classification, retention, deletion, encryption posture | `DataClassification[]` |
| SECURITY_ARCHITECTURE | Threat model, auth design, authorization model, secrets, privacy | `ThreatModel` et al. |
| TECHNOLOGY_SELECTION | Security posture of each candidate; known vulnerability history | `TechnologyEvaluation` |
| UX | Security-usability: consent, disclosure, error messages that do not leak | `Flow[]` |
| ADMIN_OPERABILITY | Configuration as an attack surface; protected rules | `ProtectedRule[]` |
| PLANNING | Security tasks scheduled, not deferred | `Task[]` |
| IMPLEMENTATION | Secure coding standards; no secrets; validated input | Code + scan evidence |
| CODE_REVIEW | Security dimension (`14` §7.1 dim. 8) | Findings |
| SECURITY_TESTING | Verification against the threat model | Verdicts + evidence |
| ACCEPTANCE | No unresolved `HIGH`+ findings without owner-recorded acceptance | Acceptance verdict |
| RELEASE | Secrets handling, environment hardening, rollback safety | Release evidence |
| OPERATIONS | Monitoring for security events; dependency currency | Operational evidence |
| INCIDENT | Security incident path (`23` §6) | Incident record |

**Rule:** each row is either executed or explicitly `NOT_APPLICABLE(reason)` per the project's risk class. Silence is not scoping.

---

## 3. Project Security Risk Classification

Depth is scaled by risk. The classification itself is mandatory (`SC-POL-018` exception clause) and is a recorded Security decision.

| Class | Criteria (any) | Depth |
|---|---|---|
| `R0 — MINIMAL` | No persistent data, no auth, no network input, no personal data, single local user | Threat model: brief. Testing: dependency + secrets scan |
| `R1 — LOW` | Local data, no personal data, no external exposure | + input validation review, basic authz if roles exist |
| `R2 — MODERATE` | Authenticated users, personal data, network exposure | + full threat model, authorization matrix testing, injection surfaces |
| `R3 — HIGH` | Financial transactions, sensitive personal data, multi-tenant, or public exposure with real users | + abuse cases, comprehensive security testing, secrets lifecycle, audit trail requirements |
| `R4 — CRITICAL` | Regulated data (health, financial, biometric), safety implications, or high-value targets | + mandatory expert review (§8), formal compliance mapping, defense-in-depth requirements |

Classification rules:

- **RC-1** Classify upward under uncertainty.
- **RC-2** Any single `R3`/`R4` criterion sets the class; it is not averaged.
- **RC-3** Reclassification upward is always permitted and forces re-assessment. Downward requires a Decision with justification.
- **RC-4** The class is visible in the project state and in the handover package.

---

## 4. Security-Sensitive Surfaces

Touching any of these forces the security path regardless of the request's primary classification (`04` §3.4 CL-2, `03` §7.1 PR-2):

`authentication · session management · authorization / access control · password and credential handling · secrets and keys · cryptography · payment and financial operations · personal data (any) · file upload and file handling · deserialization · external input parsing · SQL/NoSQL/command/template construction from input · redirects and URL handling · inter-service and third-party communication · webhooks and callbacks · audit logging · rate limiting and abuse controls · account recovery flows · privilege changes · data export and bulk retrieval · configuration of any of the above`

Account recovery, privilege changes, bulk export and configuration-of-security-controls are **DERIVED** additions. Each is a common real-world breach path that conventional sensitive-surface lists omit: recovery flows bypass authentication by design, privilege changes are how a foothold becomes a compromise, bulk export turns a small exposure into a total one, and configuration surfaces let an attacker disable the controls rather than defeat them.

---

## 5. Threat Modeling

```
ThreatModel {
  project_ref, risk_class, version,
  assets            : what is worth protecting, with value and classification
  actors            : legitimate roles + adversary profiles (capability, motivation, access)
  trust_boundaries  : [ { between, what crosses, controls, assumptions } ]
  entry_points      : every way data or control enters the system
  threats           : [ { id, description, boundary_ref, asset_ref, likelihood,
                          impact, mitigation_ref | ACCEPTED | TRANSFERRED } ]
  abuse_cases       : how a legitimate feature can be misused
  assumptions       : security assumptions the design rests on
  out_of_scope      : explicitly not defended against, with reason
}
```

Rules:

- **TM-1** Every threat references a specific trust boundary and a specific asset. A generic threat list not bound to this system's structure is not a threat model (`06` SC-DEPT-022 failure mode).
- **TM-2** Every threat has a disposition: mitigated (with the mechanism), accepted (with authority), or transferred (with what absorbs it).
- **TM-3** `out_of_scope` is mandatory and explicit. Undeclared non-defense is indistinguishable from oversight.
- **TM-4** Abuse cases are required at `R2`+. Features are misused before they are attacked.
- **TM-5** Security assumptions become `Assumption` records and, if load-bearing and unvalidated, `Risk` records (`08` KI-19).
- **TM-6** The threat model is re-evaluated when the architecture, data model, integration set, or exposure changes — a re-evaluation trigger per `SC-POL-015`.

---

## 6. Authorization Model

Given as a separate concern because authorization is the most commonly under-specified and most commonly breached control.

```
AuthorizationModel {
  roles[], resources[], actions[],
  matrix : role × resource × action -> ALLOW | DENY | CONDITIONAL(condition)
  ownership_rules   : how "own record" is determined
  delegation_rules  : if any
  escalation_paths  : how privileges change, and who may change them
  default           : DENY                     # mandatory
  enforcement_points: where each check occurs
}
```

- **AZ-1** Default is deny. An unlisted combination is denied, not permitted.
- **AZ-2** Every cell is tested (`15` §4.1 TD-4), both permitted and denied.
- **AZ-3** Enforcement is server-side/authoritative-side. Client-side checks are UX, never security (`14` §4.1).
- **AZ-4** Object-level authorization ("may this user act on *this* record") is specified explicitly, not assumed from role-level access. This is the single most common real-world authorization defect.
- **AZ-5** Privilege change is itself a controlled action with audit.

---

## 7. Secrets

- **SEC-1** No secret in code, repository, configuration files under version control, logs, error messages, or test data (`IM-5`).
- **SEC-2** Secrets are delivered by the mechanism defined in `SecretsDesign` (`06` SC-DEPT-023).
- **SEC-3** Secrets scanning is a **blocking, never-waivable** check (`09` §9 W-2).
- **SEC-4** Real credentials are owner-reserved (`SC-POL-030`). No agent handles, generates, stores, or transmits a real credential.
- **SEC-5** Rotation is designed, not improvised; the mechanism is part of `SecretsDesign`.
- **SEC-6** A leaked secret is an incident, not a defect. Response: containment (revoke/rotate) precedes root cause.

---

## 8. Mandatory Expert Domains (`SC-POL-012`)

In these domains, Serva Code MUST emit `EXPERT_REVIEW_REQUIRED` rather than produce an authoritative answer. It may still analyze, draft, and prepare — it may not certify.

| Domain | Why |
|---|---|
| Cryptographic design (beyond correct use of standard, vetted primitives) | Subtle errors are undetectable by testing and catastrophic |
| Regulatory compliance claims (health, financial, privacy regimes) | Legal exposure; jurisdiction-specific; changes over time |
| Payment card handling and financial reconciliation correctness | Regulatory and financial exposure |
| Legal terms, licensing obligations, contractual representations | Legal authority is not an engineering matter |
| Safety-critical behavior | Physical harm potential |
| Formal accessibility conformance claims | A claim is a legal statement; automated checks cannot support it (`13` §5.3) |
| Tax and jurisdictional financial rules | Jurisdiction-specific and frequently wrong when inferred |
| Biometric and health data handling | Regulatory and irreversibility of exposure |

**Rule:** in these domains, an answer produced without escalation is a V1 violation (`SC-POL-012`), even if the answer happens to be correct. The failure is the false authority, not the content.

---

## 9. Expedited Security Path (`SC-WF-007`)

Security defects need speed. Speed is bought by **reordering** records, never by removing them.

| Normal | Expedited |
|---|---|
| Full profile | Minimal-scope fix path |
| Records before work | Records may be completed retroactively — but completed |
| Owner notified at gate | **Owner notified at classification** |
| Standard review | Security review + Code Review both still required |
| Full regression | Security suite + affected functional area, full suite before release |

Rules:

- **EX-1** Scope is limited to removing the exposure. This is the sole `SC-POL-009` exception, and it is bounded.
- **EX-2** Every relaxation taken is recorded retroactively with what was skipped and why. An unrecorded relaxation is a V1.
- **EX-3** `SC-POL-005` and `SC-POL-006` are **never** relaxed. Speed does not buy self-certification or unevidenced PASS.
- **EX-4** `SC-POL-030` boundaries are never relaxed. Containment actions requiring owner authority wait for the owner, and the wait is recorded.
- **EX-5** Post-fix, the full record set is completed before the work item closes.

---

## 10. Findings and Risk Acceptance

| Severity | Definition | Disposition |
|---|---|---|
| `CRITICAL` | Exploitable now, high impact | Fix before anything ships; never waived |
| `HIGH` | Serious, exploitable under realistic conditions | Fix, or **owner-recorded** risk acceptance |
| `MEDIUM` | Real weakness, harder to exploit or lower impact | Fix or defer with a trigger |
| `LOW` | Hardening opportunity | Backlog |
| `INFO` | Observation | Record |

- **FD-1** Severity is assigned by Security Testing and may be lowered only with owner-recorded acceptance (`06` SC-DEPT-052).
- **FD-2** A finding is closed only after a re-test with captured evidence (`SC-POL-023`); an assertion of fix is not closure.
- **FD-3** Accepted risks are listed in the release package and re-surfaced at each subsequent release — acceptance does not fade quietly.
- **FD-4** A `CRITICAL` finding in a live system triggers the incident path, not the defect path.

---

## 11. Security Gate Criteria (summary)

Full definition in `18`. Two gates:

**`SC-GATE-SECURITY_DESIGN`** (at Architecture):

| # | Criterion | Evidence |
|---|---|---|
| 1 | Risk class assigned and justified | Security decision |
| 2 | Threat model complete per class; every threat dispositioned | Threat model |
| 3 | Every trust boundary has stated controls | Threat model |
| 4 | Authorization model complete, default-deny | Auth model |
| 5 | Data classified; protection per class specified | Data classification |
| 6 | Secrets design specified | Secrets design |
| 7 | Security NFRs measurable | NFR set |
| 8 | Residual risks enumerated with dispositions | Residual risk list |
| 9 | Mandatory-expert domains escalated, not answered | Escalation records |

**`SC-GATE-SECURITY`** (at verification):

| # | Criterion | Evidence class |
|---|---|---|
| 1 | Dependency vulnerability scan clean or dispositioned | S1, fresh |
| 2 | Secrets scan clean | S1, never waivable |
| 3 | Authorization matrix fully tested | S1 |
| 4 | Input-handling tests for every entry point at `R2`+ | S1 |
| 5 | Threat mitigations verified per threat | S1 or S4 with citations |
| 6 | Security regression executed | S1 |
| 7 | No open `CRITICAL`; no open `HIGH` without owner acceptance | Findings + acceptance records |
| 8 | Sensitive data absent from logs | S1 scan |
| 9 | Protected rules non-bypassable | S1 bypass-attempt tests |

---

## 12. Failure Modes

| ID | Failure | Countermeasure |
|---|---|---|
| `SG-1` | Security deferred to a pre-release scan | `SC-POL-018`; per-stage obligations (§2) |
| `SG-2` | Generic threat model unbound to this system | TM-1 |
| `SG-3` | Object-level authorization missed | AZ-4 + TD-4 matrix testing |
| `SG-4` | Client-side check treated as a control | AZ-3 + review dimension 8 |
| `SG-5` | Secret committed | SEC-3 blocking, never waivable |
| `SG-6` | Finding closed on assertion | FD-2 |
| `SG-7` | Severity quietly downgraded | FD-1 owner-recorded acceptance |
| `SG-8` | Fabricated compliance claim | §8 mandatory escalation; V1 |
| `SG-9` | Expedited path used to skip evidence | EX-3 |
| `SG-10` | Accepted risks forgotten | FD-3 re-surfaced each release |
| `SG-11` | Stale vulnerability scan authorizing release | `16` §6.2 expiry |
| `SG-12` | Configuration used to disable a control | §4 (configuration is a sensitive surface) + `12` §5 protected rules |
| `SG-13` | Error messages leaking internals | UX security-usability obligation (§2) + review |
| `SG-14` | Recovery flow bypassing authentication controls | §4 explicit inclusion; abuse cases at `R2`+ |
