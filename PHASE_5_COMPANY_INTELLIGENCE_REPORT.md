# PHASE 5 — COMPANY INTELLIGENCE REPORT

**Governing principle, implemented:** the client defines the problem and the business
goals. SERVA CODE determines how the product should be engineered.

The owner is never asked which framework, which database, which colour, or which
architecture. They are asked about money, policy, scope and priorities — and only when the
alternative would be for Serva to invent an answer.

---

## 1. Phase 4 baseline

| | |
|---|---|
| Baseline commit | `f4866b2` |
| Baseline tests | 764, all green |
| Substrate enforcement | HARD (7/7 positive controls, 16/16 containment probes) |
| Phase 4 status at handover | unchanged — no Phase 1–4 invariant was weakened |

Phase 5 added no modification to Phase 4 authority semantics. The proof is in
[`tests/intel.e2e.test.ts`](tests/intel.e2e.test.ts): Phase 5 generates a work item and the
**real** `EngineeringFactory.recordWorkItem` accepts it unchanged, against a real git
fixture and a qualified substrate.

## 2. Phase 5 commits

```
42c1fc5  foundation — profiles, applicability, provenance, first artifacts
d36dea1  artifact schemas and the canon repository
00af7d3  research trust boundary and deterministic checkers
41b1c57  intelligence execution core
fd3e970  research chain — gather, verify, interpret, propose
c4b5fc1  design authority — architecture through admin operability
61425a2  all 26 departments execute, 12 gates, readiness, Phase 4 handoff
73d2862  change, proposals, learning, owner CLI, authority proofs
3a2a62a  scenarios B, C and D; re-entry is a delta, not a suffix
cac65d5  security acceptance, the real retriever, live intelligence suite
9eef627  a blocking escalation is a question, not an error
```

78 files changed, +22,550 lines. No production dependency added — `zod` remains the only
runtime dependency in the project.

## 3. Artifact and schema implementation

110 canonical artifact types, in 17 families under
[`src/intelligence/artifacts/`](src/intelligence/artifacts/). Every one is a strict Zod
schema: unknown keys are rejected rather than ignored, because a typo in a field name
should fail at the boundary rather than silently produce an artifact missing the thing its
author meant to say.

Two fields carry most of the weight:

- **`meta.provenance`** — a discriminated union over `OWNER_STATED | DERIVED | RESEARCHED |
  INFERRED | SYSTEM`. `provenanceRefusal` refuses a load-bearing `INFERRED` with no
  `assumptionId`, and a `RESEARCHED` with no captured source. An inference cannot be
  laundered into a fact.
- **`version`** — assigned by the repository from what is already stored, never trusted
  from the caller. A refresh creates a new version; a decision made last month still
  points at what it actually relied on.

## 4. Lifecycle and profile implementation

All 26 canonical stages and all 13 profiles from `03` §7, parsed into the generated
catalogue. `resolveApplicability(profileId)` returns a **TOTAL** plan — every stage carries
a disposition, so nothing is omitted silently, and a deliberate skip is distinguishable
from profile inapplicability.

Prose the stage table cannot express (`045 + root-cause record`, `013 or targeted
research`) is surfaced as `proseObligations` rather than dropped — see **SF-6**.

## 5. Owner-decision boundary

`OwnerDecisionRequest` is control flow, not a note. `WAITING_FOR_OWNER` is a real
orchestrator state that persists and resumes from the Store, with no dependence on a
conversation that no longer exists.

`ownerDecisionRefusal` refuses an answer whose `answeredBy` is an agent, and the
orchestrator re-checks on resume rather than trusting the caller — the caller being the
part of the system most likely to be in a hurry.

Three routes reach the owner, and all three are Serva's, not an agent's:

1. a department that finished and produced a question (`OWNER_DECISION_REQUIRED`);
2. a department that stopped **before** producing anything, on a blocking escalation
   (`ESCALATED_TO_OWNER` — the stage re-runs after the answer, because it wrote nothing);
3. a specification gap in architecture, which raises a decision rather than filling itself
   in.

## 6–9. Discovery, Product, Business Analysis, Requirements

| Stage | Department | The refusal that makes it real |
|---|---|---|
| 003 Discovery | SC-AGENT-030 | `CurrentAlternative` is mandatory. Products lose to notepads more often than to rivals. |
| 004 Product Validation | SC-AGENT-020 | scope is owned here; a proposal cannot become a feature by being mentioned |
| 010 Business Analysis | SC-AGENT-040 | `financialRefusal` — anything financial that is not owner-confirmed or legally established becomes a blocking owner decision |
| 011 Requirements | SC-AGENT-050 | a MUST with no acceptance criterion is blocking |
| 011 NFRs | SC-AGENT-051 | "fast" is not a target; a number or a named standard is |
| 011 Verification | SC-AGENT-052 | independent, enforced by the runtime |

