# Serva Code

**Local AI Software Company Operating System.**

The client defines the problem and business goals. Serva Code determines how the product should be engineered.

- **Specification:** [`docs/serva-code/`](docs/serva-code/) — 34 documents, status **BASELINE R4**. Authoritative.
- **Implementation:** Phase 2 Core Engine. This repository.
- **Technology decision:** [`docs/adr/ADR-001-technology-selection.md`](docs/adr/ADR-001-technology-selection.md)

## What Phase 2 is

The deterministic core: storage, events, gates, validity, workflow, lifecycle, policy foundation, and a CLI control surface.

**Phase 2 deliberately does not implement** AI orchestration, agent execution, Claude session management, the VS Code extension UI, or the conversational interface. The core is built so those attach without replacing it — and the core carries **no AI-provider dependency at all** (`27` NFR-17).

## Quick start

```bash
npm install
npm run catalogues     # generate runtime catalogues from the R4 specification
npm run verify         # format + lint + typecheck + test + build
npm run build

node dist/cli/main.js init "My Project" --idea "The raw idea, verbatim."
node dist/cli/main.js status
node dist/cli/main.js doctor
```

## Commands

| Command | Purpose |
|---|---|
| `serva init <name> --idea "<text>"` | Create a project; the Idea is recorded verbatim and immutably (`03` §2) |
| `serva status` | Project state, governance state, what needs attention |
| `serva project` | Identity, metadata, canon versions, the Idea |
| `serva doctor` | Prerequisites, store health, trace integrity, enforcement substrate |
| `serva gates` | Gate catalogue, the severity disposition table, recorded results |
| `serva workflows` | Workflow catalogue, run states, gate→state mapping |

All support `--root <path>`; most support `--json`.

## Architecture at a glance

```
src/
  vocab/       Canonical outcome vocabularies (31). No magic strings anywhere else.
  core/        Errors, injectable clock, ids, canonical hashing
  catalogue/   Runtime catalogues, GENERATED from docs/serva-code/30 — never hand-written
  domain/      Zod schemas for persisted models (08 §3)
  store/       Hybrid file store: append-only hash-chained JSONL + versioned JSON + WAL
  events/      Audit trail (runtime-only writer) and event-sourced AgentRun
  gates/       composeGateVerdict (31 §4.1), V3b→V1 mapping (31 §4.4), criterion evaluation
  validity/    Derived ValidityState (31 §3.2). Never stored, never mutated.
  workflow/    Deterministic workflow state machine
  lifecycle/   Stage execution state, immutable stage ledger, gate→state mapping (31 §6.2)
  policy/      Policy registry and violation recording
  app/         Runtime, project discovery, startup validation, doctor
  cli/         Engineering control surface
```

### Three properties worth knowing

**Nothing is ever marked stale.** `ValidityState` is *derived* from artifact versions, time, revocation records and the dependency graph (`31` §3.2). Immutable records are never mutated to `STALE`.

**A `MAJOR` criterion that could not be verified never yields a clean `PASS`.** It yields `PASS_WITH_QUALIFICATION` carrying an `UNVERIFIED_ASPECT` that travels to release. Absence of evidence is not proof of failure — except for a criterion that explicitly tests for existence (`18` §2.1).

**The trace log offers only `append`.** There is no update and no delete, and the hash chain makes an out-of-band edit detectable rather than merely forbidden.

## Store layout

Every byte is UTF-8 JSON or JSONL, readable in any editor with nothing running (`ST-2`). Backup is a directory copy.

```
.serva/
  SCHEMA_VERSION
  project.json
  canon/<type>/<id>/v1.json, v2.json …   T-CANON    immutable versions
  working/<type>/<id>.json               T-WORKING  mutable projections
  trace/<stream>.jsonl                   T-TRACE    append-only, hash-chained
  derived/*.json                         T-DERIVED  rebuildable, never authoritative
  journal/                               write-ahead log; commit point is an atomic rename
  quarantine/  backups/
```

## Development

See [`docs/dev/DEVELOPER_SETUP.md`](docs/dev/DEVELOPER_SETUP.md) and [`docs/dev/STORAGE_NOTES.md`](docs/dev/STORAGE_NOTES.md).

## Specification conformance

The R4 documents are the product specification and are not modified to make implementation easier. Where implementation and specification diverge, `29` CF-1 applies: it is either a specification defect (amend the spec) or an implementation defect (fix the code), never an undocumented difference.
