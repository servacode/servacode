# 27 — SERVA CODE SELF-REQUIREMENTS

**Document ID:** SC-DOC-027
**Status:** BASELINE R4
**Type:** Requirements (input to a later Technology Selection)
**Derived:** YES — added in Phase 1.
**Owns:** The requirements and constraints that will drive Serva Code's own technology selection.
**Explicitly does not own:** Any technology choice. Choosing here would violate `SC-POL-016`.

**Why this document exists:** the assignment forbids choosing a stack now, and permits documenting the constraints on which that choice will later rest. Without this, Phase 2 would either choose a stack without requirements (violating `SC-POL-016`) or re-derive these constraints by re-reading the whole document set.

---

## 1. Status

These are **requirements for Serva Code as a product**, subject to the same discipline Serva Code applies to client work: testable, traceable, prioritized. They will be baselined and gated when Serva Code's own project is established (`SC-POL-034`).

No candidate technology is named anywhere in this document. That is deliberate.

---

## 2. Functional Requirements (grouped)

Each traces to the document that generated it.

### FR-1 · Governance
| ID | Requirement | Source |
|---|---|---|
| FR-1.1 | Enforce every policy through a mechanical check, a gate criterion, or a schema constraint | `01`, `24` R1 |
| FR-1.2 | Bind each policy to its enforcement point and report unenforced policies | `18` §2 |
| FR-1.3 | Classify, record and respond to violations by severity | `01` §1.3 |
| FR-1.4 | Support scoped, expiring waivers with authority binding; no override mechanism | `09` §9, `18` §6 |

### FR-2 · Orchestration
| ID | Requirement | Source |
|---|---|---|
| FR-2.1 | Classify requests into every class in `26` §2.7, with recorded signals and confidence | `04` §3 |
| FR-2.2 | Select and record a lifecycle profile, including every omission | `03` §7, `SC-POL-024` |
| FR-2.3 | Assemble departments and agents, verifying conflict-of-interest satisfiability | `04` §5 |
| FR-2.4 | Compute dependency graphs, detect cycles, and derive maximal safe parallel sets | `04` §6 |
| FR-2.5 | Perform the five protective collection checks on every run | `04` §7.1 |
| FR-2.6 | Compute `nextAction()` from the store with no engine invocation | `04` §9 |
| FR-2.7 | Detect and halt rework loops | `04` §8.3 |

### FR-3 · Agents and engine
| ID | Requirement | Source |
|---|---|---|
| FR-3.1 | Store versioned agent contracts and bind runs to contract versions | `05` §2, §12 |
| FR-3.2 | Construct context bundles from the store with trust marking and recorded exclusions | `19` §4 |
| FR-3.3 | Enforce tool allowlists, filesystem scope and network scope at the runtime | `SC-POL-026` |
| FR-3.4 | Record every tool call including denials | `19` §5.2 |
| FR-3.5 | Validate structured output against the contract schema | `19` §6 |
| FR-3.6 | Isolate sessions; never share a session between executor and reviewer | `19` §3 |
| FR-3.7 | Abstract the engine behind an adapter interface | `19` §1.1 |

### FR-4 · Knowledge store
| ID | Requirement | Source |
|---|---|---|
| FR-4.1 | Persist every entity type in the catalogue with the common envelope | `08` §3 |
| FR-4.2 | Enforce append-only semantics for `T-TRACE` at the storage layer | `SC-POL-022`, `ST-4` |
| FR-4.3 | Version `T-CANON` entities with retained history | `08` §6.1 |
| FR-4.4 | Maintain bidirectional links and detect every orphan class | `08` §5.1 |
| FR-4.5 | Compute and propagate staleness on artifact change | `SC-POL-031` |
| FR-4.6 | Answer every query obligation without an engine | `08` §8 |
| FR-4.7 | Verify every integrity invariant | `08` §7 |

### FR-5 · Evidence
| ID | Requirement | Source |
|---|---|---|
| FR-5.1 | Capture `EXECUTION` and `OBSERVATION` evidence exclusively in the runtime | `16` §3.2 |
| FR-5.2 | Populate provenance the agent cannot author | `16` §4 |
| FR-5.3 | Verify claimed evidence against captured records before acceptance | `04` §7.1 |
| FR-5.4 | Support time-bound expiry alongside artifact-bound staleness | `16` §6 |
| FR-5.5 | Walk the full evidence chain for any verdict | `16` §9 |

