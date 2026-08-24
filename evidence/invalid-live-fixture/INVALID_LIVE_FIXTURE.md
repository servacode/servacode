# INVALID_LIVE_FIXTURE

This live chain is preserved as evidence and **contributes zero positive LIVE-SERVA authority**.

## Why it is invalid

The deterministic baseline omitted the project's CommonJS module declaration. The fixture's
worktrees are created under `D:\SEVACODE\out\.serva-workspaces\…`, inside the Serva repository,
so Node resolved Serva's own `package.json` (`"type": "module"`) and refused to load the
fixture's CommonJS `test.js`.

The declared acceptance oracle therefore **never executed**. All four recipe executions failed
with `ReferenceError: require is not defined`; not one reached `total()` and not one produced an
assertion failure.

## What it DOES prove

Serva behaved correctly and fail-closed throughout:

- the Producer's change was correct (`for (let i = 0; i < xs.length; i++)`)
- scope conformance and credential scanning passed
- the declared oracle failed, so `SC-RTC-012` recorded FAIL
- the Engineering Gate refused the change
- one bounded retry, then BLOCKED — no acceptance of unverified work

A gate that had passed here would have been the defect.

## Chain identity

| Record | Id |
|---|---|
| Turn | `SC-TURN-01M0TBYDQF0004FVEYV83` |
| Request | `SC-REQST-01M0TBYDQF002HZQZPF25` |
| Work item | `SC-WI-01M0TBYDQF001CMHN8JR2` |
| Producer run (attempt 1) | `SC-RUN-01M0TC4Y4K0017Q6ZZE7N` — PARTIAL |
| ChangeSet (attempt 1) | `SC-CS-01M0TC6XPW000ST1WY3P2` |
| Blocking check | `SC-EEV-01M0TC6YMS000QM1GHA7C` — `SC-RTC-012` FAIL |
| Blocking execution | `SC-EXEC-01M0TC6YM8000D5CJY389` — exit 1, module error |

No `OwnerDecisionRequest` was raised anywhere in this chain.

This Store must never mint LIVE-SERVA. Full analysis: `LIVE_SERVA_BLOCK_DIAGNOSIS.md`.
