# SERVA CODE 1.0 — PHASE 6 FINAL REPORT

| | |
|---|---|
| Accepted Phase 5 baseline | `0a8c70a` — confirmed in ancestry, tree clean, 44 files / 1012 tests |
| Branch | `phase-6-serva-code-1.0` |
| Implementation commit | **`31d1f74`** |
| Tests | **50 files, 1146 tests**, all passing |
| Lifecycle coverage | **26/26** |
| Gate coverage | **19/19** |
| Acceptance matrix | **33/33 rows covered** |
| `serva acceptance` | **NOT READY** — two items unproven, named below |
| Phase 6 commits | 13 |

**Serva Code 1.0 is not declared ready.** Two of fifteen acceptance lines are unproven, and
the product refuses to print `READY FOR OWNER USE` on that basis. That refusal is the single
most important behaviour in this report, and §63 asked for exactly it.

---

## 1. Accepted Phase 5 baseline

`0a8c70a2141cdf4ba1d19b7662575e9da95e4d7e` — verified as an ancestor of HEAD before any work
began, with a clean tree and `npm run verify` reporting 44 files / 1012 tests. Phases 1–5
were not reopened.

## 2. Phase 6 implementation commit

**`31d1f74`** — *the live acceptance ran, blocked honestly, and found a defect in my doctor*.
The last commit that touches `src/` or `tests/`. Thirteen commits in all, each one a working
milestone.

## 3. VS Code extension architecture

**The extension is a client.** Everything of substance lives in `src/` and is covered by the
ordinary suite: `src/app/services.ts` (the derived snapshot), `src/app/actions.ts` (the
validated action registry), `src/extension/protocol.ts`, `src/extension/render.ts`,
`src/extension/i18n.ts`. `extension/src/extension.ts` is the adapter — it knows about VS Code
and nothing about governance.

That split is why the security properties are testable at all. An extension whose escaping
and dispatch live inside an activation function has security that can only be verified by
running VS Code, which in practice means it is verified by hope.

The extension typechecks and builds as part of `npm run verify`, so it cannot rot while the
core moves.

## 4. Project auto-discovery and resume

Activation is `workspaceContains:.serva/SCHEMA_VERSION` — never `*`. On activation Serva
opens the Store, reconstructs the lifecycle from the persisted record, derives status, and
shows it. **It spends nothing:** no model call, no repair, no company start. `serva.refresh`
re-opens the Store rather than reusing the handle, because the point of a refresh after an
external change is to read what is actually on disk.

`untrustedWorkspaces.supported: false`, with the reason in the manifest.

## 5. Control Center

Sections for overview, decisions, lifecycle stages, blockers, expired facts, release
readiness and machine qualification — rendered from one snapshot, so the picture existed at
a single moment rather than being assembled from a dozen accessors that disagree.

The status bar derives from the same snapshot. There is no path that sets it, because one
would eventually be called on activation and an owner would read a tick as a governed
company.

## 6. Owner action UX

Every question carries the recommendation, the reasoning, why Serva cannot decide it, and
what each option means. OPTION and VALUE decisions are distinguished. Answering routes
through `answerOwnerDecision` — the same governed function the CLI calls — which refuses an
agent-attributed answer, free text where options were offered, and a meta-option where a
value was asked for.

## 7. Direct-Claude use and divergence

`ProjectHealth.DIVERGENCE` outranks a block and a question in the status precedence, and the
snapshot carries it end to end. Serva does not adopt outside changes silently and does not
delete them.

**Limitation, stated plainly:** the divergence *detection* is Phase 4's `reconcile`, and the
Phase 6 work surfaces the state and the choice. The full reconciliation UX — classify by
kind, propose a ChangeRequest, run the impact analysis from the panel — is represented in the
status model and is not built as a panel workflow.

## 8. Lifecycle coverage — 26/26

`src/coverage/index.ts` computes it from the catalogue, the department registry the
orchestrator actually runs, and the gate definitions the gate engine actually evaluates.
Nothing is a hand-maintained table.

`UNCOVERED` is a real outcome and `tests/coverage.test.ts` refuses it, so "we never got to
it" has to be written down to count. `EXTERNAL_STAGES` ended up **empty**, which is the
finding: every canonical stage has a department or the factory behind it.