### FR-6 · Gates and workflows
| ID | Requirement | Source |
|---|---|---|
| FR-6.1 | Evaluate gate criteria deterministically against stored state | `18` §1 |
| FR-6.2 | Produce all six `GateVerdict` values (V3), the five `ArtifactVerifierResult` values (V3b), the five `CriterionResult` values across their three bases (V1), and the six derived `ValidityState` values (V2), with qualifications that propagate | `31` |
| FR-6.6 | Compose gate verdicts by the total severity disposition table and algorithm in `31` §4.1, reproducing every acceptance vector in `31` §4.2 | `31` §4.1–§4.2 |
| FR-6.7 | Map every `ArtifactVerifierResult` into a `CriterionEvaluation` by the total mapping in `31` §4.4, reproducing every vector in that section | `31` §4.4 |
| FR-6.3 | Execute declarative workflows with checkpointing and resumption | `07` §6 |
| FR-6.4 | Enforce workflow invariants at every step boundary | `07` §8 |
| FR-6.5 | Record handoffs with completeness and acceptance | `07` §3.2 |

### FR-7 · Runtime
| ID | Requirement | Source |
|---|---|---|
| FR-7.1 | Transactional, durable, atomic state changes | `21` §4 |
| FR-7.2 | Write-set locking with lease expiry and snapshot isolation | `21` §5 |
| FR-7.3 | Reconcile the workspace and classify divergence | `21` §10 |
| FR-7.4 | Snapshot, verify and restore the store | `21` §7 |
| FR-7.5 | Isolate projects; expose cross-project learning only as `CANDIDATE` | `21` §8 |
| FR-7.6 | Schedule expiry checks, re-evaluation triggers and stall detection | `21` §11 |
| FR-7.7 | Recover from interruption at any point, or declare unrecoverability with a diagnosis | `22` §4 |

### FR-8 · Interface
| ID | Requirement | Source |
|---|---|---|
| FR-8.1 | Provide the six surfaces with their information contracts | `20` §3 |
| FR-8.2 | Display governance state derived from a real check | `20` §2 |
| FR-8.3 | Attribute every action to its actor | `20` UX-1 |
| FR-8.4 | Capture approvals explicitly | `09` AP-4 |
| FR-8.5 | Operate fully in read mode with no engine available | `20` DG-1 |
| FR-8.6 | Show classification before work begins | `20` §5 |

---

## 3. Non-Functional Requirements

**Revised in R2 (Correction 11).** R1 marked many NFRs "Absolute". Several were not achievable as literally stated — they promised guarantees against arbitrary hardware, arbitrary machines and arbitrary platforms. An unachievable guarantee is worse than a scoped one: it cannot be tested, so it is never falsified, and it quietly licenses the belief that the property holds.

Every NFR below now carries **stated assumptions** and a **testable acceptance condition**. Nothing was weakened in substance; the guarantees were made checkable. `GUARANTEED` means "holds whenever the stated assumptions hold, and is tested".

