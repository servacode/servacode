# 25 — OPEN QUESTIONS AND RISKS

**Document ID:** SC-DOC-025
**Status:** BASELINE R4
**Type:** Register
**Owns:** Unresolved decisions and the risk register for Serva Code itself.
**Does not own:** Answers. This document deliberately contains no invented resolutions (`SC-POL-012`).

---

## 1. Purpose

Two registers:

- **Open Questions (§2)** — decisions Phase 1 deliberately did not make, each with who must decide, what it blocks, and the cost of deferring.
- **Risks (§3)** — risks in Serva Code's own design, with exposure and mitigation status.

Items here are **genuinely unresolved**. Where Phase 1 made a decision, it is in the relevant document, not deferred here. Where Phase 1 found something it could not settle, it is recorded here rather than answered plausibly.

---

## 2. Open Questions

Format: `SC-OQ-###` · what · who decides · blocks · cost of delay · Phase 1's leaning (where it has one).

### Owner decisions (business/strategy)

**SC-OQ-001 — What is Serva Code's own scope ceiling?**
Serva Code is specified to build "software products" generically. Web, mobile, desktop, CLI, embedded, data pipelines and ML systems have materially different lifecycles and evidence models.
*Decides:* Owner. *Blocks:* Technology selection for Serva itself; the breadth of the department applicability rules. *Cost of delay:* moderate — building for maximum generality risks a system that fits nothing well. *Leaning:* narrow 1.0 to the project types the owner will actually build first, and record the exclusion rather than pretending generality.

**SC-OQ-002 — Is Serva Code single-owner permanently, or eventually multi-user?**
1.0 is single-owner (`00` NG1). Multi-user later would change authority, permissions, audit and concurrency substantially.
*Decides:* Owner. *Blocks:* Whether `actor` modeling anticipates multiple humans now. *Cost of delay:* low if `actor` is modeled as an entity from the start; high if it is hard-coded as "the owner". *Leaning:* model `actor` generally in 1.0; build no multi-user features.

**SC-OQ-003 — How much autonomy does the owner actually want?**
The specification permits a wide band: from confirming every task to reviewing only at gates and reserved boundaries. The band is bounded by `SC-POL-030`, but within it the default matters enormously for usability.
*Decides:* Owner. *Blocks:* Notification design, gate blocking defaults, batching thresholds. *Cost of delay:* high — this shapes the entire interface. *Leaning:* start conservative (more pauses), loosen with recorded evidence of trust.

**SC-OQ-004 — What consumption budget is acceptable per project?**
`SC-POL-028` requires budgets; it does not set them. A multi-department organization with verifier-heavy staffing is expensive per unit of work.
*Decides:* Owner. *Blocks:* Default budgets, concurrency caps, research depth defaults. *Cost of delay:* high — an unbudgeted first project could be very expensive.

### Engineering decisions deferred to a later phase

**SC-OQ-005 — Serva Code's own implementation stack.**
Deferred by instruction (`00` NG6). Must follow `SC-POL-016` against the requirements in `27`.
*Decides:* Architecture, after `27` is complete. *Blocks:* Phase 2 onward.

**SC-OQ-006 — Store technology.**
Constrained by `21` §3 (`ST-1..ST-10`), particularly `ST-2` (inspectable without Serva) and `ST-4` (append-only at the storage layer).
*Decides:* Data Architecture. *Blocks:* Everything persistent. *Note:* `ST-2` and `ST-4` together are a genuinely constraining pair and may not be satisfiable by a single technology — a hybrid may be required.

