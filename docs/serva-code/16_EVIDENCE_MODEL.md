# 16 — EVIDENCE MODEL

**Document ID:** SC-DOC-016
**Status:** BASELINE R4
**Type:** Normative / Data & Integrity Model
**Owns:** Evidence classes, strength ordering, provenance, integrity verification, sufficiency rules.
**Does not own:** **Outcome vocabularies and the validity model (`31`)**, gate criteria (`18`), test execution (`15`), storage mechanics (`21`).

---

## 1. The Central Rule

> **NO EVIDENCE = NOT VERIFIED.**

`NOT_VERIFIED` is a distinct outcome from `PASS` and from `FAIL`. It MUST never be reported as either (`SC-POL-005`).

This document exists because the entire credibility of Serva Code rests on one question: **can a claim in this system be false while looking true?** Every rule below is designed to make the answer no — or, where it cannot, to make the weakness visible in the record itself.

---

## 2. What Evidence Is

```
Evidence {
  id                : SC-EV-<id>
  class             : EXECUTION | OBSERVATION | ARTIFACT | ANALYSIS | JUDGMENT | ATTESTATION
  claim             : what this evidence is offered to support
  provenance        : Provenance          # see §4 — runtime-populated, never agent-authored
  content_ref       : stored artifact (output, log, report, screenshot, file)
  digest            : hash of content
  artifact_versions_covered : [ {artifact_id, version, digest} ]   # binds freshness
  produced_by_run   : SC-RUN-<uuid>
  captured_at       : timestamp
  valid_until       : timestamp | null    # time-bound evidence
  strength          : derived from class + provenance (§3)
  supersedes        : SC-EV-<id> | null   # forward-only (08 §6.2)
}
```

Evidence is `T-TRACE`: immutable, never edited, never deleted (`SC-POL-022`).

**Changed in R2:** the mutable `state` field is removed. An immutable record cannot carry a field that changes as the world changes around it — that was the same contradiction found in `AgentRun` (`08` §2.1). validity is now **derived** as `ValidityState` (`31` §3): staleness is computed from artifact versions, expiry from `valid_until`, and revocation or dispute from **appended** `EvidenceRevocation` / `EvidenceDispute` records. Nothing is lost; the state is still queryable, and it is now impossible to alter an evidence record's standing by editing it.

---

## 3. Evidence Classes and Strength

| Class | Definition | Who produces it | Falsifiable by an agent? | Strength |
|---|---|---|---|---|
| `EXECUTION` | Captured output of an actually-executed operation: command, exit code, stdout/stderr, artifacts | **Runtime only** | No | **S1 — strongest** |
| `OBSERVATION` | Captured state of the world: file digests, screenshots, HTTP transcripts, measured metrics | **Runtime only** | No | S2 |
| `ARTIFACT` | The existence and content of a stored artifact at a version | Runtime | No (content is digested) | S3 |
| `ANALYSIS` | A structured assessment produced by an agent against declared criteria, citing S1–S3 evidence | Agent | Partially — but its citations are checkable | S4 |
| `JUDGMENT` | A reasoned verdict where no stronger evidence is possible, with named criteria and reviewer role | Agent (VERIFIER archetype) | Yes | S5 |
| `ATTESTATION` | A human statement of fact by the owner | Owner | N/A — human authority | S-OWNER (outside the ordering) |

### 3.1 The strength rule (`SC-POL-023`)

> **A claim MUST be supported by the strongest evidence class its subject admits.**
> Where `EXECUTION` evidence is obtainable, `JUDGMENT` alone is insufficient.

Examples of the rule in force:

| Claim | Insufficient | Required |
|---|---|---|
| "Tests pass" | Agent says so (S5) | S1 test run with exit code |
| "It builds" | Agent says so | S1 build output |
| "No secrets in the repo" | Agent reviewed and saw none | S1 secrets scan |
| "Contrast meets the target" | Agent's assessment | S1 contrast check over the token set |
| "Latency is under 200ms" | Agent's estimate | S2 measurement in a recorded environment |
| "The rollback works" | Rollback exists in the plan | S1 executed rollback |
| "The backup restores" | Backup runs | S1 executed restore |
| "The architecture is coherent" | — | S5 `JUDGMENT` is legitimate here |
| "The information architecture suits these users" | — | S5 `JUDGMENT` is legitimate here |