## 10–12. Research trust boundary, capture, verification

**Retrieval belongs to Serva, not to the agent.** Every agent's granted policy is
`available: [], network: 'NONE', maxToolCalls: 0` — including SC-AGENT-060, whose contract
declares network scope purely to authorise Serva to retrieve on its behalf.

The one egress point is [`src/intelligence/research/http.ts`](src/intelligence/research/http.ts).
It refuses a redirect to another host, because a redirect is the approved host telling us
to consult one nobody approved. It does not retry: a source that failed to load is
evidence that did not arrive.

Every capture is hashed and expires. `sanitizeForContext` fences it as UNTRUSTED and flags
injection attempts. The **Source Verifier never re-fetches** — its contract declares no
network, and `assertResearchAuthority` refuses it if anything tries.

## 13–16. Competitive, innovation, advantage board, freshness

Table stakes, gaps, differentiators and a `CompetitivePosition`, each citing the captures
it rests on. The Product Advantage Board is a **view** derived from canon, not a stored
document that would start drifting the moment anything upstream changed.

Freshness propagates over a dependency graph to a fixed point, from one subject builder
([`research/subjects.ts`](src/intelligence/research/subjects.ts)) used by both the gate and
readiness — two hand-assembled lists drift, and the drift reads as a conclusion resting on
something "not present" rather than on something stale.

## 17–29. The rest of the company

27 department configurations across 26 stages, all on **one** execution substrate
([`execution/runner.ts`](src/intelligence/execution/runner.ts)). A department is a
configuration, not an engine: it declares which contract, what it may read, what it
produces, who it may not be, and which gate follows. It cannot reorder, skip or soften any
governance step.

