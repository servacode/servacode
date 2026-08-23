# SERVA CODE 1.0 — PHASE 6 AUDIT — PACKAGE MANIFEST

The final implementation phase: the product experience, portability, and the acceptance that
refuses to certify itself. Packaged for independent verification.

---

## Repository state

| | |
|---|---|
| Repository root | `D:/SEVACODE` |
| Branch | `phase-6-serva-code-1.0` |
| Phase 4 baseline | `f4866b2` (unchanged) |
| Phase 5 baseline | `0a8c70a` (accepted; confirmed in ancestry) |
| **Implementation baseline** | **`31d1f74`** — the last commit touching `src/` or `tests/` |
| Packaging commit | directly above it: this manifest, `SERVA_CODE_1_0_PHASE_6_FINAL_REPORT.md` and `evidence/`, and nothing else |
| Working tree | clean — `git status --porcelain` returns nothing |

**One baseline, and every artifact says the same thing about it.**
`evidence/BASELINE_COMMIT.txt`, `evidence/GIT_STATE.txt`, the final report and this manifest
all name `31d1f74`. Reproduce the implementation by checking out `31d1f74` and running
`npm run verify`.

A file cannot record its own hash, which is why the packaging commit is separate. What it
contains is checkable rather than asserted:

```
git diff --stat 31d1f74..HEAD -- src tests    # empty
```

Evidence was captured after `31d1f74`, from that exact tree.

## Serva's own verdict on itself

```
serva acceptance
→ NOT READY — 2 item(s) are not proven
```

Thirteen of fifteen acceptance lines PASS. Security Acceptance is `NOT_VERIFIED` because the
security review names no independent reviewer, and Live Acceptance is `NOT_VERIFIED` because
the live run recorded `RESULT: BLOCKED`. Both are external, both have exact next steps, and
neither can be closed by writing a better report — which is why the status is computed.

## What this package contains

| Path | What it is |
|---|---|
| `src/` | the implementation — core, runtime, engineering, intelligence, coverage, portability, learning, extension logic, acceptance |
| `extension/` | the VS Code extension: manifest, adapter source, stylesheet, panel script |
| `tests/` | 51 test files, 1146 offline tests, plus four opt-in live suites |
| `docs/serva-code/` | the 34 R4 specification documents, unmodified |
| `docs/owner/` | eleven owner-facing documents, from getting started to recovery |
| `scripts/` | catalogue and contract generators, the acceptance-matrix generator, the portability walkthrough |
| `evidence/` | the outputs below, captured at packaging time |
| `SERVA_CODE_1_0_PHASE_6_FINAL_REPORT.md` | the 37-item Phase 6 report |
| prior reports | Phase 4 baseline and the five Phase 5 reports, unchanged |
| config | `package.json`, `tsconfig*`, `vitest*`, `eslint`, `prettier` |

Generated runtime assets are included as source
(`src/catalogue/generated/catalogues.json`, `src/agents/generated/contracts.json`), so the
catalogue can be regenerated with `npm run generate` and diffed against them.

## Evidence

| File | What it shows |
|---|---|
| `evidence/VERIFY.txt` | full `npm run verify` — format, lint, typecheck (core and extension), 1146 tests, both builds |
| `evidence/ACCEPTANCE_MATRIX.md` / `.json` | 33 requirements, each naming the file that proves it; generated, not written |
| `evidence/SECURITY_REVIEW.md` | the threat surface, the control for each threat, the test that holds it — and no independent reviewer |
| `evidence/PORTABILITY_WALKTHROUGH.txt` | a real backup and restore on this machine, through the CLI |
| `evidence/LIVE_SERVA_ACCEPTANCE.txt` | the live attempt: `RESULT: BLOCKED`, with the two prerequisites named |
| `evidence/LIVE_ENGINEERING_PHASE6.txt` | the full live transcript it rests on |
| `evidence/BASELINE_COMMIT.txt` | the implementation baseline, and how to check the commit above it |
| `evidence/GIT_STATE.txt` | branch, HEAD, working-tree status, recent log |
| `evidence/PHASE5_SURFACE.json` | every department with its declared outputs and its contract's permitted outputs |
| `evidence/OFFLINE_ACCEPTANCE.txt` | the focused Phase 5 acceptance run, unchanged |

## Reproducing it

```
npm ci
npm run verify          # 1146 tests, offline, free
node dist/cli/main.js acceptance      # Serva's verdict on itself
node dist/cli/main.js machine doctor  # this computer, measured
node scripts/acceptance-matrix.mjs    # regenerate the matrix
node scripts/portability-walkthrough.mjs   # a real backup and restore, disposable
```

The live suites are separate commands and are not part of `verify`:

```
npm run test:claude               # Phase 3
npm run test:engineering-live     # Phase 4 — needs a qualified machine
npm run test:intelligence-live    # Phase 5
```

## What is NOT in this package

Deliberately excluded: `node_modules`, `.git`, `dist`, any `.serva` project store,
credentials, tokens, Claude authentication material, temporary run secrets, temporary
worktrees, and the disposable projects the live suites and the walkthrough create and delete.

The packager names every tree and every loose file explicitly and scans each one for
credential shapes on the way in, so nothing arrives by accident. The only matches it permits
are the named fixtures that exist to prove redaction works.