| ID | Dimension | Requirement | Guarantee | Assumptions / acceptance |
|---|---|---|---|---|
| NFR-1 | Determinism | Orchestration, gate evaluation, staleness and integrity checks are deterministic functions of stored state | GUARANTEED | No engine invocation in these code paths. Acceptance: re-evaluating a gate over an unchanged store yields an identical verdict and criterion results |
| NFR-2 | Local-first | No implicit network transmission of project data | GUARANTEED | Network egress only through declared research scopes. Acceptance: `QR-06` passes; no egress observed for a run with `net: NONE` |
| NFR-3 | Offline capability | All reads, queries and gate evaluations over existing evidence work with no network | GUARANTEED | Acceptance: full read-mode session with network disabled (`20` DG-1) |
| NFR-4 | Store durability | **No *committed* state is lost on process crash, process kill, or OS-level power loss.** "Committed" = the store's durable log has acknowledged the write after a successful flush-to-disk. | GUARANTEED under assumptions | **Assumes:** a filesystem that honours flush/`fsync` semantics; storage hardware that does not acknowledge writes it has not persisted; no media failure or physical destruction. **Excluded:** hardware destruction, silent disk corruption, filesystems or virtualization layers that lie about durability. Those are addressed by backups (`21` §7), not by this NFR. Acceptance: kill-during-write fault injection at each transaction boundary leaves either the prior or the new state, never a partial one |
| NFR-5 | Store inspectability | Readable and interpretable without Serva Code running | GUARANTEED | Assumes standard text/data tooling on the host. Acceptance: a third party reconstructs project state, decisions and evidence chains from the store using no Serva Code component (`ST-2`) |
| NFR-6 | Portability | **Reproducible portability:** copying a project root to another machine that satisfies the declared prerequisites yields a project whose store opens, whose queries answer identically, and whose gates re-evaluate to identical verdicts | GUARANTEED under assumptions | **Assumes:** the target satisfies the project's `PortabilityManifest` — supported OS family, runtime and toolchain versions, required external tools, and enforcement substrate (`33` PC-4). **Explicitly excluded:** machine-local secrets and provider credentials, which are never copied (`28` R-14) and must be re-established on the target; platform-specific build artifacts, which are regenerated. **Not claimed:** execution on an arbitrary computer. Acceptance: a project copied to a conforming machine reproduces every gate verdict; a project copied to a non-conforming machine fails **visibly** at manifest check, never silently |
| NFR-7 | Responsiveness | `nextAction()` and status queries return promptly enough for interactive use | `TARGET_TBD(Owner)` | Must be set before Phase 2 acceptance |
| NFR-8 | Concurrency | Concurrent runs complete without lost updates or store corruption | GUARANTEED | Assumes the lock manager and transactional store (`21` §4–§5). Concurrency **cap** is `TARGET_TBD(Owner)`; **correctness** is guaranteed at any permitted cap. Acceptance: concurrent conflicting-write scenarios are refused at plan time or serialized at run time, never interleaved |
| NFR-9 | Scale | A project's full lifetime of records is supported without material query degradation | `TARGET_TBD` | Must be **measured**, not assumed. Acceptance: query latency at a defined record volume, measured, not estimated |
| NFR-10 | Consumption governance | Every run's consumption recorded; budgets enforced | GUARANTEED | Acceptance: no run completes without a consumption record; a projected breach halts rather than proceeds |
| NFR-11 | Recoverability | Every interruption is resumable from the last checkpoint, or declared unrecoverable with a diagnosis | GUARANTEED under NFR-4 assumptions | Acceptance: interruption injected at every workflow step boundary resumes or diagnoses; never silently loses a run |
| NFR-12 | Auditability | Every state change is attributable to an actor and a cause | GUARANTEED | Acceptance: `SC-RTC-001` reports no unattributed state change; event digest chains verify |
| NFR-13 | Store security | No agent tool can write `Evidence`, `AuditEvent`, `GateResult` or provenance | GUARANTEED | Acceptance: tool-allowlist audit plus `QR-09` |
| NFR-14 | Capability enforcement | Tool, filesystem and network scope enforced outside the model | **Conditional on substrate** | `HARD` on a supported isolation substrate; `SOFT` (harness-level, L3) otherwise. The class MUST be detected, declared, and attached as a `DEGRADED_ENFORCEMENT` qualification when below `HARD` (`33` §3, `31` §8). Acceptance: `QR-01`–`QR-07`, `QR-14` |
| NFR-15 | Reproducibility | Runs are reconstructible from stored inputs; **gate verdicts are fully reproducible** | GUARANTEED for verdicts; reconstruction (not re-execution) for runs | Model output is explicitly **not** claimed reproducible (`16` §10, `21` §13). Acceptance: verdict re-evaluation is identical; run inputs, tool calls and outputs replay from the event log |
| NFR-16 | Extensibility | New departments, agents, gates, workflows and entities addable without core changes | Qualitative | Acceptance: one of each added in a test, requiring no change to orchestration, gate-engine or store core |
| NFR-17 | Engine independence | Engine replaceable through the adapter without changing governance | GUARANTEED | Acceptance: no governance component references a provider-specific symbol; capability negotiation covers every provider-dependent behavior (`SC-POL-035`) |
| NFR-18 | Migration safety | Store schema migrations are versioned, reversible and snapshot-protected | GUARANTEED | Acceptance: every migration applied and reversed in test with captured evidence; pre-migration snapshot verified |
| NFR-19 | Usability | The owner can determine project state and next action within seconds of opening | Qualitative | The practical defense against `SC-RISK-020`. Acceptance: cold-open task completed without consulting any other surface |
| NFR-20 | Self-observability | Serva Code's own failures, consumption and health are visible | GUARANTEED | Acceptance: every failure class in `22` §2 surfaces to the owner in a test |

---

