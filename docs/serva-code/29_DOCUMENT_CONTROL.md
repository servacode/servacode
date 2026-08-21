# 29 — DOCUMENT CONTROL

**Document ID:** SC-DOC-029
**Status:** BASELINE R4
**Type:** Normative / Meta
**Derived:** YES — added in Phase 1.
**Owns:** Specification versioning, amendment procedure, conformance obligations, defect classes in the specification itself.

**Why this document exists:** this document set is `T-CANON` for Serva Code (`SC-POL-034`). Canon that has no version, no amendment procedure and no conformance obligation is not canon — it is a folder of documents that will drift from the implementation within weeks, at which point Phase 2 will quietly become the authority and Phase 1 will become decoration.

---

## 1. Status of This Document Set

| Property | Value |
|---|---|
| Set | `SC-SPEC` |
| Version | `1.3.0-baseline-R4` |
| Phase | Phase 1 — Specification & Constitution, after independent Audits R2, R3 and R4 |
| Documents | `SC-DOC-000` … `SC-DOC-033`; cardinality in `30` §11 |
| Tier | `T-CANON` |
| Authority | Owner (Tier 0) for amendment; Governance (`SC-DEPT-002`) for interpretation |
| Executable code | **None.** Phase 1 produced no product code. |

### 1.1 Precedence

When documents conflict:

1. `SC-POL-001` (the supreme principle).
2. `01_COMPANY_CONSTITUTION.md` — policy text.
3. The document that **owns** the concept per the ownership map (`00` §15).
4. `00_MASTER_SPEC.md` for scope and definitions.
5. `26_GLOSSARY_AND_IDENTIFIERS.md` for terms and enumerations.

A conflict between documents is a **specification defect** (§5), not a matter for interpretation at runtime. It is recorded and resolved by amendment.

---

## 2. Versioning

The set is versioned as a whole; documents carry the set version plus their own revision.

| Change | Set version | Requires |
|---|---|---|
| Typo, formatting, clarification with no normative effect | patch | Record |
| New non-normative content (examples, rationale) | patch | Record |
| New normative content that adds rigor (a criterion, an invariant, a check) | minor | Decision Record |
| Change to a policy, an enumeration, an authority level, or a gate criterion | major | Owner approval + Impact Analysis |
| Removal of a policy, criterion, invariant or boundary | major | Owner approval + Impact Analysis + migration note |
| New document | minor | Decision Record + ownership map update |

**The asymmetry is the same as everywhere else in this system** (`18` §9, `07` §9): adding rigor is cheap; removing it requires the owner. This is deliberate and is the primary defense against `SC-RISK-002`.

---

## 3. Amendment Procedure

```
1  Raise            Proposal (10) of class GOVERNANCE, or an owner request
2  Identify         which documents and which normative elements are affected
3  Impact analysis  over: policies, gates, agent contracts, workflows,
                    knowledge model, existing baselined artifacts,
                    projects already governed under the prior version
4  Alternatives     including "no change" — mandatory (09 §4)
5  Decide           at the authority level from §2
6  Amend            edit the owning document only; update cross-references
7  Version          bump the set; record the change
8  Migrate          state what governed projects must do, if anything
9  Verify           consistency checks (§4) pass
```

- **AM-1** Only the owning document is amended. Duplicating the change elsewhere is a `SC-POL-025` violation.
- **AM-2** No agent may amend this set. An agent that believes a document is wrong raises a Proposal and continues to obey the current text (`01` §2).
- **AM-3** Amendments that weaken a control require a migration note for projects already governed, because their prior verdicts were earned under stronger rules and should not be silently reinterpreted.
- **AM-4** The amendment history is retained. Superseded text remains readable — a specification whose history is erased cannot explain why it is shaped as it is, which is the same failure `SC-POL-015` prevents for decisions.

---

## 4. Consistency Checks

Mechanical checks over the document set. Failures are specification defects.