The last two rows matter as much as the first eight: **the model does not pretend everything is mechanically verifiable.** It requires the strongest available class and makes the class visible, so a reader of the record knows exactly what kind of assurance they are looking at.

### 3.2 The forgery boundary

`EXECUTION` and `OBSERVATION` evidence is created **by the runtime**, from operations the runtime itself performed. An agent may *request* an operation; it may not author the record of the result.

Enforcement:

- Agents have no tool that writes Evidence records (`SC-POL-029`).
- Every `EXECUTION` record carries runtime-populated provenance the agent could not fabricate (§4).
- The Orchestrator's collection check (`04` §7.1, check 4) verifies every claimed evidence item exists as a runtime record. A claim referencing no record is `EVIDENCE_VIOLATION` — severity V1.

**This is the single most important mechanism in Serva Code.** Without it, every gate can be passed by a sufficiently confident sentence.

---

## 4. Provenance

```
Provenance {
  captured_by     : RUNTIME | OWNER
  method          : tool identifier + version
  command         : exact command executed (EXECUTION)
  exit_code       : integer (EXECUTION)
  working_dir     : path
  environment     : { platform, versions, relevant configuration digest }
  started_at, ended_at
  initiating_run  : SC-RUN-<uuid>
  output_digest   : hash of captured output
  tool_call_ref   : SC-TC-<id>          # links to the recorded tool call
}
```

Rules:

- **PV-1** `captured_by` is never an agent. There is no code path by which an agent populates provenance.
- **PV-2** Missing or malformed provenance makes the evidence inadmissible; it cannot support a verdict.
- **PV-3** Provenance fields are immutable (`SC-POL-029`).
- **PV-4** `ANALYSIS` and `JUDGMENT` evidence carries a reduced provenance: the producing run, the contract version, the criteria applied, and the S1–S3 evidence it cites. An `ANALYSIS` citing nothing is `JUDGMENT`, and is classified as such regardless of how it was labeled.

---

## 5. Verdicts

**Corrected in R3.** R2 kept a generic `Verdict` record here with a stored `freshness` field. There is no generic `Verdict` entity: a verdict is produced either by a VERIFIER agent about an artifact, or by the gate engine about a gate. Both are canonical entities in `08` §3.7, and neither stores validity.

```
ArtifactVerifierResult {                      # 31 V3b · T-TRACE · immutable
  id                  : SC-AVR-<id>
  subject             : artifact refs @ versions
  value               : ArtifactVerifierResult   # PASS | PASS_WITH_QUALIFICATION |
                                                 # FAIL | NOT_VERIFIED | BLOCKED
  dimensions_checked      : string[]
  dimensions_not_checked  : [ {dimension, reason} ]     # mandatory
  findings            : Finding[]
  evidence_refs       : SC-EV-<id>[]
  basis_summary       : { measured[], judged[], derived[] }
  actor               : { run_ref, agent_id, role }
  criteria_applied    : string[]
  confidence          : HIGH | MEDIUM | LOW      # required where any dimension is judged
  cause               : EVIDENCE_ABSENT | EVIDENCE_INVALID | TOOL_UNAVAILABLE
                        | PRECONDITION_ABSENT
                        # required iff value in {NOT_VERIFIED, BLOCKED}  (31 §4.3, R4)
  qualifications      : Qualification[]          # 31 §8
  artifact_versions_evaluated : [ {artifact_id, version, digest} ]
  depends_on          : refs used for validity propagation
  evaluated_at
}
```

**No `freshness` field.** `ValidityState` is derived (`31` §3.2, `VD-1`).

**Vocabulary owner:** `31_RESULT_AND_VERDICT_TAXONOMY.md`. R1 defined a six-value list here that overlapped inconsistently with `18` and `27`; R2 moved all outcome vocabularies to `31` and this section now references them.

