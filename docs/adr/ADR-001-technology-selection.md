# ADR-001 — Serva Code Core Technology Selection

**Status:** ACCEPTED
**Date:** 2026-08-21
**Domain:** TECHNOLOGY
**Class:** STRUCTURAL (reversal cost: HIGH)
**Authority:** Software Architecture, with Data Architecture and Security Architecture input
**Drivers:** `27_SERVA_SELF_REQUIREMENTS.md` §3–§4, `21_LOCAL_RUNTIME_MODEL.md` §3–§5, `19`, `20`, `33`, `08`, `22`
**Research depth:** DEEP (`09` §7) — reversal cost HIGH, blast radius total

---

## 1. Context

Phase 2 implements the deterministic Serva Core. The stack must satisfy the constraint set in `27` §4. Two constraints dominate and are treated as disqualifiers:

- **C-2** — integrates with VS Code as the primary human surface (`20`).
- **C-3** — invokes a locally-authenticated AI engine (`19`).

Two storage constraints conflict and were flagged in `SC-OQ-006` as possibly unsatisfiable by one technology:

- **C-4** — append-only enforceable *at the storage layer* (`SC-POL-022`).
- **C-5** — store inspectable *without Serva Code running* (`ST-2`).

## 2. Evaluation criteria (declared before research, per `09` §7.1)

| # | Criterion | Weight |
|---|---|---|
| K1 | Satisfies C-2 (VS Code) without a second runtime | HARD |
| K2 | Satisfies C-3 (AI engine integration) natively | HARD |
| K3 | Deterministic core expressible without engine dependency | HARD |
| K4 | Local-first, no server, no daemon | HARD |
| K5 | Windows-native developer experience | HARD |
| K6 | Static typing / schema validation strength | HIGH |
| K7 | Test tooling maturity | HIGH |
| K8 | Distribution and packaging simplicity | HIGH |
| K9 | Zero native/compiled dependencies (Windows build friction) | HIGH |
| K10 | Maintainable by a single developer (`SC-POL-017`) | HIGH |
| K11 | Long-running workflow support | MEDIUM |
| K12 | Ecosystem longevity | MEDIUM |

## 3. Candidates

### 3.1 Language / runtime

| Candidate | K1 | K2 | K5 | K8 | Verdict |
|---|---|---|---|---|---|
| **TypeScript / Node.js** | **Native** — the VS Code extension host *is* a Node.js runtime, and extensions are written in JS/TS `[S1]`. Core is importable directly by the future extension: no IPC, no second runtime for the owner to install | **Native** — Agent SDK ships for TypeScript `[S2]` | Excellent | `npm`, no compilation | **SELECTED** |
| Python | Requires an IPC bridge or subprocess protocol to reach the extension host — a second runtime the owner must install and Serva must supervise | Native — Agent SDK ships for Python `[S2]` | Good, but packaging on Windows is the weakest of the candidates | REJECTED | |
| Rust | Would need a Node shim for K1 and a subprocess bridge for K2 (SDK is TS/Python only `[S2]`) | Indirect | Excellent single binary | Rejected on K1+K2+K10 | REJECTED |
| Go | Same K1/K2 shape as Rust | Indirect | Excellent single binary | Rejected on K1+K2 | REJECTED |
| C# / .NET | Strong on Windows, but the extension host is still Node — a bridge is unavoidable | Indirect | Good | Rejected on K1+K2 | REJECTED |

**Decisive reasoning.** K1 and K2 are both HARD. Exactly one candidate satisfies both without a bridge. Choosing anything else means the owner installs and Serva supervises a second runtime for the lifetime of the product — recurring complexity that `SC-POL-017` requires us to reject when a simpler option meets the requirements.

Python's Agent SDK support is equal to TypeScript's, so K2 alone does not decide; **K1 does.**

### 3.2 Storage

| Candidate | C-4 append-only at storage layer | C-5 inspectable without Serva | TX-1 atomic | K9 no native deps | Verdict |
|---|---|---|---|---|---|
| SQLite (`node:sqlite` or `better-sqlite3`) | Only by trigger convention — the file format itself permits update and delete | Requires a SQLite client; not readable with ordinary text tooling | Yes, strong | `node:sqlite` yes; `better-sqlite3` no | REJECTED on C-5 |
| Single JSON document | No | Yes | Rewrite-whole-file only; poor | Yes | REJECTED on C-4, TX-1 |
| Embedded document DB (LevelDB/LMDB class) | No | No | Yes | Native | REJECTED on C-5, K9 |
| **Hybrid: append-only JSONL trace + versioned JSON documents + WAL** | **Yes** — trace segments are opened append-only and hash-chained; rewriting is detectable, not merely forbidden | **Yes** — every byte is UTF-8 JSON readable in any editor | **Yes** — write-ahead journal with an atomic-rename commit point | **Yes** — Node built-ins only | **SELECTED** |

**On `SC-OQ-006`.** The specification anticipated that C-4 and C-5 might not be satisfiable by a single technology and predicted a hybrid. That prediction holds: no off-the-shelf engine satisfies both. The hybrid resolves it by splitting the store along the durability tiers `08` §2 already defines —