**SC-OQ-007 — How is `EXECUTION` evidence captured when the engine calls tools directly?**
The forgery boundary (`16` §3.2) requires the runtime to capture tool results. If the engine executes tools through its own harness rather than through Serva's mediator, provenance cannot be guaranteed.
*Decides:* Architecture + Security Architecture. *Blocks:* `SC-POL-023` enforceability — **the foundation of the entire evidence model**. *Cost of delay:* critical.
*Feasibility assessment (R2):* **technically promising, unproven.** The agent platform provides pre-tool-use hooks and structured tool-event reporting (`33` §4), which give a defined interception point at which the runtime — not the model — can observe the invocation and capture its result. That is the mechanism the forgery boundary needs. It is not yet evidence that the mechanism is *complete*: it must be shown that no invocation path bypasses interception, and that captured results come from the execution path rather than from model-authored text.
*Path to closure:* qualifications `QR-03`, `QR-08` and above all **`QR-09`** (`33` §6). Until `QR-09` passes with captured evidence, `16` §3.2 states an intended guarantee, not a demonstrated one.
*If it fails:* `33` QG-3 applies — the specification is amended to state the actual guarantee, and `SC-RISK-001` moves from mitigated-in-design to materialized. **The claim is not retained.**

**SC-OQ-008 — How is agent context and filesystem reach restricted per run?**
`CX-6` (test designers must not see the implementation) is a context-construction rule. If the engine has broad filesystem read access, the restriction is advisory rather than enforced.
*Decides:* Architecture + Security Architecture. *Blocks:* `15` TD-8 enforceability, `SC-AGENT-211`'s existence justification.
*Feasibility assessment (R2):* **technically promising, unproven.** The platform provides permission modes with deny-by-default postures, allow/deny rules, and filesystem permission rules, with pre-tool-use hooks as a second enforcement point (`33` §4). Together these plausibly deliver per-run read and write scoping at boundary `CB-1`/`CB-3`.
*Important qualification added in R2:* `CB-1` and `CB-3` are **harness-level policy**, not OS isolation (`33` §2.1). On a substrate without process sandboxing — which includes native Windows (`33` §3) — enforcement is `SOFT`, and `SC-POL-026` is satisfied at L3 rather than L1.
*Path to closure:* `QR-01`, `QR-02`, `QR-04`, `QR-05`, `QR-14`.
*If it fails:* `CX-6` degrades to an L5 instruction and MUST be labelled as such wherever it is claimed, rather than described as enforced.

**SC-OQ-009 — Gate engine determinism vs. judgment criteria.**
Many criteria resolve on a `JUDGED` **basis** (`31` §2). If a large share of gate criteria end up judged rather than measured, gates become AI evaluations wearing a deterministic label.
*Decides:* Architecture + Governance. *Blocks:* Credibility of `18`. *Leaning:* measure the deterministic/judged ratio per gate and treat a high judged share as a design defect to be reduced, not a fact to be accepted.

**SC-OQ-010 — How are lifecycle profiles tuned without eroding them?**
`PR-3` allows upgrade freely and requires a decision to downgrade (`03` §7.1). Over time, downgrade pressure is constant. The erosion detectors (`18` §7) observe it, but no threshold is defined.
*Decides:* Governance + Owner. *Blocks:* Long-term integrity. *Cost of delay:* low initially, high cumulatively.

**SC-OQ-011 — What is the minimum viable department set for the first real project?**
The full department, agent and runtime-component set (`30`) is a large surface to implement. A staged rollout is likely necessary, but staging must not silently disable assurance.
*Decides:* Architecture + Product. *Blocks:* Phase planning. *Leaning:* Tier 1, Tier 5 and Requirements first — assurance and definition before production breadth, since those are what make the rest trustworthy.

**SC-OQ-012 — How is the bootstrap gap closed (`SC-POL-034`)?**
Serva Code must govern its own construction, but cannot until it exists.
*Decides:* Owner + Governance. *Blocks:* Compliance with `SC-POL-034`. *Leaning:* maintain the records manually against these schemas during bootstrap, and record the gap explicitly as a known non-conformance rather than ignoring it.

**SC-OQ-013 — Are judged-basis results from an AI verifier meaningfully independent?**
`SC-POL-006` separates roles and sessions, but executor and reviewer may be the same underlying model with correlated blind spots. Structural separation may deliver less independence than it appears to. This affects every `CriterionEvaluation` with basis `JUDGED` and every `ArtifactVerifierResult` (`31` V3b).
*Decides:* Governance + Architecture. *Blocks:* Honest characterization of assurance strength. *Leaning:* state the limitation explicitly in `16` §10 (done), and prefer deterministic evidence wherever it is obtainable rather than relying on independence that may be partly nominal.
*This question deserves particular attention: it is the most likely place where Serva Code's guarantees are weaker than they appear.*

