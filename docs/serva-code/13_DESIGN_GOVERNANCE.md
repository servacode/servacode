# 13 — DESIGN GOVERNANCE

**Document ID:** SC-DOC-013
**Status:** BASELINE R4
**Type:** Normative / Process
**Owns:** Design system structure, token taxonomy, component contracts, state coverage, RTL/i18n rules, accessibility governance, design decision and exception mechanics, enforcement.
**Does not own:** UX journey method (`06` SC-DEPT-025), admin surface content (`12`), implementation (`14`).

---

## 1. Mandate

`SC-POL-003`: visual and interaction properties MUST derive from strategy, UX, the design system, accessibility requirements and platform guidelines. An implementer MUST NOT invent them.

Design in Serva Code is treated as an **engineering discipline with an enforcement mechanism**, not as taste applied at the end. The test of whether this document is working is mechanical: a static analysis run over the product code finds zero unapproved literal design values.

---

## 2. Why Design Must Be Centralized Here

| Without central design authority | Consequence |
|---|---|
| Each implementer picks values | Visual entropy; the product looks assembled rather than designed |
| Accessibility checked per screen | Conformance is unprovable; contrast and target-size failures recur |
| RTL handled ad hoc | Directional bugs appear in edge screens indefinitely |
| Component states improvised | Empty/error/loading states missing exactly where they matter |
| Design changes are code changes | A brand change becomes a multi-week refactor |

Centralization also makes design *changeable*. A token-driven system lets a color-system revision propagate in one governed change (`SC-WF-013`) instead of a hunt through the codebase.

---

## 3. Token Taxonomy

Tokens are the SSOT for design (`SC-POL-004`). Three layers, and the layering is normative — it is what makes theming, RTL and accessibility tractable.

| Layer | Contains | Referenced by |
|---|---|---|
| **L1 · Primitive** | Raw values: the color ramp, the type scale, the spacing scale, duration values | L2 only |
| **L2 · Semantic** | Meaning: `surface.default`, `text.primary`, `border.danger`, `space.section`, `motion.enter` | L3 and components |
| **L3 · Component** | Component-scoped: `button.primary.background`, `input.error.border` | That component only |

**Rule TK-1:** product code references L2 or L3. It MUST NOT reference L1 directly. A component using a primitive color instead of a semantic role cannot be themed, cannot be dark-mode-corrected, and cannot be contrast-audited as a set.

### 3.1 Required token categories