Phase 6 added the seven that were open: 042 QA, 043 security testing, 044 performance, 045
acceptance, 050 release, 052 operations, 054 incident.

## 9. Gate coverage — 19/19

Seven downstream gates added in `src/intelligence/gates/downstream.ts`, evaluated by the same
Phase 2 gate engine. `SC-GATE-CODE_REVIEW` is deliberately **not** redefined — Phase 4 owns
it against real engineering evidence, and two definitions of one gate would be two answers to
one question.

Every criterion defaults to `INDETERMINATE` on missing evidence, asserted for all nineteen.
Every downstream verdict criterion requires independence, except `RL-2`, which is the Release
Manager's own recommendation and is advice rather than clearance.

`RL-1` is the criterion no agent can satisfy: the owner authorised this release. It is a
Store query with no verifier role that could reach it.

## 10. Downstream quality and release company

Eleven departments using the canonical roles that already existed — 213, 214, 220, 230, 240,
250, 251, 260, 262, 270, 271. **No agent id was invented.** All run on the same substrate,
through the same `ScopedCanonWriter`, under the same independence rule, and all pass
`validateDepartmentAuthority`.

Three properties are enforced rather than intended:

- `NOT_VERIFIED` is a first-class verdict everywhere and it blocks.
- `notVerified` is a separate field from findings, because "I checked and it is wrong" and "I
  could not check" are different results and merging them turns an unexamined area into a
  clean one.
- **Serva overrides a run that claims too much.** A performance verdict reporting PASS with
  unmeasured targets becomes `NOT_VERIFIED`; so does an acceptance verdict covering only some
  criteria. Computed from the Store, not taken on trust.

## 11. Incident and improvement loop

`Incident` → severity → containment → `ChangeRequest` → verification → release →
`PostIncidentReview`. The commander establishes and records; it does not fix, because
containment under pressure and a governed change are different acts and merging them is how
an emergency patch becomes permanent undocumented behaviour.

`contributingConditions` is required and non-empty: a review naming one line of code has
explained the symptom, and the same incident returns with a different line number. Corrective
actions are `Proposal`s — an incident is not a licence to enlarge the product.

`profileForIncident` maps severity to a re-entry profile deterministically.

## 12. Organizational learning store

`src/learning/library.ts`. One machine, no server, no account, no sync. **Off by default** —
a feature that moves material between clients' projects is not something to opt somebody out
of. A disabled library reads and writes nothing at all.

The wall is checked **again** on publication, because that is the last code that runs before
a sentence leaves the project that produced it. Provenance records kind, time and a content
digest — never which project, client or directory — and the provenance view states what Serva
deliberately does not know.

**Writing the door exposed three holes in the wall**, harmless while a lesson stayed inside
its project and not harmless once one can cross: a forward-slash Windows path, an instance
artifact id, and inline backticked code. All three closed, with the id rule matching the
numeric *shape* so `SC-REQ-000042` is refused and `SC-GATE-QA` — the shared vocabulary a
general lesson needs — is not.

## 13. Machine doctor

Inspects; repairs nothing. Every non-READY check carries a remedy. Says "signed in" and never
who.

**It was wrong three times, and each was found by running it rather than reading it:**

1. `run()` treated "succeeded and printed nothing" as failure. `wsl -e true` is exactly that,
   so a healthy WSL installation read as absent.
2. Eight separate `wsl.exe` invocations, each with its own timeout, produced a patchwork of
   READY and UNKNOWN describing one machine. The guest is now asked once.
3. **It reported `Claude subscription: READY` and `Sandbox: READY` on a machine where the
   factory refused for exactly those two things.** A credentials FILE read as an
   authenticated SESSION, and bubblewrap checked in place of the mechanism that contains a
   Producer.

The third is the one that matters. `CLAUDE_AUTH` now has no branch that returns READY from a
file — the best it reaches is `UNKNOWN`, naming `serva engineering doctor` as the authority
that asks the engine — and `SANDBOX_PRODUCER` is a separate check stating that bubblewrap is
not a substitute. The doctor now names the same prerequisites the factory refuses on.

## 14. Machine bootstrap

**Not built as a command.** `serva machine doctor` names every missing prerequisite with the
exact remedy, and `serva migrate` sequences them for a new computer. What does not exist is a
guided flow that performs the OS changes.

