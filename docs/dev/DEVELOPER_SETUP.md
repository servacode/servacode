# Developer Setup

## Prerequisites

| Requirement | Version | Why |
|---|---|---|
| Node.js | ≥ 20.11 (developed on 24) | ADR-001; the VS Code extension host is a Node runtime |
| npm | ≥ 10 | Ships with Node |
| Git | any recent | Baseline and history |

No compiler toolchain is required: the project has **no native dependencies**, and exactly one runtime dependency (`zod`).

## Setup

```bash
npm install
npm run catalogues     # required once, and after any change to docs/serva-code/30
npm run verify
```

## Scripts

| Script | Does |
|---|---|
| `npm run catalogues` | Regenerate runtime catalogues from `docs/serva-code/30_CANONICAL_CATALOGUES.md` |
| `npm run typecheck` | `tsc --noEmit`, strict |
| `npm test` | Vitest, single run |
| `npm run test:watch` | Vitest, watch |
| `npm run lint` | ESLint 9 flat config |
| `npm run format` / `format:check` | Prettier |
| `npm run build` | Compile to `dist/` **and copy runtime assets** |
| `npm run verify` | format:check → lint → typecheck → test → build |

`npm run verify` is the gate to run before committing.

## Determinism in tests

The core takes an **injected clock and id source** so tests are reproducible without patching globals:

```ts
import { FixedClock } from '../src/core/clock.js';
import { SequentialIdSource } from '../src/core/ids.js';

const deps = { clock: new FixedClock(), ids: new SequentialIdSource(), actor: 'TEST' };
```

`FixedClock` advances by a fixed step per read and exposes `advance(ms)` for time-based expiry.
`SequentialIdSource` produces `SC-REQ-000001`, `SC-REQ-000002`, … with no randomness.

Use `tests/helpers.ts` (`freshStore`, `freshRuntime`, `ce`, `avr`, `criterion`) rather than hand-building fixtures.

## Test layout

| File | Categories |
|---|---|
| `gates.compose.test.ts` | A — every normative vector in `31` §4.2 |
| `gates.mapVerifier.test.ts` | B — `31` §4.4 vectors M1–M9 and rules MV-1…MV-8 |
| `gates.regression.test.ts` | C, D — MAJOR/INDETERMINATE regression; evidence semantics |
| `store.test.ts` | E, F, K — trace immutability, supersession, transactions, recovery |
| `agentRun.test.ts` | G — event sourcing, interruption, projection rebuild |
| `workflow.lifecycle.test.ts` | H, I — workflow state machine; gate→state mapping |
| `validity.isolation.test.ts` | J, L — derived validity; cross-project isolation |
| `app.catalogue.test.ts` | Catalogue loading, policy registry, runtime, doctor, CLI |

## Adding a canonical vocabulary value

Do **not** add a string literal to a module. Vocabularies live in `src/vocab/index.ts` and mirror `31` / `26`. Catalogue membership (departments, agents, stages, gates, workflows, policies) is **generated** from `docs/serva-code/30` — edit the specification and regenerate; never hand-edit `src/catalogue/generated/`.

## Changing the specification

The R4 documents are authoritative and are not edited to simplify implementation. If implementation exposes a genuine contradiction, record a `SPEC_IMPLEMENTATION_FINDING` in the phase report rather than implementing something that silently contradicts the specification (`29` CF-1).

## Editor

TypeScript strict mode is on, including `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. Optional properties are written with the conditional-spread idiom:

```ts
...(value === undefined ? {} : { key: value })
```

That is deliberate: it keeps `exactOptionalPropertyTypes` honest instead of widening every optional field to `| undefined`.