**SC-OQ-014 — What happens when the owner disagrees with a gate?**
There is no override (`18` §6); there are only scoped waivers. If the owner finds this too rigid in practice, the pressure will be to add an override — which would be the beginning of erosion.
*Decides:* Owner. *Blocks:* Nothing now; matters after first friction. *Leaning:* hold the line on waiver-only, and treat frequent waivers as a signal to fix the criterion rather than to add an escape hatch.

**SC-OQ-015 — Retention defaults for evidence content.**
Evidence artifacts (logs, screenshots, reports) will dominate storage growth. `RT-2` protects bound evidence, but defaults are unset.
*Decides:* Owner + Operations. *Blocks:* Long-running project viability.

**SC-OQ-017 — On which substrate will governed runs execute on the owner's Windows machine?** *(New in R2, Correction 9.)*
Native Windows is not a supported sandbox platform (`33` §3). Serva Code can run natively at `SOFT` enforcement, or under WSL2 (or a proven equivalent) at `HARD` enforcement.
*Decides:* Owner + Architecture. *Blocks:* the strength of every capability claim, and therefore the honesty of `05` §8 L1. *Cost of delay:* high — it changes what the system may truthfully assert about itself.
*Leaning:* support both, detect the class, and make the difference visible per `PC-5`–`PC-10` rather than choosing for the owner. The owner then decides whether `SOFT` is acceptable for their work, with the consequence stated rather than buried.

**SC-OQ-018 — What is the acceptable ratio of `JUDGED`-basis to `MEASURED`-basis criteria per gate?** *(New in R2; sharpened in R3.)*
Now precisely expressible: every `CriterionEvaluation` carries a basis (`31` §2), so the ratio is directly countable per gate. A gate whose criteria are mostly judged is an AI evaluation wearing a deterministic label. `18` §7 tracks the rising-judged-share trend as an erosion signal.
*Decides:* Governance + Architecture. *Blocks:* credibility of `18`. *Leaning:* measure the ratio per gate, publish it, and treat a high judged share as a design defect to reduce rather than a fact to accept.

**SC-OQ-016 — How is competitive research performed without reliable network access?**
`11` §3.2 requires `RESEARCH_UNAVAILABLE` rather than invention, which is correct but leaves `SC-POL-011` unsatisfiable in an offline context.
*Decides:* Owner. *Blocks:* `SC-GATE-COMPETITIVE` in offline conditions. *Leaning:* permit owner-provided market knowledge as `OWNER_PROVIDED` evidence (already modeled), and accept a lower-confidence position with a recorded risk.

---

## 3. Risk Register — Serva Code's Own Design

Exposure = probability × impact. `M` = mitigation status.

### The ten largest risks

**SC-RISK-001 — Evidence capture cannot be guaranteed (the forgery boundary fails)**
If the runtime cannot independently capture tool execution results, `SC-POL-023` becomes advisory and every gate can be passed by a confident sentence. This would invalidate the central claim of the entire system.
*Probability:* Medium — **reduced in R2** from the R1 assessment, because a defined interception mechanism now appears to exist (`33` §4) · *Impact:* Critical · *Exposure:* **Highest**
*M:* Partial — designed (`16` §3.2, `19` §5); mechanism identified but unqualified (`SC-OQ-007`); closure path defined (`QR-09`); documented consequence if it fails (`33` QG-3, which requires amending the claim rather than retaining it).

**SC-RISK-002 — Governance erosion under throughput pressure**
Individually reasonable relaxations accumulate until gates are ceremonial while still producing green verdicts. The most likely long-term failure mode, and the hardest to notice from inside.
*Probability:* High · *Impact:* High · *Exposure:* **Very high**
*M:* Partial — asymmetric change governance (`18` §9, `07` §9), erosion metrics (`18` §7). No threshold defined (`SC-OQ-010`).