That is a deliberate limitation rather than an oversight: the two prerequisites this machine
is missing are an authenticated engine and a globally installed sandbox runtime, and Serva's
own stated rule is that it installs neither and never logs in on the owner's behalf. A
bootstrap command that did the safe parts and stopped at those two would be a thin wrapper
over the doctor's output. It is listed as a remaining item rather than claimed.

## 15. Backup

`serva backup --to <path> --confirm`, and **Serva: Create a verified backup** in VS Code.
Both call the same service.

A directory bundle with a manifest, not an archive — Serva has one runtime dependency, and
the one code path that consumes attacker-influenced input is the worst place to add an
unaudited tar or zip parser.

Credentials are excluded by path **and** by content scan, so a key pasted into a note is
refused too. Machine-bound families are excluded and named in the manifest. Everything left
out is listed with its reason.

## 16. Backup verification

The writer re-opens what it wrote, re-hashes every file, compares against the manifest, and
only then renames the staging directory into place. A bundle at the final path is one that
has already been read back successfully.

Verification also reports files present but unlisted, missing files, size mismatches, symlinks
and a manifest that fails its own digest — collected rather than thrown on the first, because
an owner staring at a possibly-corrupt backup needs to know whether one file is damaged or all
of them.

## 17. Restore

Two halves, and the first never writes. `inspectRestore` verifies, resolves the version, plans
any migration, and reports what would happen — including what will **not** come back. `serva
restore` without `--confirm` is exactly that, which is the behaviour somebody wants at 2am
when they are not sure which backup they are holding.

Restoring over a different project is refused without explicit confirmation, and displaced
contents are moved aside rather than deleted.

## 18. Schema migration

Forward, visible, snapshot-first, and refuses the unknown. A backup from a newer Serva is
refused rather than read partially, because a restore that silently discards fields it did not
understand leaves the owner no way to know what went missing.

The registry is **empty at 1.0** — the honest state, since there is no earlier released
format — and the machinery is tested so the first real migration is a data change rather than
an architecture written under pressure.

## 19. New-machine migration

`serva migrate` prints the sequence and reports where this machine stands. `evidence/PORTABILITY_WALKTHROUGH.txt`
records a real one performed on this computer: disposable project → verified backup →
inspection → restore into a fresh location → inventory equivalence → no machine-bound family →
no credential → doctor.

## 20. HARD requalification

A restored machine begins UNQUALIFIED. The qualification record carries `restoredFromBackup`
and is refused **even when it says HARD**, and the fingerprint covers every fact that changes
what containment means — including Windows interop, the thing somebody re-enables because
something was easier that way.

The walkthrough proves it end to end: *the project came back, the clearance did not.*

## 21. Disaster recovery

`RECOVERY_REQUIRED` outranks everything in the status precedence, and Serva will not retry an
operation whose final state it cannot establish. Restore refuses an unverified bundle rather
than restoring most of it — "most of a project" is not something anybody can act on, because
nobody would know which part was missing.

## 22. Update and versioning

Three version numbers, deliberately separate: `SERVA_VERSION` (1.0.0), `SCHEMA_VERSION` (the
Store), `BACKUP_FORMAT_VERSION` (the archive). Collapsing them means a cosmetic release
invalidates every backup, or a real format change slides through under a version that did not
move.

**Not built:** a packaged installer and an in-place upgrade path with rollback. Serva runs
from the repository. Listed as remaining.

## 23. RTL and LTR

One translation table, both languages, and a test asserting they define exactly the same keys —
a key present in one language only is the string that never gets translated.

RTL is **layout**, not a CSS property. Logical properties throughout, asserted by a test that
refuses physical directional margins. Technical content keeps its direction with
`unicode-bidi: isolate`, because a file path is not an Arabic sentence and does not become one
by appearing in an Arabic interface.

## 24. Accessibility

Focus visible, 32px minimum targets, sections labelled with `aria-labelledby`, the status a
live region, options as real buttons rather than clickable divs, `prefers-reduced-motion`
honoured. All asserted.

**No certification is claimed.** Automated checks find a minority of real accessibility
problems, and the acceptance matrix records that limitation against the row rather than
letting a clean sweep read as compliance.

