# Storage Notes

Implementation notes for `src/store/`. The normative model is `08` §2 (durability tiers) and `21` §3–§4. ADR-001 §3.2 records why this shape was chosen.

## Why a hybrid store

Two specification constraints conflict, and `SC-OQ-006` predicted no single engine would satisfy both:

- **C-4** append-only enforceable *at the storage layer* (`SC-POL-022`)
- **C-5** store inspectable *without Serva Code running* (`ST-2`)

SQLite satisfies C-4 only by trigger convention and fails C-5. Plain JSON satisfies C-5 and fails C-4 and atomicity. The resolution splits the store along the tiers `08` §2 already defines:

| Tier | On disk | Mutability |
|---|---|---|
| `T-CANON` | `canon/<type>/<id>/v<N>.json` | New versions only; prior versions retained byte-for-byte |
| `T-WORKING` | `working/<type>/<id>.json` | Mutable projection; never authoritative |
| `T-TRACE` | `trace/<stream>.jsonl` | **Append-only, hash-chained** |
| `T-DERIVED` | `derived/*.json` | Rebuildable; never a second source of truth |

## Transactions

`Store.commitTransaction` is a two-phase commit through a write-ahead journal:

```
1. write journal/<txId>.json         (fsync)
2. write journal/<txId>.commit       <-- COMMIT POINT
3. apply every write atomically      (temp file + fsync + rename)
4. remove the journal
```

Recovery on open (`22` §4.2):

- a `*.commit` journal is **re-applied** — idempotent, because it carries absolute file contents
- a `*.json` journal never reached the commit point and is **discarded**

Both paths are covered by tests in `store.test.ts`.

### Read-your-writes

A transaction maintains an overlay of its own staged canon and working writes, so reads inside a transaction see them. Without it, every multi-step operation (start a workflow then advance it; start a stage then apply a gate outcome) would need an artificial mid-operation commit — which would break atomicity to work around an API limitation.

## Durability boundary

`writeFileAtomic` writes to a temp file, `fsync`s it, renames, then attempts to `fsync` the directory. Directory fsync is unsupported on some platforms (notably Windows); that failure is caught and ignored deliberately — the rename is atomic regardless, and only the metadata flush *timing* is affected.

This is exactly the boundary `27` NFR-4 draws: durability is guaranteed *under stated assumptions* — a filesystem that honours flush, and hardware that does not acknowledge writes it has not persisted. Media failure and lying filesystems are outside the guarantee and are addressed by backups, not by this layer.

## Hash chaining

Each trace record stores `prevDigest` and `digest = sha256(prevDigest + canonicalJson(body))`. Canonical JSON sorts keys recursively and drops `undefined`, so digests are reproducible across processes and platforms.

`TraceLog.verify()` walks a stream and reports the first broken link. It detects: a modified payload, a deleted record, a sequence gap, and an appended forgery that does not continue the chain. All four are tested.

The `TraceLog` class exposes `append`, `readAll`, `head` and `verify` — and nothing else. **There is no update and no delete.** The hash chain exists because forbidding an edit is not the same as detecting one.

## Supersession

Forward-only (`08` §6.2). A new record declares `supersedes: <oldId>` at creation; the superseded record is **never touched**. `superseded_by` is not a stored field — `Store.supersededBy()` derives the reverse index from forward links.

`store.test.ts` asserts the superseded file is byte-identical before and after.

## Stream names may nest

Stream names can contain `/` — `agentrun/SC-RUN-…` gives each run its own log so replay is cheap. `listTraceStreams()` therefore walks the trace tree recursively. A non-recursive listing silently hides whole classes of stream, which is how an interrupted run could go unnoticed; that was a real defect caught by the `findIncompleteRuns` test.

## What is not implemented in Phase 2

Recorded honestly per `29` CF-2 — these are specified but not yet built, and must not be mistaken for working:

- **Concurrency control** (`21` §5): write-set locking and lease expiry. Phase 2 is single-process; the transaction boundary exists but there is no lock manager.
- **Backup/restore mechanics** (`21` §7): the `backups/` directory exists; snapshot, verify and restore are not implemented.
- **Store migrations** (`ST-6`): `SCHEMA_VERSION` is written and validated, and a mismatch refuses to open with an actionable error. The migration runner itself is not implemented.
- **Workspace reconciliation** (`21` §10, `SC-POL-032`): not implemented; there is no artifact-digest scan yet.
- **Retention and pruning** (`21` §9).
