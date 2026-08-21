# 11 — COMPETITIVE INNOVATION

**Document ID:** SC-DOC-011
**Status:** BASELINE R4
**Type:** Normative / Process
**Owns:** Market and competitive research method, table-stakes determination, differentiation, opportunity taxonomy, the Competitive Position artifact.
**Does not own:** Proposal mechanics (`10`), product scope decisions (`06` SC-DEPT-010), requirements (`06` SC-DEPT-013).

---

## 1. Mandate

`SC-POL-011` requires Serva Code to answer, with recorded reasoning:

> **Why would a user choose this product over the alternative?**

This document specifies the function that produces that answer, owned by `SC-DEPT-014`.

Two failure modes bound this work on either side, and the whole design is shaped by avoiding both:

| Failure | Symptom | Guard |
|---|---|---|
| **Building correct irrelevant software** | Requirements satisfied; nobody chooses it | Competitive Position is gate-enforced (`SC-POL-011`) |
| **Feature bloat** | Every competitor feature copied; product becomes unfocused and unaffordable | Every finding becomes a scored Proposal, never a requirement (`SC-POL-009`) |

---

## 2. The Alternative Is Always Real

The competitor set is never empty. Every product displaces *something*:

| Situation | The alternative |
|---|---|
| Established market | Existing products |
| New market | Manual process, spreadsheets, messaging apps, paper |
| Internal tool | Doing it by hand, or not doing it |
| Replacement of an owner's own system | The existing system, which has the advantage of already working |

**Rule:** `DiscoveryFindings` MUST record a `CurrentAlternative` per segment (`03` §2, `06` SC-DEPT-011). Competitive analysis without knowing what is being displaced produces a feature comparison against products the user was never going to use.

A `NO_MARKET` classification (permitted by `SC-POL-011` for captive-audience internal tools) still requires naming the alternative and arguing why this product beats it. "There is no alternative" is never accepted; "the alternative is the current manual process, which costs N hours per week" is.

---

## 3. Research Method

### 3.1 Procedure

1. **Frame** — what decision does this research inform? Research with no decision attached is not commissioned.
2. **Define the comparison dimensions before looking** — capabilities, workflows, pricing model, target segment, platform coverage, integration surface, operational burden, support model. Declared first, for the same reason as `09` §7.1: dimensions chosen after seeing the data get fitted to a conclusion.
3. **Identify the competitor set** — direct, indirect, and the non-product alternative. Justify inclusion and exclusion.
4. **Gather** — with sources, retrieval timestamps, and per-claim marking.
5. **Verify** — `SC-AGENT-063` (Source Verifier) confirms that captured sources support the claims made from them. Retrieval is performed by `SC-AGENT-060`; verification works from the captured content, so retrieval and verification remain separable.
6. **Synthesize** — feature comparison, table stakes, gaps.
7. **Set validity** — every finding carries `valid_until`.

### 3.2 Claim marking (the central integrity control)

Every competitive claim carries exactly one marking:

| Marking | Meaning | May support a conclusion? |
|---|---|---|
| `SOURCED(url, retrieved_at)` | Directly evidenced | Yes |
| `OWNER_PROVIDED` | The owner supplied it from their domain knowledge | Yes, attributed |
| `INFERRED(reasoning)` | Reasoned from other evidence | **Only as a hypothesis**, never as the sole basis for a table-stake or differentiator |
| `UNKNOWN` | Could not be determined | No — and must be stated as unknown |

**Why this is the most important rule in this document:** market research is the area where a language model is most likely to produce fluent, specific, confident and entirely fabricated content — competitor feature lists, pricing, market sizes. A false competitive picture corrupts requirements, architecture and product scope simultaneously, and it does so invisibly. Claim marking makes fabrication structurally detectable, and `SC-AGENT-063` makes it checkable.

**When research is impossible** (no network access, no obtainable information), the department reports `RESEARCH_UNAVAILABLE` with the specific questions left open. It does not produce a plausible landscape. The Competitive Gate then returns `NOT_VERIFIED`, and the owner decides whether to proceed with that gap recorded as a risk.

---

## 4. Table Stakes