| Category | Must define |
|---|---|
| Color | Primitive ramps; semantic roles for surface, text, border, interactive, state (success/warning/danger/info), focus, overlay, disabled |
| Typography | Family stack (including the script coverage needed for the product's languages), size scale, weight scale, line height, letter spacing, text styles as composites |
| Spacing | A single scale; no off-scale values |
| Sizing | Control heights, icon sizes, container widths, minimum touch target |
| Radius | Scale, plus semantic roles (control, container, pill) |
| Elevation | Levels with their shadow/border definitions, and what each level means |
| Motion | Durations, easings, and semantic roles (enter, exit, emphasis, loading); plus reduced-motion equivalents |
| Breakpoints | Named, with the layout behavior at each |
| Z-index | Named layers (base, sticky, dropdown, modal, toast) — never raw numbers |
| Opacity | Disabled, overlay, subtle |
| Border width | Scale |
| Focus | Ring color, width, offset — defined once, applied everywhere |

Z-index and focus are commonly omitted from token sets and are two of the most reliable sources of defects: raw z-index numbers produce stacking bugs that are painful to diagnose, and per-component focus styling produces keyboard-navigation gaps.

### 3.2 Token change governance

A token change is `M3` by default (`SC-WF-013`), because blast radius is every consumer.

| Change | Governance |
|---|---|
| Add a token | Design System decides; recorded |
| Change an L2 semantic value | Impact analysis over consumers + visual regression evidence |
| Change an L1 primitive | Impact analysis over all L2 references + accessibility re-verification |
| Remove/rename a token | CR + migration plan + consumer update in the same change |

---

## 4. Component Contracts

A component is specified before it is implemented. The spec is the contract; the implementation conforms to it.

```
ComponentSpec {
  id, name, version, purpose, when_to_use, when_not_to_use,
  anatomy          : named parts
  props            : typed API with defaults and constraints
  variants         : [ ... ]
  sizes            : [ ... ]
  states           : REQUIRED, see §4.1
  tokens_used      : L2/L3 refs only
  layout_behavior  : responsive behavior per breakpoint
  rtl_behavior     : per §6
  accessibility    : role, name source, keyboard interaction, focus order,
                     required ARIA, contrast obligations, target size
  content_rules    : text length limits, truncation, empty content handling
  composition      : what may contain it, what it may contain
  motion           : which motion tokens, and reduced-motion behavior
  do_not           : explicit misuse list
}
```

### 4.1 Mandatory state coverage

Every interactive component MUST define **all** of:

`default · hover · active/pressed · focus-visible · disabled · loading · error · success (where applicable) · empty (where it holds content) · read-only (where applicable) · selected (where applicable) · RTL variant of each directional state`

Every screen and flow MUST define (`03` §4, UX stage):

`default · empty · loading · partial · error · permission-denied · success · offline (where applicable)`

**Rule CP-1:** a component or screen with an undefined state MUST NOT exit the Design Gate. This is the single most effective control in this document — undefined states are where implementers are forced to invent, and invented states are where accessibility, error handling and RTL correctness all fail simultaneously.

---

## 5. Accessibility Governance

Accessibility is designed by `SC-DEPT-026` (`SC-AGENT-130`, which absorbed the separate accessibility-designer role in R2 because design-side accessibility is token-bound) and **verified independently** by `SC-DEPT-051` (`SC-AGENT-213`). The split implements `SC-POL-006`: the party that designed the affordance may not be the sole party that certifies it.

### 5.1 Target declaration

The project declares a conformance target as an NFR (`03` §3, NFR stage). "Accessible" is not a target; a named standard and level is. If no external standard applies, the project declares an explicit internal criteria set. Silence is not permitted — the NFR dimension must carry a target or `NOT_APPLICABLE(reason)`.

### 5.2 Token-bound accessibility rules

Accessibility obligations are bound to tokens and component specs so they are checkable, not left to per-screen judgment:

| Obligation | Bound to |
|---|---|
| Text and non-text contrast | Semantic color pairs — every foreground/background pairing in the token set is checked as a set |
| Minimum touch/click target | Sizing tokens; component specs |
| Focus visibility | Focus tokens; applied by the component library, never per-instance |
| Keyboard operability | Component spec keyboard interaction section |
| Accessible name source | Component spec `accessibility.name source` |
| Motion safety | Reduced-motion equivalents required for every motion token |
| Text resize / zoom tolerance | Spacing and sizing scales; layout behavior |
| Color-independence | Every state that uses color must also have a non-color indicator |

### 5.3 Verification

| Method | Covers | Evidence class |
|---|---|---|
| Automated checks | Contrast within the token set, ARIA validity, landmark structure, label presence | `EXECUTION` |
| Keyboard traversal test | Focus order, traps, operability | `EXECUTION` (recorded traversal) |
| Structural review | Semantics, name/role/value, heading hierarchy | `JUDGMENT` |
| Assistive-technology testing | Real usability | **`EXPERT_REVIEW_REQUIRED`** where a real conformance claim is being made |

**Honesty rule:** automated checks catch a minority of accessibility defects. Serva Code MUST NOT report a conformance *claim* on automated evidence alone. It reports what was verified and what was not (`SC-POL-012`) — and where a formal conformance claim is required, it raises `EXPERT_REVIEW_REQUIRED` rather than asserting compliance it cannot prove.

---

## 6. RTL, Bidirectionality and Internationalization

Owned by `SC-DEPT-026` with implementation by Frontend/Mobile. Given the owner's context, RTL is treated as a first-class requirement, not a late adaptation.

### 6.1 Rules

- **RTL-1** Directional properties are expressed logically (start/end), never physically (left/right), in both tokens and component specs.
- **RTL-2** Every component spec declares its RTL behavior explicitly: mirrored, not mirrored, or partially mirrored with the parts named.
- **RTL-3** Icons are classified `MIRROR` (directional arrows, progress) or `NO_MIRROR` (logos, clocks, media controls with universal meaning, checkmarks). Unclassified icons are a Design Gate finding.
- **RTL-4** Numbers, dates, currency, phone numbers and code fragments follow their own directionality rules and are specified per locale — not left to the layout direction.
- **RTL-5** Mixed-direction text (Arabic containing Latin identifiers, or the reverse) has specified isolation behavior. This is the most common real-world RTL defect.
- **RTL-6** Typography tokens declare font stacks with adequate script coverage; a font that lacks the product's script is a Design Gate finding.
- **RTL-7** RTL is verified in QA as its own dimension, on real content, not by flipping a flag on a screenshot.

### 6.2 Text as SSOT (`SC-POL-004`)

All user-facing text is centralized. No literal user-facing string in product code. Rules:

- Keys are semantic (`checkout.payment.declined`), not content-derived.
- Translations carry a state: `TRANSLATED | UNTRANSLATED | NEEDS_REVIEW | STALE_SOURCE`.
- Interpolation variables are documented per key so translators cannot break them.
- Pluralization and gender rules are specified per language, not approximated from English.
- Text length variance is a layout requirement: components declare their tolerance.

---

## 7. Enforcement

`SC-POL-003` is enforced mechanically. Without enforcement it is a preference.

| Check | Detects | Where | Result |
|---|---|---|---|
| Literal-value scan | Hard-coded colors, sizes, spacing, radii, shadows, durations, z-index in product code | Static analysis at build | Code Review FAIL |
| Primitive-reference scan | L1 tokens referenced from product code (TK-1) | Static analysis | Code Review FAIL |
| Token coverage report | Tokens defined but unused; values used but untokenized | Design Gate | Finding |
| Component conformance | Implementation missing a specified state | Code Review + QA | FAIL |
| Contrast audit | Semantic color pairs failing the declared target | Design Gate + QA | FAIL |
| Focus style presence | Components without the standard focus treatment | Static analysis + keyboard test | FAIL |
| String literal scan | User-facing literals outside the text SSOT | Static analysis | Code Review FAIL |
| Physical-direction scan | `left`/`right` used where logical properties are required | Static analysis | Code Review FAIL |
| Visual regression | Unintended visual change from a token or component change | `SC-WF-013` | Gate evidence |

### 7.1 Design exceptions

Where a literal value is genuinely necessary:

```
DesignException {
  id, scope (named component/file), value, reason,
  why_no_token_fits, approver (Design System authority),
  expiry | migration_plan, state: ACTIVE | EXPIRED | MIGRATED
}
```

- **DE-1** Exceptions are scoped to a named location. There is no project-wide exception.
- **DE-2** Exceptions expire or carry a migration plan. An indefinite exception is a token gap in disguise — if a value is needed permanently, it should become a token.
- **DE-3** Active exceptions are visible at the Design Gate and counted as a health metric. A growing exception count means the token set is inadequate, which is a Design System finding, not an implementation problem.
- **DE-4** An exception may never be used to bypass an accessibility obligation.

---

## 8. Design Decisions

Design decisions follow `09` with the `DESIGN` domain. Decisions required at minimum for:

- The overall design direction and its relationship to brand and to the target segment.
- The color system, including semantic role assignment and the dark/light strategy (or the decision not to have one).
- The type scale and font selection, including script coverage.
- The spacing and layout system.
- The component library approach: built, adopted, or adapted — with the evaluation behind it (`SC-POL-016` applies to design tooling too).
- The accessibility target.
- The RTL strategy.
- The motion philosophy, including the reduced-motion posture.
- Platform-convention deviations, each individually.

**Rule:** "it looks better" is not a rationale. A design decision's rationale must reference the product's users, the brand strategy, an accessibility obligation, a platform convention, or a usability principle applied to this product's specific context. Governance audits design decisions for the same theater patterns as any other decision (`09` §4.2).

---

## 9. Design Gate Criteria (summary)

Full gate definition in `18`. Design passes when:

| # | Criterion | Evidence |
|---|---|---|
| 1 | Every journey has flows; every flow has complete state coverage | State coverage report |
| 2 | Every component in use has a spec with all mandatory states | Component inventory vs. spec |
| 3 | Token set complete across required categories | Token coverage report |
| 4 | Contrast audit passes for the declared target | Automated contrast report |
| 5 | RTL behavior specified for every directional property and every icon | RTL specification review |
| 6 | Accessibility target declared and design obligations bound to tokens/specs | Accessibility spec |
| 7 | Text SSOT established; no user-facing literals planned in code | Text register |
| 8 | Design decisions recorded with rationale | Decision records |
| 9 | Active exceptions justified and within limit | Exception register |
| 10 | Admin surface uses the same system (`12` §7) | Design coverage of admin |

Criteria 1–5 and 7 are mechanically checkable; 6, 8, 9, 10 are `JUDGMENT` with named criteria (`16` §5).

---

## 10. Failure Modes

| ID | Failure | Countermeasure |
|---|---|---|
| `DG-1` | Token set exists but code ignores it | Static analysis enforcement (§7) |
| `DG-2` | Semantic layer skipped; components use primitives | TK-1 + primitive-reference scan |
| `DG-3` | Component states undefined; implementers invent | CP-1 blocks the Design Gate |
| `DG-4` | Accessibility asserted from automated checks alone | §5.3 honesty rule; `EXPERT_REVIEW_REQUIRED` for conformance claims |
| `DG-5` | RTL treated as a late flip | RTL-1..RTL-7; logical properties enforced by scan |
| `DG-6` | Exception register grows silently | DE-3 health metric at Design Gate |
| `DG-7` | Admin UI styled separately | `12` §7; design coverage includes admin |
| `DG-8` | Token change ships without visual regression evidence | `SC-WF-013` mandates it |
| `DG-9` | Design produced generically, not for this product's segment | Decision rationale must cite segment/brand/usability specifics |
| `DG-10` | Dark mode / theming retrofitted later | Theming posture is a required design decision (§8) |