## 4. Constraints on Technology Selection

Binding constraints. Any candidate failing a `HARD` constraint is disqualified regardless of other merits.

| ID | Constraint | Type | Source |
|---|---|---|---|
| C-1 | Runs locally on the owner's machine; no required server | HARD | `00` §13 |
| C-2 | Integrates with VS Code as the primary surface | HARD | `20` |
| C-3 | Invokes a locally-authenticated AI engine | HARD | `19` |
| C-4 | Store append-only enforceable at the storage layer | HARD | `SC-POL-022` |
| C-5 | Store inspectable without Serva Code | HARD | `ST-2` |
| C-6 | Transactional multi-record writes | HARD | `TX-1` |
| C-7 | Can mediate or independently reproduce tool execution for evidence capture | HARD | `16` §3.2, `SC-OQ-007` |
| C-8 | Can enforce per-run filesystem and process scope | HARD | `SC-POL-026`, `SC-OQ-008` |
| C-9 | Runs on the owner's platform | HARD | Environment |
| C-10 | No mandatory paid service for core operation | HARD | `SC-POL-028` |
| C-11 | Licensing compatible with the owner's intended use | HARD | `SC-POL-016` |
| C-12 | Maintainable by a single developer | SOFT | `SC-POL-017` |
| C-13 | Ecosystem sufficient for JSON-schema validation, digesting, file watching, process control | SOFT | Functional needs |
| C-14 | Complexity proportionate to a single-user local tool | SOFT | `SC-POL-017` |
| C-15 | Long-term viability of the chosen stack | SOFT | `SC-POL-016` |

**C-4 and C-5 together are the most constraining pair** and are flagged in `SC-OQ-006`: append-only enforcement usually implies a managed storage engine, while owner-inspectability usually implies plain files. A hybrid — plain-file canon with an append-only trace log and content-addressed evidence — is the likely shape, but that is a design hypothesis, not a decision, and it must go through `SC-POL-016` properly.

**C-7 and C-8 are the two constraints that determine whether Serva Code's central claims are real.** If the chosen integration cannot satisfy them, the evidence model and the capability model must be honestly downgraded in the specification rather than asserted in it.

---

## 5. Explicit Non-Requirements

| ID | Not required | Why |
|---|---|---|
| NR-1 | Multi-user, multi-tenant, or remote access | `00` NG1–NG3 |
| NR-2 | High availability, clustering, container orchestration | `00` NG4, `SC-POL-017` |
| NR-3 | Automatic production deployment | `SC-POL-030` — permanently excluded |
| NR-4 | A visual editor for contracts, gates or workflows | `24` §10 |
| NR-5 | Support for multiple engines simultaneously | `24` §10 — the adapter must exist; a second implementation need not |
| NR-6 | Cross-project analytics beyond the learning interface | `21` §8 |
| NR-7 | Effort estimation beyond recorded-basis estimates | `24` §10 |

---

## 5.1 Capability Qualification Requirements

Sixteen qualification requirements (`QR-01` … `QR-16`) are specified in `33` §6. They convert the platform and provider assumptions this document depends on from *promising* into *proven*, and several NFRs above name them as acceptance conditions.

**They are specifications for future tests. Phase 1 does not execute them.** `QR-09` — that an agent cannot fabricate an `EXECUTION` evidence record — is the one on which the entire evidence model rests (`33` QG-3).

---

## 6. Selection Procedure

When Serva Code's technology selection occurs, it follows `09` §7 at `DEEP` depth (reversal cost is HIGH for the store and the runtime), and produces:

1. Requirements and NFRs from this document as the drivers.
2. Evaluation criteria **declared before** candidate research.
3. Candidates evaluated against §4, with `HARD` constraints as disqualifiers.
4. Sourced research findings with `valid_until`.
5. A scored comparison.
6. ADRs per decision with specific rejection reasons and re-evaluation triggers.
7. A separate architecture review (`SC-AGENT-072`), since the researcher may not be the sole decider at `DEEP` depth.

**This document is the input to that procedure, not a substitute for it.**

---

## 7. Traceability Note

Every requirement here traces to a document in this set. When Serva Code's own project is established under `SC-POL-034`, these become `Requirement` and `NFR` records with acceptance criteria, and `24` §9 becomes their acceptance criteria at the system level. At that point Serva Code will be building itself under its own traceability rules — which is both the point of `SC-POL-034` and the most honest test of whether this specification is workable.