## 25. Extension security

A webview is a browser, its messages are strings, and a project file can put HTML on a screen.

- Three message kinds, each schema-parsed; unknown fields refused rather than ignored.
- An `INVOKE` can only name an action that already exists.
- A smaller allow-list keeps destructive actions out of the page entirely — a page should
  never be the thing that chose a filesystem destination.
- Consequential actions need explicit confirmation; **destructive** ones additionally require a
  native modal a webview cannot fabricate.
- One escaping path, all five characters, under a CSP that denies everything and permits one
  nonce. An escaping mistake is a display bug rather than a compromise.
- `panel.js` contains no `innerHTML`, no `eval`, no `document.write` — asserted with comments
  stripped.

## 26. Offline test result

**50 files, 1146 tests, all passing.** `npm run verify` runs format, lint, typecheck (core and
extension), the suite, and both builds. Full output in `evidence/VERIFY.txt`.

## 27. Extension integration tests

**NOT PRESENT, and this is the largest gap in the package.**

The manifest, protocol, renderer, translations and accessibility markers are covered
deterministically — 26 tests. What is not executed is activation inside a running VS Code
window: `@vscode/test-electron` downloads and runs a VS Code build, and no such harness is
wired here. A defect existing only in the wiring — a handler registered twice, a panel
retaining a stale runtime — would not be caught.

The security review names this as the first thing an independent reviewer should attack.

## 28. Portability acceptance

`evidence/PORTABILITY_WALKTHROUGH.txt`, performed on this machine against a disposable
project, through the real CLI. Proves in order: the backup verifies; the inspection writes
nothing and states in advance what will not return; every non-excluded file comes back; no
machine-bound family is present in the restored canon; nothing in the bundle matches a
credential shape; and the restored project's doctor reports the machine still UNQUALIFIED.

Plus 44 deterministic portability tests against real disposable stores on the real filesystem.

## 29. Live Serva acceptance

**RESULT: BLOCKED**, externally. `evidence/LIVE_SERVA_ACCEPTANCE.txt`, transcript in
`evidence/LIVE_ENGINEERING_PHASE6.txt`.

Four of six live assertions passed: both boundaries qualified and proved distinct, the engine
found and version-identified in the guest, and nothing standing in for a Producer or a review.
The workspace then refused to open:

```
GUEST_ENGINE_AUTH   an authenticated Claude Code in the execution environment
SANDBOX_LAUNCHER    a working sandbox launcher (claude-sandbox-runtime)
```

All eleven adversarial cases `NOT_RUN` — deliberately, and **no Producer model call was
spent**. Serva does not dispatch a Producer into an unauthenticated engine to discover it is
unauthenticated.

**Not proved live:** a real HARD Producer writing code in WSL, a real independent Reviewer
over that change, an accepted disposable commit.

I did not install the prerequisites. Serva's own rule is that it installs none of these,
copies no credentials into the guest and never logs in on the owner's behalf; doing it myself
would break that rule and change this machine unasked. The evidence file records the two
commands that would complete it.

## 30. Live research result

**Not attempted in Phase 6.** Phase 5's deterministic research-trust suite is unchanged and
green, and §56 makes the live slice conditional on practicality. Spending model time on a
second live research slice while the engineering chain was blocked on prerequisites would have
proved nothing new about the trust controls, which are already proved branch by branch through
the real gateway.

## 31. Security review

`evidence/SECURITY_REVIEW.md`. **Independent reviewer: none recorded** — it is a self-review,
and §61 says such a thing may not certify itself.

`serva acceptance` enforces that rather than trusting a reader to notice, and **writing that
check broke it twice:**

1. `/independent reviewer:\s*\S/i` matched the asterisk in *"none recorded"*, so a document
   whose first line said it was a self-review certified itself.
2. The fix then failed because a literal **backspace character (0x08)** had replaced `\b` in
   the disclaimer regex during an edit, so the pattern could never match and the check silently
   passed again.

An invisible character disabling a security check is the exact failure that cannot be caught by
reading. I scanned the whole tree for control characters; the only other occurrences were an
intentional NUL in a Phase 3 test and two ANSI-strip regexes, now written with an explicit unicode escape so they
are visible.

The review maps the threat surface, the control for each threat and the test that holds it,
and states six things it cannot establish — starting with its own independence.