**Table stakes** are capabilities whose *absence* disqualifies the product, regardless of how good everything else is.

Determination rules:

- **TS-1** A capability is a table stake only if evidenced across the majority of the relevant competitor set, or if its absence is evidenced to cause rejection.
- **TS-2** Table stakes are **not** differentiators. Meeting them earns no advantage; missing them costs the deal.
- **TS-3** Table stakes must be scoped to the segment. What is mandatory for enterprise buyers may be irrelevant for individuals.
- **TS-4** Each table stake produces either a requirement (via a Proposal accepted by Product) or an explicit recorded decision to omit it with the accepted consequence.
- **TS-5** A table stake marked `INFERRED` cannot force a requirement on its own; it becomes an `OPPORTUNITY`-class proposal pending verification.

Table-stakes coverage is checked at the Acceptance Gate: uncovered table stakes must have an owner-acknowledged omission decision.

---

## 5. Opportunity Taxonomy

The assignment lists the opportunity areas this function must scan. Each has a distinct evaluation question — a taxonomy without evaluation questions is just a checklist.

| Area | Scan question | Evaluation question |
|---|---|---|
| **Market gap** | What does no one serve well? | Is it unserved because it is hard, or because it is not wanted? |
| **UX opportunity** | Where is the existing experience painful? | Is the pain frequent and severe enough to drive switching? |
| **Automation** | What manual work do users do around the product? | Can it be automated reliably enough to be trusted? |
| **AI opportunity** | Where would inference add real leverage? | Does it add value beyond novelty, and is its failure mode acceptable? |
| **Retention** | Why do users leave alternatives? | Does this address the actual cause of churn? |
| **Monetization** | How is value captured, and where is the model misaligned? | Does a different model fit this product's usage shape? |
| **Operational advantage** | What is expensive to run for competitors? | Is our advantage structural or temporary? |
| **Cost advantage** | Where can we be materially cheaper? | Does the saving reach the user or only the margin? |
| **Integration** | What do users need this to connect to? | Is the integration a table stake or a differentiator? |
| **Speed/simplicity** | Where are alternatives bloated? | Is simplicity a real advantage for this segment, or a missing feature? |

**The evaluation-question column is what prevents this from producing an idea dump.** Every scanned opportunity must survive its evaluation question before becoming a Proposal.

### 5.1 The AI-opportunity discipline (DERIVED)

AI features are the current default answer to "how do we differentiate", and they carry specific risks this function must assess before proposing:

- What happens when the model is wrong, and who absorbs that cost?
- Is the value contingent on the model, or would a deterministic feature serve better (`SC-POL-017`)?
- What does it cost per use at expected volume (routed to `SC-DEPT-024`)?
- What data leaves the product, and is that acceptable under the data classification (`SC-DEPT-021`, `SC-DEPT-022`)?
- Is the differentiation defensible, or will it be a platform feature within a year?

An AI-opportunity proposal that does not answer all five is incomplete and returns to assessment.

---

## 6. The Competitive Position Artifact

The single artifact that satisfies `SC-POL-011`. Required before the Architecture Gate; must be current at the Acceptance Gate.

```
CompetitivePosition {
  id, project_ref, version, valid_until

  target_segment        : UserSegment ref(s)
  alternatives          : [ { name, type: PRODUCT|MANUAL|STATUS_QUO,
                              strengths[], weaknesses[], claim_markings } ]

  why_chosen            : the core argument, in one paragraph, in user terms
  switching_cost        : what a user gives up to adopt this          # DERIVED
  reason_to_stay        : why they would not go back                  # DERIVED

  table_stakes          : [ { capability, evidence_refs, coverage:
                              PLANNED(req_ref) | DEFERRED(decision_ref) | OMITTED(decision_ref) } ]

  differentiators       : [ { statement, basis, defensibility:
                              STRUCTURAL|TEMPORARY|EXECUTION_DEPENDENT,
                              competitor_coverage: NONE|PARTIAL|MATCHED,
                              evidence_refs } ]

  non_goals             : where this product deliberately does not compete   # DERIVED
  risks                 : competitive risks (fast follower, platform absorption, pricing pressure)
  open_questions        : unresolved competitive unknowns
  confidence            : HIGH | MEDIUM | LOW, with basis
}
```