**SC-RISK-003 — Cost makes the system impractical**
A 30-department, verifier-heavy organization with review loops may cost more per feature than the owner will tolerate, leading to systematic profile downgrading — which routes back into RISK-002.
*Probability:* High · *Impact:* High · *Exposure:* **Very high**
*M:* Partial — budgets (`SC-POL-028`), tailoring (`SC-POL-024`), loop breaker (`04` §8.3), research depth scaling (`09` §7). Unquantified until measured (`SC-OQ-004`).

**SC-RISK-004 — Verifier independence is nominal, not real**
Same-model executor and reviewer share blind spots. Structural separation may deliver less assurance than the architecture implies, while producing records that look rigorous.
*Probability:* High · *Impact:* High · *Exposure:* **Very high**
*M:* Partial — deterministic evidence preferred (`16` §3.1), limitation stated (`16` §10). No structural fix available (`SC-OQ-013`).

**SC-RISK-005 — Specification complexity exceeds implementability**
The catalogues in `30` §11 specify a large surface — departments, agents, runtime components, stages, gates, workflows and policies — plus the entity model in `08` §3. Phase 2 may not be able to build all of it, leading to partial implementation where the unimplemented parts are silently assumed to work.
*Probability:* High · *Impact:* High · *Exposure:* **Very high**
*M:* Partial — staged rollout intended (`SC-OQ-011`). **Mitigation must include recording what is not implemented as an explicit non-conformance**, so that unbuilt governance is never mistaken for working governance.

**SC-RISK-006 — Store corruption or loss**
The store is irreplaceable project memory. Loss destroys every decision, rationale and piece of evidence.
*Probability:* Low-Medium · *Impact:* Critical · *Exposure:* High
*M:* Good — transactional semantics (`21` §4), integrity checks (`21` §6), verified backups (`21` §7), recovery procedures (`22` §5).

**SC-RISK-007 — Owner attention exhaustion**
Notifications, questions, proposals and digests exceed what the owner will read. `SC-POL-008` and `SC-POL-012` both depend entirely on the owner actually seeing things, and both fail silently when attention fails.
*Probability:* High · *Impact:* High · *Exposure:* High
*M:* Partial — batching and thresholds (`10` §7), volume as a health metric (`20` NT-1). No technical fix exists for a human who stops reading.

**SC-RISK-008 — Prompt injection via repository or research content**
A local system with filesystem and network tools reading untrusted content is a realistic injection target.
*Probability:* Medium · *Impact:* High · *Exposure:* High
*M:* Good — capability boundary as primary defense (`SC-POL-026`), trust marking as defense in depth (`SC-POL-027`), owner-reserved actions as a floor (`SC-POL-030`).

**SC-RISK-009 — Workspace divergence normalizes**
The owner edits directly, reconciliation fires constantly, and adoption becomes reflexive — until the store's account of how artifacts were produced is fiction.
*Probability:* High · *Impact:* Medium-High · *Exposure:* High
*M:* Partial — reconciliation (`21` §10), explicit adoption (`RE-1`), gate blocking (`XC-7`). Behavioral, not technical.

**SC-RISK-010 — The system produces confident, fluent, wrong artifacts**
Fabricated user research, invented competitor facts, plausible business rules, hallucinated pricing. Distinct from RISK-001: here evidence is honestly absent, but the *content* is invented and presented as analysis.
*Probability:* High · *Impact:* High · *Exposure:* High
*M:* Partial — source/claim marking throughout (`08` §3 `source`, `11` §3.2), `PROPOSED` rules requiring confirmation (`06` SC-DEPT-012), `INFERRED` markings unable to support conclusions. Marking reduces the risk; it does not eliminate it.

### Additional risks