| Tier | Representation | Why |
|---|---|---|
| `T-TRACE` | Append-only, hash-chained JSONL segments | Append-only is the file's natural mode; the chain makes retroactive edits detectable (`KI-1`) |
| `T-CANON` | Immutable versioned JSON documents, `v1.json`, `v2.json`, … | Versioning without mutation (`08` §6.1) |
| `T-WORKING` | Mutable JSON documents | Live projections; never authoritative (`RI-8`) |
| `T-DERIVED` | Rebuildable indexes | Regenerated; never a second source of truth (`SC-POL-004`) |

This is not a compromise — the storage layout *is* the durability model the specification already required.

### 3.3 Supporting choices

| Concern | Selected | Rejected | Reason |
|---|---|---|---|
| Schema validation | **Zod** | io-ts, ajv, hand-written guards | Types derive from schemas (one source), good errors, no codegen step |
| Test runner | **Vitest** | Jest, node:test | Native ESM + TS, fast, mature assertions; `node:test` lacks the matcher ergonomics for the vector tables |
| Lint | **ESLint 9 flat config** | Biome | Mature TS rules; Biome's TS type-aware coverage is still narrower |
| Format | **Prettier** | — | Automated per `CS-1` |
| CLI parsing | **Hand-rolled (~120 lines)** | commander, yargs, oclif | `SC-POL-017` and `DEP-3`: the surface is small and stable; a dependency for arg splitting is not justified |
| Module system | **ESM, `NodeNext`** | CJS | Node 24 default; VS Code supports ESM extensions |
| Runtime deps | **`zod` only** | — | `DEP-1`: transitive surface counts |

## 4. Decision

**TypeScript on Node.js (≥ 20 LTS; developed on 24), ESM, strict mode, Zod schemas, Vitest, ESLint + Prettier, and a hybrid file store (append-only hash-chained JSONL for `T-TRACE`, versioned JSON documents for `T-CANON`, mutable JSON for `T-WORKING`, rebuildable indexes for `T-DERIVED`), with a write-ahead journal providing atomic multi-record commits. One runtime dependency: `zod`.**

## 5. Consequences

**Forces**
- The future VS Code extension imports the core as a library; no protocol to design or version.
- The store is a directory of readable text. Backup is a directory copy (`BK-1`); inspection needs no tooling (`ST-2`); portability is a copy plus a manifest check (`NFR-6`).
- No compile step for native modules; `npm install` works on Windows without a toolchain (K9).
- Determinism is achievable because the core takes an injected clock and ID source; gate composition is a pure function.

**Forbids**
- No ORM, no query language, no daemon, no server, no container.
- No AI-provider dependency anywhere in the deterministic core (`27` NFR-17). The core does not import the Agent SDK; the engine adapter arrives in a later phase behind an interface.

**Accepts**
- File-based storage will not match SQLite's query performance at very large record counts. `NFR-9` requires this to be **measured, not assumed**; the derived-index layer exists to absorb it, and the re-evaluation trigger below fires if it does not.
- JSONL scanning is O(n) per stream. Mitigated by per-stream segmentation and derived indexes.

## 6. Risks

| Risk | Mitigation |
|---|---|
| File store underperforms at scale (`NFR-9`) | Derived indexes; measurement gate before Phase 3; re-evaluation trigger R-1 |
| Filesystem lies about `fsync` (Windows, virtualized volumes) | Explicitly outside the `NFR-4` guarantee; backups are the mitigation (`21` §7) |
| Node major-version churn | Depend on stable built-ins only; engines field pinned to a range |
| Single runtime dependency becomes unmaintained | Zod is behind a thin internal `schema` module so replacement is contained |

## 7. Re-evaluation triggers (`SC-POL-015`)

- **R-1** Measured query latency exceeds the `NFR-7` target once set, at the `NFR-9` record volume.
- **R-2** VS Code changes the extension host runtime such that a Node library is no longer directly importable.
- **R-3** The Agent SDK drops TypeScript support, or a required capability becomes Python-only (`SC-POL-035`).
- **R-4** `QR-09` fails in a way that requires the store to move under an OS-level isolation boundary the file layout cannot provide (`33` QG-3).
- **R-5** A second concurrent writer becomes a requirement (`SC-OQ-002` resolves to multi-user).

## 8. Sources

| ID | Claim | Marking |
|---|---|---|
| `[S1]` | VS Code extensions run in a Node.js extension host and are written in JavaScript/TypeScript | `SOURCED` — [Extension Host](https://code.visualstudio.com/api/advanced-topics/extension-host), [Your First Extension](https://code.visualstudio.com/api/get-started/your-first-extension), retrieved 2026-08-21 |
| `[S2]` | The Claude Agent SDK is available for Python and TypeScript only; other languages use the CLI as a subprocess | `SOURCED` — [Agent SDK overview](https://docs.claude.com/en/api/agent-sdk/overview), [Agent SDK TypeScript reference](https://docs.anthropic.com/en/docs/agent-sdk/typescript), retrieved 2026-08-21 |

Both carry `valid_until` = next Phase boundary, per `PC-1`: provider and platform capability statements are time-sensitive external assumptions, not architectural truths.