| ID | Check |
|---|---|
| `DC-1` | Every document referenced in the ownership map (`00` §15) exists |
| `DC-2` | Every cross-reference resolves to an existing document and section |
| `DC-3` | Every department in `30` §3 has a contract in `06`, and vice versa |
| `DC-4` | Every agent in `30` §4 has a contract in `32` with archetype, authority and magnitude ceiling |
| `DC-5` | Every policy in `30` §9 has at least one `policy_refs` binding in `18` or a named mechanical/schema enforcement point |
| `DC-6` | Every gate in `30` §7 has a criteria source document |
| `DC-7` | Every entity in `08` §3 is consumed by at least one rule, gate or invariant |
| `DC-8` | Every enumeration value used anywhere appears in `26` §2, `31`, or a `30` catalogue |
| `DC-9` | Every lifecycle stage in `30` §6 has an owner department that exists |
| `DC-10` | Every `DERIVED` element carries a justification |
| `DC-11` | Every open question in `25` names who decides and what it blocks |
| `DC-12` | No normative text is duplicated across documents (`SC-POL-025`) |
| `DC-13` | Every workflow in `30` §8 references gates that exist |
| `DC-14` | Every owner-reserved action in `28` §3 is enforceable at the runtime layer, or is flagged as unenforceable with its enforcement class (`33` §3) |
| `DC-15` | Every requirement in `27` traces to a source document |
| `DC-16` | **No document outside `30` states a catalogue count** (`CAT-2`) |
| `DC-17` | Every agent in `32` appears in `30` §4 and vice versa (`AC-V12`) |
| `DC-18` | Every identifier retired in `30` §10 appears nowhere else as a live reference |
| `DC-19` | No `T-TRACE` entity in `08` §3 carries a mutable lifecycle field (`KI-1b`) |
| `DC-20` | Every agent contract in `32` validates against `32` §7 |
| `DC-21` | Every stage in `30` §6 satisfies the Stage Existence Test (`03` §1.4) |
| `DC-22` | Every agent in `30` §4 has ≥1 AET criterion in `32` §9.1 (`AC-V14`) |

### 4.1 R3 checks — specified for deterministic implementation

R2 claimed a complete consistency scan and missed eleven classes of defect. Each check below is written so a later phase can implement it as a script, with a stated detection method — not as an instruction to read carefully.

| ID | Check | Deterministic detection method |
|---|---|---|
| `DC-23` | **No criterion/gate vocabulary mixing.** A `CriterionResult` value never appears where a `GateVerdict` is expected, and vice versa | Parse every fenced block and table cell that assigns to a field named `verdict`, `value`, `result`, `outcome` or `disposition`; assert the assigned literal set is a subset of exactly one vocabulary in `31`, and that the field's declared type names that vocabulary |
| `DC-24` | **No obsolete `JUDGED` verdict usage.** `JUDGED` appears only as a *basis* | Regex `JUDGED` across the set; for each hit, require the same sentence or table row to contain `basis` (case-insensitive), or the hit to lie inside `31` §2 / a documented R2–R3 correction note. Any other hit fails |
| `DC-25` | **No mutable validity on `T-TRACE`.** | For every schema block whose entity is tiered `T-TRACE` in `08` §3, assert no field name matches `^(freshness\|validity\|state\|status)$`. Assert no assignment statement matches `\.(freshness\|validity\|state)\s*:=` anywhere in the set |
| `DC-26` | **No non-canonical enum literals.** | Extract every all-caps token of ≥2 characters appearing in a value-set position (pipe-separated list, backticked constant in a table of values); assert each is a member of a vocabulary in `26` §2, `31`, or a `30` catalogue, or is inside a block explicitly marked a local tool-result vocabulary (`26` §2.0) |
| `DC-27` | **Composition algorithm has one owner.** | Assert exactly one document contains a `composeGateVerdict` definition; assert no other document contains pseudocode assigning a `GateVerdict` literal |
| `DC-28` | **Generated tables match their source.** | Recompute every table marked `GENERATED` from its source table; diff. `CAT-2b` |
| `DC-29` | **AgentContract fields fully resolved.** | For each agent in `30` §4 and each of the fields in `05` §2, assert a resolution exists per `32` §8.2; assert every `INHERITED(block)` names a block the contract's `inherits` list contains; assert every `DERIVED` rule is total over `30` §4 |
| `DC-30` | **Per-output determinism resolved.** | For each agent, assert `32` §9.2 assigns `GENERATIVE` or `JUDGMENT` to every output named on its contract's Outputs line; ARCHITECT agents must appear in the per-output table |
| `DC-31` | **Normative relations reference canonical entities.** | Parse every relation arrow in `08` §4 and §5; assert each node name is an entity in `08` §3 or is followed by an explicit conceptual-alias note (`KI-5b`) |
| `DC-32` | **ProcessState mappings target existing values.** | For every mapping row in `31` §6.2 and §7, assert the target literal is a member of the named sub-vocabulary; specifically assert `REWORK` never targets V5d (`PS-1`) |
| `DC-33` | **No catalogue count outside `30`.** | Regex for a digit or number-word immediately preceding a catalogue noun (department, agent, stage, gate, workflow, policy, entity, runtime component) outside `30`; allow only historical statements inside a marked R2/R3 correction note |
| `DC-34` | **No retired identifier used as live.** | For every identifier in `30` §10, assert every occurrence outside `30` sits inside a sentence containing `retired`, `merged`, `was`, `absorbed` or `R2`/`R3` |
| `DC-35` | **Every referenced ID exists.** | Extract all `SC-AGENT-`, `SC-STAGE-`, `SC-GATE-`, `SC-WF-`, `SC-DEPT-`, `SC-RTC-`, `SC-POL-` tokens; assert each resolves to a live entry in its `30` catalogue or to the retired register |
| `DC-36` | **Acceptance criteria are satisfiable.** | For every criterion in `24`, assert every state or value it requires an implementation to produce is a member of a canonical vocabulary |