| Subject | Vocabulary | Values |
|---|---|---|
| An artifact judged by a VERIFIER | `ArtifactVerifierResult` (V3b) | `PASS · PASS_WITH_QUALIFICATION · FAIL · NOT_VERIFIED · BLOCKED` — **`ESCALATED` excluded** (AV-1) |
| One gate evaluation | `GateVerdict` (V3) | `PASS · PASS_WITH_QUALIFICATION · FAIL · NOT_VERIFIED · BLOCKED · ESCALATED` |
| One gate criterion | `CriterionResult` (V1) | `MET · NOT_MET · INDETERMINATE · NOT_APPLICABLE · WAIVED`, each with basis `MEASURED · JUDGED · DERIVED` |
| Any validity-bearing record | `ValidityState` (V2) | `VALID · STALE · EXPIRED · REVOKED · DISPUTED · INADMISSIBLE` — **derived, never stored** |

### 5.1 `JUDGED` is a basis, not a verdict (R2 correction)

Phase 1 introduced `JUDGED` because collapsing judgment into `PASS` destroys the reader's ability to distinguish *proven* from *assessed*. The intent was right; the modelling was wrong. `JUDGED` describes **how a criterion was determined**, not **what a gate concluded** — treating it as a verdict made "judged" and "proven" indistinguishable at exactly the level where the distinction matters.

R2 places it correctly: a criterion carries a **basis**, and any `JUDGED`-basis criterion caps its gate at `PASS_WITH_QUALIFICATION` (`31` §4.1).

Rules:

- **JV-1** `JUDGED` basis is permitted only where the criterion declares that no stronger evidence class is obtainable.
- **JV-2** It requires named criteria, the reviewer role, and a confidence value.
- **JV-3** It never silently equals a `MEASURED` determination. A gate may declare it sufficient, insufficient, or sufficient-with-owner-visibility.
- **JV-4** Every `JUDGED`-basis criterion appears as a qualification in the release package, so the owner sees the assurance shape of what they are shipping (`31` TX-8).

A release whose security testing is `MEASURED`-basis `MET` and whose architecture coherence is `JUDGED`-basis `MET` is in a different position from one where both are measured — and the record now shows it.

### 5.2 Qualifications

Any verdict may carry qualifications — unvalidated load-bearing assumptions, active waivers, aspects deliberately not checked. **Qualifications propagate**: a downstream verdict that depends on a qualified verdict inherits the qualification. This prevents a chain of individually-reasonable PASSes from laundering an unvalidated assumption into apparent certainty.

---

## 6. Freshness

Two independent decay mechanisms.

### 6.1 Artifact-bound staleness (`SC-POL-031`)

Evidence and verdicts bind to `artifact_versions_covered`. When any covered artifact changes version, the evidence becomes `STALE` and the verdicts resting on it become `STALE`, cascading downstream (`08` §6.3).

Gates declare their **invalidation set** — which artifact classes invalidate their verdicts. A documentation-only change need not invalidate a performance measurement, but that exemption is declared in the gate definition, not decided ad hoc at evaluation time.

### 6.2 Time-bound expiry

Some evidence decays with time regardless of artifact change:

| Evidence | Typical validity | Why |
|---|---|---|
| Dependency vulnerability scan | Short | New vulnerabilities are disclosed continuously |
| Market/competitive research | Medium | The market moves |
| Technology evaluation | Medium-long | Ecosystems change |
| Restore test | Medium | Environment drift |
| Rollback test | Per release | Release-specific |
| Performance measurement | Per environment version | Environment drift |
| Accessibility automated scan | Bound to artifacts | Primarily artifact-bound |

`valid_until` is set at capture by the producing department. Expired evidence cannot support a gate and is reported as `EXPIRED`, not as absent — the distinction tells the owner that verification once existed and needs refreshing, which is different from never having been done.

---

## 7. Sufficiency

Each gate criterion declares its evidence requirement:

```
EvidenceRequirement {
  criterion_ref, required_class (minimum), required_count,
  required_coverage    : what the evidence must span (e.g. all MUST requirements)
  independence         : producer must differ from claimant (SC-POL-006)
  validity             : VALID required (31 §3) | max age
  substitutes          : alternative acceptable evidence, if any
  on_missing_evidence  : INDETERMINATE | NOT_MET      # V1 values only (R4)
                         # NOT_MET permitted only where the owning criterion
                         # declares tests_existence: true  (18 §2.1, CR-EX1)
}
```