| ID | Risk | P | I | Mitigation status |
|---|---|---|---|---|
| SC-RISK-011 | Engine behavior changes underneath, invalidating assumptions | M | M | Capability probing (`19` §7); adapter isolation |
| SC-RISK-012 | Rework loops consume budget without converging | M | M | Loop breaker (`04` §8.3) |
| SC-RISK-013 | Traceability becomes bookkeeping theater | M | M | Orphan detection is mechanical (`08` §5.1) |
| SC-RISK-014 | Departments produce generic rather than project-specific output | H | M | Quality criteria in contracts; decision-theater audits (`09` §4.2) |
| SC-RISK-015 | The proposal register becomes unread noise | H | M | Flood controls + health metrics (`10` §10) |
| SC-RISK-016 | Concurrency defects corrupt state | M | H | Write-set locking, snapshot isolation (`21` §5) |
| SC-RISK-017 | Store schema migration failure | L | H | Versioned reversible migrations (`ST-6`), pre-migration snapshots |
| SC-RISK-018 | Accessibility/security claims overstated | M | H | Honesty rules (`13` §5.3, `16` §10), mandatory expert domains (`17` §8) |
| SC-RISK-019 | Cross-project learning contaminates a new project | L | M | `CANDIDATE`-only interface (`21` §8.1), applicability assessment |
| SC-RISK-020 | The owner bypasses Serva entirely for speed | H | H | UX-3 visibility; **but ultimately a value proposition problem, not a control problem** |
| SC-RISK-021 | **Enforcement is `SOFT` and the system describes it as `HARD`** — every capability claim overstated | M | H | `33` PC-5–PC-10: detect, declare, and qualify every affected verdict. New in R2 |
| SC-RISK-022 | **Provider behavior changes and governance silently depends on it** — e.g. a hook mechanism is removed, or authentication silently reroutes to a billed path | M | H | `SC-POL-035`; capability detection; `PC-14` no-silent-fallback; adapter boundary. New in R2 |
| SC-RISK-023 | **Specification counts drift from content again** — the R1 defect recurs | M | M | `30` is the single catalogue; `CAT-2` forbids counts elsewhere; `DC-3`, `DC-8`, `DC-12` check it. New in R2 |
| SC-RISK-024 | **Event-sourced run model adds complexity that is implemented partially** — projections drift from logs | M | H | `KI-1b`, `KI-1c`, `RI-8`: the log is authoritative and projections are rebuilt, not trusted. New in R2 |

SC-RISK-020 is worth stating plainly: **if using Serva Code is slower and more tedious than not using it, the owner will not use it, and every control in this specification becomes irrelevant.** Mission ordering (`00` §2) puts throughput third — correctly — but third is not last, and a system that ignores it will be abandoned rather than eroded.

---

## 4. What Phase 1 Considers Unsettled

Consolidated for the Phase 1 report:

1. Whether the evidence forgery boundary is achievable in practice — mechanism identified, unqualified (`SC-OQ-007`, `QR-09`, `SC-RISK-001`).
2. Whether verifier independence is real or nominal (`SC-OQ-013`, `SC-RISK-004`).
3. Whether the cost of this governance is acceptable at real project scale (`SC-OQ-004`, `SC-RISK-003`).
4. Whether the specification is implementable at this scope (`SC-RISK-005`, `SC-OQ-011`).
5. Whether per-run filesystem and tool scoping is enforceable, and at what strength (`SC-OQ-008`, `QR-01`–`QR-05`).
6. Which substrate governed runs will execute on for a Windows owner, and therefore whether enforcement is `HARD` or `SOFT` (`SC-OQ-017`).
7. What the `MEASURED`-basis to `JUDGED`-basis criterion ratio in gates will actually be (`SC-OQ-009`, `SC-OQ-018`).
8. The owner's autonomy preference, which shapes the entire interface (`SC-OQ-003`).
9. Serva Code's project-type scope ceiling (`SC-OQ-001`).
10. Store technology under the `ST-2`/`ST-4` constraint pair (`SC-OQ-006`).
11. How the bootstrap non-conformance is recorded and closed (`SC-OQ-012`).

**None of these were resolved by assumption.** Each is recorded here rather than answered plausibly, which is the behavior `SC-POL-012` requires of the system and which Phase 1 applies to itself.