### 4.2 R4 checks — executability

Audit R4 found that R3's semantics were consistent but not yet **executable**: a Phase-2 engineer would have had to invent the `MAJOR`+`INDETERMINATE` disposition, the V3b→V1 mapping, and two schema fields. These checks close that class.

| ID | Check | Deterministic detection method |
|---|---|---|
| `DC-37` | **Severity disposition table is total.** No (severity, `CriterionResult`) pair may be undefined | Enumerate the cross-product of `31` §2 values × `{BLOCKING, MAJOR, ADVISORY}`; assert `31` §4.1.1 has a cell for each. Assert the algorithm in §4.1.2 has no path from a `MAJOR` + `INDETERMINATE` input to an unqualified `PASS` — execute the §4.2 vectors and diff |
| `DC-38` | **No fall-through to `PASS`.** | Symbolically execute `composeGateVerdict` over every combination in the §4.2 vector table; assert each returns the tabulated verdict **and** the tabulated qualification set |
| `DC-39` | **V3b→V1 mapping is total.** | Assert `31` §4.4 has a branch for every `ArtifactVerifierResult` value; assert `ESCALATED` is absent (AV-1); assert `FAIL` maps to `NOT_MET` and never to `MET` (MV-2); execute the M1–M9 vectors and diff |
| `DC-40` | **Every `AgentContract` schema field is resolved.** | Extract the field list from the `05` §2 schema block; extract the row set from `32` §8.2; assert set equality (`CR-R8`). Then for every agent in `30` §4 assert each `LOCAL` field is present per `32` §9.3 |
| `DC-41` | **`context_budget` cannot disappear from validation.** | Assert `context_budget` appears in the `05` §2 schema, in `32` §8.2, and as a Budget line in every contract block (`CR-R9`). This check exists because R3 lost the field from the resolution table while it remained present in all 55 contracts — a field can be silently unvalidated while looking present |
| `DC-42` | **No normative `EvidenceState` vocabulary.** | Regex `EvidenceState`; require every hit to sit in a sentence containing `historical`, `retired`, `removed`, `R2`, `not a vocabulary`, or a check/criterion identifier (`DC-`/`R14.`). Any hit inside a schema block, a value table, or a requirement statement fails |
| `DC-43` | **No incomplete result subsets in process text.** | For every occurrence of two or more `GateVerdict`/`ArtifactVerifierResult` literals in one line, assert either the full vocabulary is present or the line names the vocabulary by reference (`ArtifactVerifierResult`, `31` V3b). A partial literal list without a reference fails |
| `DC-44` | **Immutable records are never "marked".** | Regex `mark(s\|ed)?\s+\w*\s*(STALE\|EXPIRED\|REVOKED)` and `:=\s*STALE`; require every hit to be inside a historical/correction sentence. Normative text must say *derives to* |
| `DC-45` | **`on_missing_evidence` is well-formed.** | For every criterion definition, assert `on_missing_evidence ∈ {INDETERMINATE, NOT_MET}` and that `NOT_MET` occurs only with `tests_existence: true` (`CR-EX1`). Assert `on_absent` and `on_not_verified` appear in **no schema block** — prose recording their R4 removal is expected and must not fail the check |
| `DC-46` | **Criterion fields use V1 values only.** | Assert no criterion-level field is typed with a `GateVerdict` literal — the R3 defect that produced `on_absent : NOT_VERIFIED \| FAIL \| BLOCKED` |

**Why these are written as detection methods rather than as rules.** R2's checks were phrased as properties ("every enumeration value appears in `26`"), which reads like a check but cannot be run. A property with no extraction rule is an intention. These specify what to extract, what to compare it against, and what constitutes a failure — which is the difference between a check that would have caught the R3 defects and one that did not.

