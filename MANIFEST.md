# SERVA CODE — PHASE 5 AUDIT — PACKAGE MANIFEST

Company intelligence and product authority, packaged for independent verification.

---

## Repository state

| | |
|---|---|
| Repository root | `D:/SEVACODE` |
| Branch | `phase-5-company-intelligence` |
| Phase 4 baseline | `f4866b2` (unchanged; no Phase 1–4 invariant was weakened) |
| Phase 5 HEAD | see `evidence/BASELINE_COMMIT.txt` |
| Working tree | clean at packaging time — see `evidence/GIT_STATE.txt` |

## What this package contains

| Path | What it is |
|---|---|
| `src/` | the implementation, including `src/intelligence/` (55 files) |
| `tests/` | 36 test files, 902 offline tests, plus three opt-in live suites |
| `docs/` | ADRs, prior phase reports, `SPEC_IMPLEMENTATION_FINDINGS.md` |
| `evidence/` | the outputs below, captured at packaging time |
| `scripts/` | the catalogue and contract generators |
| `PHASE_5_COMPANY_INTELLIGENCE_REPORT.md` | the 46-item Phase 5 report |
| config | `package.json`, `tsconfig*`, `vitest*`, `eslint`, `prettier` |

Generated runtime assets are included as source
(`src/catalogue/generated/catalogues.json`, `src/agents/generated/contracts.json`), so the
catalogue can be regenerated with `npm run generate` and diffed against them.

## Evidence

| File | What it shows |
|---|---|
| `evidence/GIT_STATE.txt` | branch, HEAD, working-tree status, recent log |
| `evidence/BASELINE_COMMIT.txt` | the exact commit this package was built from |
| `evidence/VERIFY.txt` | full `npm run verify` output — format, lint, typecheck, 902 tests, build |
| `evidence/OFFLINE_ACCEPTANCE.txt` | the five acceptance suites: E2E, scenarios B/C/D, security, authority, governance |
| `evidence/LIVE_INTELLIGENCE.txt` | the opt-in live run against a real model and the real network |
| `evidence/PHASE5_SURFACE.json` | catalogue counts, every wired department, every defined gate |

## What is NOT in this package

Deliberately excluded: `node_modules`, `.git`, `dist`, any `.serva` project store,
credentials, tokens, temporary AgentRun secrets, and the disposable projects the live
suites create and delete.

Every entry is named by extension under a named directory — nothing is included by walking
the filesystem — so a credential cannot arrive by accident.

## To verify independently

```
npm ci
npm run verify          # 902 tests, offline, free
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