Feasibility and risk (risk is **computed**, not reasoned — asking a model to "identify the
risks" produces a plausible list, computing it produces the actual ones). Architecture with
an independent reviewer and complexity that must name the requirement forcing it.
Technology selection with criteria declared before scoring. Data architecture, security and
privacy, infrastructure, cost with every figure stating a source or a basis. UX with state
coverage, a design system with mechanically-checked tokens and RTL rules, and an
`AdminOperabilityReview` for **every** feature. Test strategy and cases. Three deterministic
checkers — traceability/orphans, configuration consistency, design.

## 30. Canonical gate wiring

11 gates defined and wired as **control flow**: INTAKE, DISCOVERY, PRODUCT_VALIDATION,
REQUIREMENTS, COMPETITIVE, FEASIBILITY, ARCHITECTURE, SECURITY_DESIGN, TECHNOLOGY, DESIGN,
PLAN. A gate result controls progression; an undefined gate returns `NOT_VERIFIED` and
halts rather than being skipped — which is how the missing feasibility gate was found.

A gate guarding a **failed** stage is still evaluated (**SF-8**). A department that could
not produce its evidence has not made the gate irrelevant; it has given the gate its
answer.

## 31. Proposal lifecycle

`PROPOSED → ASSESSED → ACCEPTED → INCORPORATED`, with `REJECTED` and `DEFERRED` as real
answers. ACCEPTED requires the assessment and an authority that is not the proposer.
INCORPORATED requires the canon it became to exist. Scope creep is never a decision; it is
a series of small reasonable additions nobody recorded as additions.

## 32. Impact analysis and delta re-entry

Every dimension `SC-POL-013` mandates must be assessed — a missing one is an unfinished
analysis, not a `NOT_AFFECTED`. Re-entry is a **delta**: the entry stage, the later stages
the analysis marked affected, and the stages Serva computes rather than reasons about.

Gate verdicts for re-run stages are dropped, because a verdict is a statement about
evidence that no longer stands. Applying the same change twice is a no-op, ledger included.

## 33. Engineering Readiness Package

Derived, never declared. The required gates come from the **profile being run** rather than
a hand-kept list, so a gate becomes mandatory the moment its stage enters the plan. READY
is mechanically unreachable while any of these hold: a required gate not accepted, an
unresolved owner decision, load-bearing research STALE, a traceability/config/design
failure, a feature with no operability review, a missing independent review, a change not
carried through, or missing minimum canon.

The package holds **references with pinned versions**, not copies.

## 34. Phase 4 handoff

`generateWorkItems` refuses unless READY, and emits work items carrying canon ids in the
prose Engineering reads: `[SC-REQ-…]`, `[SC-BR-…]`, `[SC-NFR-…]`, `[SC-ARCH-…]`,
`[SC-AC-…]`. The real factory accepts them unchanged.

## 35. Organizational learning

The export path **refuses rather than redacts**. A redacted sentence still describes one
client's situation minus the words that made that obvious. On the import side a pattern
arrives as a CANDIDATE and stays unusable until something independent assessed that it
applies here and said how this project differs — prior success is not authority.

## 36. CLI

```
serva intelligence status [<work-item>]      where the company has got to, and what stops it
serva intelligence start "<idea>"            record the idea and run the upstream lifecycle
serva intelligence resume [<work-item>]      continue after answering a decision
serva intelligence decisions                 questions only you can answer
serva intelligence answer <id> --option --by answer one, as yourself
serva intelligence readiness [<work-item>]   derived readiness and every blocker
serva intelligence handoff --base <sha>      what engineering would be given
serva intelligence proposals                 ideas raised, not yet scope
```

Blockers come first and readiness reports reasons rather than a percentage. A status
display that shows progress and hides blockers produces confidence in proportion to how
little it says.

## 37. Offline end-to-end results

| Scenario | Result |
|---|---|
| **A — new product** | 25 departments run; 12 gates evaluated; readiness READY; work item accepted by the real Phase 4 factory |
| **B — major feature** | re-entry re-runs requirements/UX/tests and risk; intake, discovery, product validation and market research stand; upstream evidence byte-identical afterwards |
| **C — research failure** | competitive gate `NOT_VERIFIED`; zero findings, captures, competitor profiles or positions written |
| **D — owner authority** | financial ambiguity stops at `WAITING_FOR_OWNER`; answering resumes; resuming again re-runs nothing |

## 38. Live intelligence result

`npm run test:intelligence-live` — excluded from `npm run verify`, run deliberately.
Results in **Appendix A**.

## 39. Test count

| | |
|---|---|
| Before Phase 5 | 764 |
| After Phase 5 | **901** |
| Pre-existing tests modified | 0 |
| New intelligence test files | 9 offline + 1 live |

## 40. `npm run verify`

```
format:check  PASS
lint          PASS
typecheck     PASS
test          36 files, 901 tests, all green
build         PASS
```

## 41. Dependencies

**None added.** `zod` remains the only runtime dependency. The retriever uses the platform
`fetch`; no HTTP client, no HTML parser, no scheduler.

## 42. SPEC_IMPLEMENTATION_FINDINGS

Six new findings, SF-6 to SF-11, in
[`docs/SPEC_IMPLEMENTATION_FINDINGS.md`](docs/SPEC_IMPLEMENTATION_FINDINGS.md). None was
resolved by editing R4. The most consequential is **SF-11**: R4 requires external research
to be captured but names no retriever, and the gap is load-bearing — if retrieval belongs
to the agent, `19`'s `NEVER_AVAILABLE` becomes a fiction.

## 43. Unresolved limitations

1. **8 of 19 canonical gates are not yet defined.** The 11 that exist are the ones whose
   stages Phase 5 executes. The remainder (IMPLEMENTATION, CODE_REVIEW, QA, SECURITY,
   PERFORMANCE, ACCEPTANCE, RELEASE, INCIDENT_CLOSURE) guard Phase 4 and later stages. An
   undefined gate blocks rather than passes, so this is visible rather than silent.
2. **Learning has no cross-project store.** `contribute*` and `offerCandidate` write into
   the project's own store. A shared library across projects is a Phase 6 concern; the
   wall that protects it is implemented and tested now.
3. **The impact→stage mapping is Serva's, not R4's** (SF-9). Two implementations could
   disagree until R5 publishes it.
4. **No live end-to-end through all 26 departments.** The live suite proves a vertical
   slice by design — running fifty-five agents to learn the same thing would be an
   expensive way to be thorough.
5. **`serva intelligence` has no `change` subcommand yet.** The change runtime is complete
   and tested; only the CLI surface for it is not written.

## 44. Remaining Critical/High issues

**None known.** Everything found during Phase 5 was fixed in Phase 5, including the four
defects the acceptance scenarios were written to look for:

- re-entry re-ran unrelated stages (Scenario B);
- a failed stage left no gate verdict (Scenario C);
- a blocking escalation was reported as an error and its question discarded (live run);
- independence was checked on the actor but not on the context.

## 45. Git commit

`9eef627` on branch `phase-5-company-intelligence`, working tree clean.

## 46. Phase 6 was NOT started

Confirmed. No VS Code extension UI, no dashboard, no conversational interface, no
installer, no bootstrap UX, no backup/restore, no migration UX, no disaster-recovery
wizard, no release company, no cloud operations, no browser/device QA lab, no Serva 1.0
acceptance suite.

The professional backup, restore, migration, new-machine bootstrap and automatic
requalification experience remains a required Serva 1.0 concern. It has not been forgotten
and it has not been built.

---

## Appendix A — live intelligence run

_Filled in below from the actual run._
