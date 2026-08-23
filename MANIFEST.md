# SERVA CODE — PHASE 5 BASELINE FINAL — PACKAGE MANIFEST

Company intelligence and product authority, after the final closure. Packaged for
independent verification.

---

## Repository state

| | |
|---|---|
| Repository root | `D:/SEVACODE` |
| Branch | `phase-5-company-intelligence` |
| Phase 4 baseline | `f4866b2` (unchanged; no Phase 1–4 invariant was weakened) |
| Packaged tree | `b2396d9` — named in `evidence/BASELINE_COMMIT.txt` |
| Packaging commit | one above it, adding only the evidence that describes it |
| Working tree | clean — `git status --porcelain` returns nothing |

A file cannot record its own hash, which is why there are two commits rather than one.
Reproduce the implementation from `3455cd5`, the last commit that touches `src/` or
`tests/`. `b2396d9` adds the closure report; the commit above that adds only the evidence
describing it.

## What this package contains

| Path | What it is |
|---|---|
| `src/` | the implementation, including `src/intelligence/` (55 files) |
| `tests/` | 40 test files, 973 offline tests, plus three opt-in live suites |
| `docs/` | ADRs, prior phase reports, `SPEC_IMPLEMENTATION_FINDINGS.md` |
| `evidence/` | the outputs below, captured at packaging time |
| `scripts/` | the catalogue and contract generators |
| `PHASE_5_AUTHORITY_LOCK_REPORT.md` | the authority lock: five defects plus the field-choice invariant |
| `PHASE_5_FINAL_CLOSURE_REPORT.md` | the previous closure: nine defects, plus four found while closing them |
| `PHASE_5_COMPANY_INTELLIGENCE_REPORT.md` | the original 46-item Phase 5 report |
| config | `package.json`, `tsconfig*`, `vitest*`, `eslint`, `prettier` |

Generated runtime assets are included as source
(`src/catalogue/generated/catalogues.json`, `src/agents/generated/contracts.json`), so the
catalogue can be regenerated with `npm run generate` and diffed against them.

## Evidence

| File | What it shows |
|---|---|
| `evidence/GIT_STATE.txt` | branch, HEAD, working-tree status, recent log |
| `evidence/BASELINE_COMMIT.txt` | the exact commit this package was built from |
| `evidence/VERIFY.txt` | full `npm run verify` output — format, lint, typecheck, 973 tests, build |
| `evidence/OFFLINE_ACCEPTANCE.txt` | the five acceptance suites: E2E, scenarios B/C/D, security, authority, governance |
| `evidence/LIVE_INTELLIGENCE.txt` | an earlier live run, which proved the VALUE mechanism end to end |
| `evidence/LIVE_NORMALIZER_SLICE.txt` | the clean live slice at the final baseline — 10 tests passing |
| `evidence/PHASE5_SURFACE.json` | every department with its declared outputs, its contract's permitted outputs, and its declared independence |

## What is NOT in this package

Deliberately excluded: `node_modules`, `.git`, `dist`, any `.serva` project store,
credentials, tokens, temporary AgentRun secrets, and the disposable projects the live
suites create and delete.

Every entry is named by extension under a named directory — nothing is included by walking
the filesystem — so a credential cannot arrive by accident.

## To verify independently

```
npm ci
npm run verify          # 973 tests, offline, free
npm run generate        # regenerate catalogues; diff against the committed ones
```

The two opt-in suites cost money and reach outside the machine, so they are separate
commands and are excluded from `verify`:

```
npm run test:claude                # live model calls
npm run test:intelligence-live     # live model calls AND the public network
```

Both skip with a stated reason when the engine is unavailable. A machine without an engine
is a fact about the machine, not a test failure.