## 32. Acceptance matrix

`evidence/ACCEPTANCE_MATRIX.json` and `.md`, **generated** by `scripts/acceptance-matrix.mjs`.
33/33 rows covered. Every row names the file that proves it and the generator checks that the
file exists — it reported MISSING on first run, correctly, for owner documentation that did not
yet exist.

Verification type is carried per row, because a deterministic proof and a human walkthrough are
different kinds of confidence.

## 33. Standing Phase 5 limitations — disposition

| # | Limitation | Disposition |
|---|---|---|
| 1 | 8 of 19 gates undefined | **CLOSED_IN_PHASE_6** — 19/19, computed and tested |
| 2 | No cross-project learning store | **CLOSED_IN_PHASE_6** — local library, off by default, wall re-checked, three holes found and closed |
| 3 | Three unowned R4 artifact families (SF-12) | **ACCEPTED_BY_R4** — enumerated exceptions with stated reasons; a catalogue test holds the set |
| 4 | Competitive chain never completed live | **NON_BLOCKING_LIMITATION** — unchanged; the trust controls are proved deterministically and an unverified finding now discharges nothing |
| 5 | 180-second per-run budget | **NON_BLOCKING_LIMITATION** — inherited from Phase 3, unchanged, tight for some departments |
| 6 | Live routing and trust evidence absent | **NON_BLOCKING_LIMITATION** — proved branch by branch through the real gateway |
| 7 | Only ProductDecision and DesignDecision wired as ruling families | **ACCEPTED_BY_R4** — the two `32` declares; anything else is an owner decision, and that path is tested |
| 8 | Legacy SourceCapture without `requestRef` | **NON_BLOCKING_LIMITATION** — fail-closed by design: a capture with no request ref is never reused |

None was silently inherited.

## 34. Remaining Critical/High blockers

**Two, both blocking `READY FOR OWNER USE`:**

1. **Security acceptance is not independent.** A self-review cannot certify itself. Needs a
   reviewer who did not write this.
2. **Live acceptance is BLOCKED.** Two machine prerequisites are absent. Needs
   `npm install -g @anthropic-ai/sandbox-runtime` and a signed-in `claude` in the guest, then
   `npm run test:engineering-live`.

**Not blockers, and not built:**

3. Extension integration tests inside a running VS Code window (§52).
4. A guided machine bootstrap command (§23).
5. A packaged installer with an in-place upgrade and rollback path (§33).
6. The reconciliation UX as a panel workflow (§11) — the state and the choice exist; the
   workflow does not.

## 35. Final implementation commit

**`31d1f74`**. Evidence was captured after it, and the packaging commit above it adds only the
report, the evidence and the manifest — checkable with
`git diff --stat 31d1f74..HEAD -- src tests`.

## 36. Clean Git state

`git status --porcelain` → empty at packaging. Branch `phase-6-serva-code-1.0`, with `0a8c70a`
in ancestry.

## 37. Is Serva Code 1.0 ready for owner use?

**No, and Serva says so itself.**

```
SERVA CODE 1.0.0

Company Specification......... PASS
Core Engine................... PASS
AI Runtime.................... PASS
Engineering Factory........... PASS
Company Intelligence.......... PASS
Engineering HARD.............. PASS
VS Code Experience............ PASS
Portability................... PASS
Recovery...................... PASS
Lifecycle Coverage............ PASS
Gate Coverage................. PASS
Offline Verification.......... PASS
Acceptance Matrix............. PASS
Security Acceptance........... NOT_VERIFIED
Live Acceptance............... NOT_VERIFIED

NOT READY — 2 item(s) are not proven:
  - Security Acceptance (NOT_VERIFIED: a review exists and names no independent
    reviewer, so it is not an independent review)
  - Live Acceptance (NOT_VERIFIED: the live attempt recorded RESULT: BLOCKED)
```

Thirteen of fifteen lines are proven. The two that are not are not proven because of what did
not happen, not because of what failed: nobody independent has reviewed the security, and this
machine is missing two prerequisites the Producer boundary requires.

Both are external and both have exact next steps. Neither can be closed by writing a better
report, which is precisely why the status is computed rather than claimed — and why the most
tempting line in this product is the one it refuses to print.