`DC-5`, `DC-7`, `DC-12` and `DC-16` catch policies that are decorative, entities that are speculative, text that has drifted into two places, and counts maintained by hand. `DC-23`–`DC-27` catch the class Audit R3 found: **a vocabulary migrated in one document and not in its consumers.**

---

## 5. Specification Defect Classes

| Class | Definition | Severity |
|---|---|---|
| `SD-1` | Contradiction between two normative statements | Critical |
| `SD-2` | A policy with no enforcement point (`DC-5`) | Critical |
| `SD-3` | An unresolvable cross-reference (`DC-2`) | Major |
| `SD-4` | A department, agent, gate or stage referenced but undefined | Major |
| `SD-5` | Duplicated normative text (`DC-12`) | Major |
| `SD-6` | An entity or enumeration with no consumer | Minor |
| `SD-7` | A `DERIVED` element with no justification | Minor |
| `SD-8` | Ambiguity that would produce divergent implementations | Major |
| `SD-9` | An unimplementable requirement | Critical |
| `SD-10` | A criterion with no verification method | Major |
| `SD-11` | An outcome value used outside its canonical vocabulary (`DC-23`, `DC-24`, `DC-26`) | Critical |
| `SD-12` | A mutable validity or lifecycle field on a `T-TRACE` entity (`DC-25`) | Critical |
| `SD-13` | A generated table that disagrees with its source (`DC-28`) | Major |
| `SD-14` | An unresolved `AgentContract` field (`DC-29`, `DC-30`) | Major |
| `SD-15` | A normative relation naming a non-entity (`DC-31`) | Major |
| `SD-16` | A (severity, value) pair with no defined disposition, or a criterion whose `on_missing_evidence`/`tests_existence` combination is invalid (`DC-37`, `DC-45`) | Critical |
| `SD-17` | A cross-vocabulary mapping that is not total (`DC-39`) | Critical |
| `SD-18` | A schema field present in one document and absent from its resolution table (`DC-40`, `DC-41`) | Critical |
| `SD-19` | A criterion-level field typed in gate-level values (`DC-46`) | Major |

Defects are raised as Proposals of class `BLOCKING` (Critical) or `RECOMMENDED` (others) and resolved by amendment.

---

## 6. Conformance Obligations for Later Phases

Later phases are **conformant to this set or must amend it**. Specifically:

| ID | Obligation |
|---|---|
| `CF-1` | Any implementation divergence is either a specification defect (amend the spec) or an implementation defect (fix the code). It is never left as an undocumented difference. |
| `CF-2` | Anything specified but not implemented is recorded as an explicit non-conformance with a reason and a plan. **Unimplemented governance must never be mistaken for working governance** (`SC-RISK-005`). |
| `CF-3` | Any control implemented more weakly than specified is recorded, and the specification is updated to state the real strength. Overstating enforcement is worse than under-delivering it (`16` §10). |
| `CF-4` | Serva Code's own project (`SC-POL-034`) treats this set as its `T-CANON` requirements baseline. |
| `CF-5` | Phase transitions require a conformance statement: what was built, what conforms, what does not, and what changed in the specification. |

`CF-2` and `CF-3` are the ones that matter most. The realistic failure of this project is not that Phase 2 refuses to implement the specification — it is that Phase 2 implements 60% of it, and the documents keep describing 100%, and nobody can tell which parts of the governance are real. These obligations exist so that gap is always visible.

---

## 7. Document Set Inventory

| Doc | Title | Derived |
|---|---|---|
| `00` | Master Specification | no |
| `01` | Company Constitution | no |
| `02` | Company Structure | no |
| `03` | Project Lifecycle | no |
| `04` | Orchestrator Model | no |
| `05` | Agent Architecture | no |
| `06` | Department Contracts | no |
| `07` | Workflow Model | no |
| `08` | Project Knowledge Model | no |
| `09` | Decision Governance | no |
| `10` | Proposal System | no |
| `11` | Competitive Innovation | no |
| `12` | Admin Operability | no |
| `13` | Design Governance | no |
| `14` | Engineering Governance | no |
| `15` | Testing and QA | no |
| `16` | Evidence Model | no |
| `17` | Security Governance | no |
| `18` | Quality Gates | no |
| `19` | Claude Integration | no |
| `20` | VS Code Integration | no |
| `21` | Local Runtime Model | no |
| `22` | Failure and Recovery | no |
| `23` | Operations and Release | no |
| `24` | Acceptance Criteria | no |
| `25` | Open Questions and Risks | no |
| `26` | Glossary and Identifiers | **yes** |
| `27` | Serva Self-Requirements | **yes** |
| `28` | Human Authority and Trust Boundaries | **yes** |
| `29` | Document Control | **yes** |
| `30` | Canonical Catalogues | **yes (R2)** |
| `31` | Result & Verdict Taxonomy | **yes (R2)** |
| `32` | Agent Contract Catalog | **yes (R2)** |
| `33` | Platform & Provider Constraints | **yes (R2)** |

