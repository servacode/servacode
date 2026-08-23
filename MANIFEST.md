# SERVA CODE — PHASE 5 FINAL ACCEPTANCE — PACKAGE MANIFEST

Company intelligence and product authority, after the true final closure. Packaged for
independent verification.

---

## Repository state

| | |
|---|---|
| Repository root | `D:/SEVACODE` |
| Branch | `phase-5-company-intelligence` |
| Phase 4 baseline | `f4866b2` (unchanged; no Phase 1–4 invariant was weakened) |
| **Implementation baseline** | **`5d26bbc`** — the last commit touching `src/` or `tests/` |
| Packaging commit | directly above it: this manifest, `PHASE_5_FINAL_ACCEPTANCE_REPORT.md` and `evidence/`, and nothing else |
| Working tree | clean — `git status --porcelain` returns nothing |

**One baseline, and every artifact says the same thing about it.**
`evidence/BASELINE_COMMIT.txt`, `evidence/GIT_STATE.txt`, the acceptance report and this
manifest all name `5d26bbc` as the implementation baseline, and all describe the commit
above it the same way. Reproduce the implementation by checking out `5d26bbc` and running
`npm run verify`.

A file cannot record its own hash, which is why the packaging commit is separate. What it
contains is checkable rather than asserted:

```
git diff --stat 5d26bbc..HEAD -- src tests    # empty
```

Evidence was captured after `5d26bbc`, from that exact tree.

## What this package contains

| Path | What it is |
|---|---|
| `src/` | the implementation, including `src/intelligence/` (61 files) |
| `tests/` | 43 test files, 1004 offline tests, plus three opt-in live suites |
| `docs/` | ADRs, prior phase reports, `SPEC_IMPLEMENTATION_FINDINGS.md` |
| `evidence/` | the outputs below, captured at packaging time |
| `scripts/` | the catalogue and contract generators |
| `PHASE_5_FINAL_ACCEPTANCE_REPORT.md` | the true final closure: a ruling that can be made, and an obligation that gets discharged |
| `PHASE_5_LAST_CLOSURE_REPORT.md` | the previous closure: typed proposal rulings, and routing that acts |
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
| `evidence/GIT_STATE.txt` | branch, HEAD, working-tree status (source separately from the evidence being written), recent log |
| `evidence/BASELINE_COMMIT.txt` | the implementation baseline, and how to check what the commit above it contains |
| `evidence/VERIFY.txt` | full `npm run verify` output — format, lint, typecheck, 1004 tests, build |
| `evidence/OFFLINE_ACCEPTANCE.txt` | twelve intelligence suites, 159 tests: obligations, proposal rulings, routing, questions, governance, owner values, authority, restart, write authority, E2E, scenarios, security |
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
npm run verify          # 1004 tests, offline, free
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