**Corrected in R4.** This schema carried `on_absent : NOT_VERIFIED | BLOCKED` — the same defect Audit R4 found in `18`: a criterion-level field typed in **gate-level** values. An evidence requirement cannot produce a `GateVerdict` (`31` TX-1). It now yields a `CriterionResult`, and the severity disposition table (`31` §4.1.1) decides what that means for the gate. This occurrence was not cited by the audit; it was found by the `DC-46` check written to catch the cited one.

Sufficiency rules:

- **SF-1** Evidence must **cover** the claim, not merely relate to it. A test run proving one acceptance criterion does not evidence a requirement with four.
- **SF-2** Evidence produced by the artifact's producer cannot satisfy an independence-required criterion.
- **SF-3** Partial evidence yields partial verdicts: the covered part may be `PASS`, the uncovered part is `NOT_VERIFIED`. It is never rounded up.
- **SF-4** Evidence of the *wrong thing* is not evidence. A build succeeding does not evidence that a requirement is met — this is the most common false-assurance pattern, and gates bind criteria to specific evidence *kinds*, not to "some evidence exists".

---

## 8. Integrity Verification

Performed by `SC-RTC-002` (Evidence Integrity Checker) and `SC-RTC-001` (Store Integrity Checker) — **deterministic runtime components, not agents** (`30` §5). R1 modelled evidence-integrity checking as an agent; verifying evidence provenance inside a model invocation would place model output in the very path this section exists to keep model-free.

| Check | Detects | Severity |
|---|---|---|
| Digest verification | Modified evidence content | V1 |
| Provenance completeness | `EXECUTION` evidence lacking runtime provenance | V1 |
| Claim-evidence binding | Verdicts citing non-existent or unrelated evidence | V1 |
| Class correctness | `ANALYSIS` labeled where it cites nothing (should be `JUDGMENT`) | V2 |
| Independence | Producer = verifier | V1 |
| Validity | Non-`VALID` evidence supporting a live verdict (`31` §3) | V1 if it authorized a release |
| Coverage | Verdict claiming more scope than its evidence spans | V2 |
| Orphan evidence | Evidence supporting nothing | V3 (informational) |
| Chain integrity | A `PASS` chain resting on a `NOT_VERIFIED` or qualified base | V2 |
| Vocabulary conformance | A stored outcome value outside its canonical vocabulary (`31`) | V2 |

### 8.1 Disputed evidence

`DISPUTED` state exists for evidence whose validity is questioned but not yet resolved (e.g. a test run in a possibly-misconfigured environment). Disputed evidence cannot support a gate until resolved. Resolution appends a record; it never edits the original.

---

## 9. The Evidence Chain

For any `PASS` anywhere in the system, this chain must be walkable:

```
GateResult | ArtifactVerifierResult
  └─ criterion_evals / evidence_refs
       └─ Evidence (class, strength)
            ├─ provenance (runtime-captured)
            ├─ content (digested, stored)
            ├─ produced_by_run ─► AgentRun ─► context bundle, contract version
            └─ artifact_versions_covered ─► Artifacts at specific versions
                                             └─ traceable to Requirements (SC-POL-014)
```

If any link is missing, the `PASS` is invalid. This chain is what `08` Q5 ("what evidence supports this PASS, and is it fresh?") walks, and it is answerable **without an AI session** — which is what makes the assurance auditable rather than conversational.

---

## 10. What This Model Deliberately Does Not Claim

Stated explicitly, because overselling the model would be its own integrity failure:

| Not claimed | Reality |
|---|---|
| That evidence proves correctness | Evidence proves that a specific check produced a specific result. A passing suite proves the suite passed, not that the software is correct. |
| That `JUDGMENT` evidence is reliable | It is the weakest class, marked as such, and never silently equal to proof. |
| That the system cannot be wrong | It can. It is designed so that being wrong leaves a trace, and so that the *kind* of assurance behind any claim is legible. |
| That coverage equals confidence | Coverage is measured against declared criteria; undeclared criteria are invisible to it. `non_testable` (`15` §2) exists to surface that gap. |
| That an unbroken chain means the requirement was right | Traceability proves what was built matches what was specified. Whether the specification was right is a Discovery/Product question, not an evidence question. |

**This honesty is itself a requirement** (`SC-POL-012`). A verification system that overstates its own guarantees is the most dangerous component in the architecture, because everything downstream trusts it.