### 6.1 Field rationale for the derived fields

| Field | Why it was added |
|---|---|
| `switching_cost` | A product can be better and still lose because switching is expensive. Ignoring this produces differentiators that do not convert. |
| `reason_to_stay` | Acquisition and retention are different arguments. `SC-POL-011` asks why a user *chooses*; retention asks why they *keep* choosing, which shapes very different features. |
| `non_goals` | Declaring where the product does not compete is the strongest available defense against feature bloat, and gives Product Management a citable basis for declining proposals. |

### 6.2 Validity rules

- **CP-1** At least one differentiator with `defensibility != TEMPORARY` and `competitor_coverage != MATCHED`, or an explicit owner acknowledgement that the product competes on execution alone.
- **CP-2** Every differentiator's basis must be `SOURCED` or `OWNER_PROVIDED`. An `INFERRED` differentiator is a hypothesis, and must be marked as such in the artifact.
- **CP-3** `valid_until` is mandatory. An expired position blocks the Acceptance Gate until refreshed (`08` §6.3).
- **CP-4** A material change to product scope triggers re-evaluation of the position — dropping the feature that was the differentiator must be visible, and is one of the impact dimensions in `09` §6 (dimension 20).
- **CP-5** `confidence: LOW` does not block, but is carried forward to the owner at Acceptance and recorded as a risk.

---

## 7. Anti-Bloat Discipline

Every competitive finding produces a **Proposal** (`10`), never a requirement, and is scored on the full value/cost/risk model. Additional constraints specific to this department:

- **AB-1** A proposal that copies a competitor feature must state why *this* product's users need it, not that a competitor has it. "Competitor X has it" is an observation, not a reason.
- **AB-2** A proposal that would contradict a `non_goal` in the Competitive Position must argue for changing the position first. Scope discipline is defended at the strategy level, not one feature at a time.
- **AB-3** Proposals are assessed by Product Management, not by the raising agent (`10` §4).
- **AB-4** The department's own health is measured on the ratio of proposals accepted to raised. A very low ratio indicates noise generation; a very high ratio indicates the department is only proposing the obvious.
- **AB-5** A `differentiator` that requires disproportionate cost relative to the whole build is escalated to the owner as a strategic trade-off, not slipped in as a feature.

---

## 8. Continuous Competitive Monitoring

Competitive truth expires faster than any other project truth. Monitoring is not a one-time stage.

| Trigger | Action |
|---|---|
| `valid_until` reached | Refresh research; flag position as `EXPIRED` until refreshed |
| Before any release | Verify the position is current (Release Gate input) |
| Before a major feature decision | Re-check the relevant comparison dimension |
| Incident or churn signal from Operations | Investigate whether a competitive gap is the cause |
| Owner reports a new competitor | Immediate re-scan of that competitor |
| A differentiator is matched by a competitor | Raise `BLOCKING`-class proposal — the reason to win has been lost |

The last row matters: a matched differentiator is a **product emergency**, not a research footnote, and the system must treat it as one.

---

## 9. Interfaces

| Consumer | What it takes from this department | Where it is enforced |
|---|---|---|
| Product Management | Table stakes, differentiators, non-goals, proposals | Roadmap and scope decisions |
| Requirements Engineering | Accepted proposals as requirement sources | `SC-GATE-REQUIREMENTS` |
| UX | Competitive UX findings (INFORM) | `SC-GATE-DESIGN` |
| Architecture | The differentiators the architecture must support well | `SC-GATE-ARCHITECTURE` (entry requires the position, `SC-POL-011`) |
| Acceptance | Position currency and table-stakes coverage | `SC-GATE-ACCEPTANCE` |
| Release | Position currency | `SC-GATE-RELEASE` |
| Continuous Improvement | Post-release competitive signals | Improvement proposals |

The Architecture entry dependency is deliberate and is one of the more unusual edges in the lifecycle graph (`03` §8): **you cannot architect a product whose reason to exist has not been articulated**, because the differentiator is precisely what the architecture must be good at.