Eight derived documents — four in Phase 1, four added by Audit R2. Each was added because a rule referenced by other documents needed a single authoritative home (`SC-POL-025`), and each is justified in its own header. Document cardinality: `30` §11.

### 7.1 Audit R2 change summary

| Correction | Documents touched |
|---|---|
| 1 · Canonical catalogues | `30` (new), `00`, `02`, `06`, `08`, `18`, `26`, `29` |
| 2 · Agent existence test | `05`, `30`, `32` |
| 3 · Real agent contracts | `32` (new), `06`, `05` |
| 4 · Agent schema violations | `05`, `30`, `32` |
| 5 · T-TRACE / AgentRun repair | `05`, `08`, `07`, `16` |
| 6 · One verdict taxonomy | `31` (new), `16`, `18`, `26`, `27` |
| 7 · Lifecycle canonicalization | `03`, `30`, `11`, `18`, `23`, `00` |
| 8 · Owner decision boundary | `01`, `04`, `20`, `28` |
| 9 · Windows / isolation | `33` (new), `01`, `19`, `21`, `27` |
| 10 · OQ-007 / OQ-008 feasibility | `25`, `33`, `27` |
| 11 · Absolute NFR wording | `27` |
| 12 · Credential boundary | `28` |
| 13 · Provider assumptions | `33`, `01` (SC-POL-035), `19`, `20` |
| 14 · Consistency pass | all |

### 7.2 Audit R3 change summary

| Correction | Documents touched |
|---|---|
| 1 · Verdict taxonomy migration | `31`, `00`, `01`, `08`, `14`, `15`, `16`, `18`, `24`, `26` |
| 2 · Gate composition algorithm | `31` (owner), `18` (references it) |
| 3 · Validity / freshness model | `31` (owner), `08`, `15`, `16`, `18`, `19`, `26` |
| 4 · Stage state mapping | `31` §6, `03` §1.3 / §9 / §10 |
| 5 · Contract resolution model | `32` §8–§9, `05` §2 |
| 6 · Data-model terminology | `08` §3.7 / §4 / §5 / §7 |
| 7 · Glossary repair | `26` |
| 8 · CAT-2 audit | `02`, `30` §4.1–§4.2, `00` |
| 9 · Enum audit | `26` §2.0 + fifteen added vocabularies |
| 10 · Acceptance criteria | `24` |
| 11 · Deterministic checks | `29` §4.1 (`DC-23`–`DC-36`), §5 (`SD-11`–`SD-15`) |

### 7.3 Audit R4 change summary

| Correction | Documents touched |
|---|---|
| 1 · `MAJOR`+`INDETERMINATE` hole; `on_absent`/`on_not_verified` reconciliation | `31` §4.1–§4.2, `18` §2/§2.1/§4.1/§9 |
| 2 · V3b→V1 canonical mapping | `31` §4.3–§4.4, `16` §5, `15` §8.1, `18` §2 |
| 3 · AgentContract schema / resolution mismatch | `05` §2, `32` §8.2, §8.3, §9.3, §7 |
| 4 · `EvidenceState` removed as a vocabulary | `26` §2.1/§2.3, `27` FR-6.2, `31` §1/§7, `08`, `16` |
| 5 · QA vocabulary residue | `15` §8 |
| 6 · Immutability wording | `01`, `07`, `09`, `21` |
| 7 · Contract validation matrix | `32` §9.3 |
| 8 · Deterministic checks | `29` §4.2 (`DC-37`–`DC-46`), §5 (`SD-16`–`SD-19`) |

---

## 8. Baseline Declaration

This set is declared the **Phase 1 baseline, revision R4** of Serva Code, incorporating all corrections from Audits R2, R3 and R4. The stated objective of R4 — that the specification be directly implementable without a Phase-2 engineer inventing missing semantics — is the acceptance test for this baseline.

- It is specification only.
- **No executable product code was implemented in Phase 1.**
- It is subject to review, amendment, and the conformance obligations in §6.
- It does not authorize Phase 2. Phase 2 begins when the owner directs it.
