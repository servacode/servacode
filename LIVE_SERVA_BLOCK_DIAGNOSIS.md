# SERVA CODE — LIVE-SERVA BLOCK DIAGNOSIS

## 0. Correction: the work item id I reported earlier was stale

An earlier report named the resumed work item `SC-WI-01M0T55BYW001B72PM0F6`. **That id does not
exist**, in this Store or anywhere on disk:

```
grep -rl "01M0T55BYW" out/ evidence/     → no matches
```

The authoritative Store holds exactly one owner request and one work item for this fixture:

| Record | Id |
|---|---|
| Conversation turn | `SC-TURN-01M0TBYDQF0004FVEYV83` |
| Request record | `SC-REQST-01M0TBYDQF002HZQZPF25` (source `OWNER_CLI`, 17:09:01.808Z) |
| Work item | `SC-WI-01M0TBYDQF001CMHN8JR2` |
| Sandbox probe item | `SC-WI-01M0TBYDQF001CMHN8JR2-sandbox-probe` |

Both work items exist; the second is the OS sandbox qualification probe the factory creates for
itself, derived from the first by name. There is no second *owner* chain.

**What happened.** The `SC-WI-01M0T55BYW…` ids came from an earlier run against a fixture that
the non-resume path deletes and recreates (`rmSync(root, {recursive: true})` before `preseed`).
When that run was later re-executed without `SERVA_RESUME=1`, the old Store was destroyed and a
fresh chain created. I read the old ids out of console scrollback and reported them as current.

That is the precise error this instruction exists to prevent — inferring from console prose when
canonical Store evidence exists. The causal chain in §1 below is correct and was always derived
from the Store; only the earlier summary was wrong.

Reconstructed entirely from the preserved fixture at `out/live-join-fixture`. Nothing in this
document is taken from console output where a canonical record exists.

## 1. The exact blocking event

The declared unit-test recipe failed on every attempt, for a reason that has nothing to do with
the code the Producer wrote:

```
ReferenceError: require is not defined in ES module scope, you can use import instead
This file is being treated as an ES module because it has a '.js' file extension
and '/mnt/d/SEVACODE/package.json' contains "type": "module".
```

`SC-EXEC-01M0TC6YM8000D5CJY389.stderrExcerpt`

The fixture's `test.js` is CommonJS (`require('./src/total.js')`). Its worktree is created at

```
D:\SEVACODE\out\.serva-workspaces\live-join-fixture-1bf62e0d\SC-WI-…-a01
```

because `workspacesRootFor` (`src/engineering/workspace.ts:39-42`) places worktrees at
`<projectRoot>/../.serva-workspaces/<name>`. The live fixture's project root is
`D:\SEVACODE\out\live-join-fixture`, so its worktrees land inside the Serva repository itself.
Node then walks up from the test file, finds **Serva's own** `package.json` with
`"type": "module"`, and refuses to run a CommonJS file. The fixture declares no `package.json`
of its own, so it has no way to override that.

## The causal chain

```
REQUEST      SC-TURN-01M0T55BYW000EKQ82EPC  (owner: fix total(), QUEUED)
→ WORK ITEM  SC-WI-01M0TBYDQF001CMHN8JR2
→ ENGINEERING  substrateClass HARD, qualification digest 5899e926…
               worktree created under D:\SEVACODE\out\.serva-workspaces\…
→ PRODUCER   SC-RUN-01M0TC4Y4K0017Q6ZZE7N (SC-AGENT-150) PARTIAL
             ChangeSet SC-CS-01M0TC6XPW000ST1WY3P2, 1 entry: M src/total.js
→ CHECKS     SC-RTC-005 PASS (1 changed path, in scope)
             SC-RTC-015 PASS (no credential-shaped content)
             SC-RTC-012 FAIL — exit 1, ReferenceError: require is not defined
→ REVIEW     SC-RUN-01M0TC6YQZ001NSYT2APZ (SC-AGENT-180) BLOCKED
→ ATTEMPT 2  SC-RUN-01M0TC7XR3001F1ZR60XV BLOCKED, ChangeSet …7XZE with 0 entries
→ BLOCKED
```

## 2. Evidence refs

| Fact | Reference |
|---|---|
| Work item | `SC-WI-01M0TBYDQF001CMHN8JR2` |
| Producer run, attempt 1 | `SC-RUN-01M0TC4Y4K0017Q6ZZE7N` — PARTIAL |
| ChangeSet, attempt 1 | `SC-CS-01M0TC6XPW000ST1WY3P2` — 1 entry, `M src/total.js` |
| Scope check | `SC-EEV-01M0TC6XQF0006M3XF98H` — PASS |
| Credential scan | `SC-EEV-01M0TC6XQZ0003MZV1CC5` — PASS |
| **Blocking check** | `SC-EEV-01M0TC6YMS000QM1GHA7C` — **FAIL**, `SC-RTC-012` |
| **Blocking execution** | `SC-EXEC-01M0TC6YM8000D5CJY389` — exit 1, `substrateClass: HARD` |
| Reviewer run | `SC-RUN-01M0TC6YQZ001NSYT2APZ` — BLOCKED |
| Attempt 2 | `SC-RUN-01M0TC7XR3001F1ZR60XV`, `SC-CS-01M0TC7XZE00075V7KEN4` (0 entries) |
| Sandbox probe | `SC-RUN-01M0TC27GK0017TDBNKVC` — COMPLETED |

## 3. Primary classification

**D. LIVE_FIXTURE_DEFECT.**

## 4. Why that classification is correct

The blocking condition is a property of where the fixture's worktree was placed, not of Serva's
logic and not of the machine's capability.

- **Not C (product defect).** Serva did exactly what it should: it ran the recipe the work item
  declared, observed a non-zero exit, recorded `SC-RTC-012 FAIL`, refused the change, and
  retried once before stopping. A gate that passed here would be the defect.
- **Not B (environment).** Node, git, WSL and the sandbox all worked. `substrateClass` is
  recorded as `HARD` on the execution itself.
- **Not E (inconclusive).** See §5 — the command reached the guest and produced a real,
  attributable interpreter error.
- **Not A (governance).** No gate, authority or owner decision blocked anything. The work item
  was dispatched and the Producer ran.

The fixture is at fault in a specific, correctable way: a CommonJS test suite was placed where
an ancestor `package.json` declares `"type": "module"`, and the fixture asserted no module type
of its own. A real onboarded Node project would declare one.

**Worth stating plainly: the Producer's change was correct.** The attempt-1 worktree at
`out/.serva-workspaces/live-join-fixture-1bf62e0d/SC-WI-01M0TBYDQF001CMHN8JR2-a01/src/total.js`
contains

```js
for (let i = 0; i < xs.length; i++) sum += xs[i];
```

— the off-by-one fixed, exactly what the requirement asked for. Scope and credential checks
passed. The only failing check failed *before the module was ever loaded*: the interpreter error
is about `test.js` line 1, the `require` call, not about `total()`.

Confirmed across all four executions: every one carries `require is not defined`, and **not one
carries an assertion failure** — the suite never reached `total()` on any attempt. Serva could
not know the change was right, and correctly declined to accept a change whose declared oracle
did not execute. Attempt 2 then reverted to the original loop and produced an empty ChangeSet,
which is the Producer flailing against an oracle that cannot pass — also correctly refused.

## 5. Transport: measured, not inconclusive

Applying the locked qualification transport invariant, this is a **measured negative**, not a
`NOT_MEASURED`:

- **Guest reached** — the stderr contains a guest-side path, `/mnt/d/SEVACODE/…`, produced by
  the guest's own Node resolving the guest's own filesystem.
- **Command executed** — Node started, parsed `test.js`, and threw at line 1.
- **Measurement occurred** — `durationMs: 891`, `exitCode: 1`, `terminationReason: "exited 1"`,
  with both stdout and stderr digests recorded.
- **Result genuinely negative** — the suite failed.

`substrateClass: HARD` and `substrateQualificationDigest: 5899e926…` are on the execution
record, so the run happened under a current measured boundary. Nothing here regresses or
depends on the HARD/NONE transport fix.

## 6. Must source code change?

**No.** No Serva behaviour under diagnosis is wrong. Every component did the right thing:
worktree isolation, scope conformance, credential scanning, recipe execution, gate refusal,
bounded retry, and stopping instead of accepting.

One thing is worth recording as an observation rather than a defect: `workspacesRootFor` places
worktrees in the project's **parent** directory. That is a deliberate and sound choice — it
keeps build output out of the project — but it means a project nested inside another Node
package inherits that package's module resolution. Serva is not wrong to do this; the fixture
was wrong to sit there without declaring its own type.

## 7. Must fixture truth change?

**Yes**, and minimally. The fixture must declare its own module type, which is truth that
legitimately existed before the live request: a real CommonJS project has a `package.json`
saying so. Adding it is describing the project honestly, not pre-solving anything.

The correction is exactly one file in the deterministic pre-seed:

```json
{ "name": "totals-fixture", "version": "1.0.0", "private": true, "type": "commonjs" }
```

It creates no ChangeRequest, no plan, no work item, no ChangeSet, no producer run, no review and
no commit for the live request. The defect in `src/total.js` remains, the acceptance criterion
remains unmet, and the suite still fails for the *right* reason until a Producer fixes it.

The prior fixture is recorded as **invalid**: its declared oracle could never have passed on
that machine, so no run against it could have reached an accepted commit.

## 8. Owner action required?

**No.** No `OwnerDecisionRequest` was raised anywhere in this chain.

## 9. Machine action required?

**No.** Nothing needs installing, and no WSL configuration should change. The guest executed
the command correctly.

## 10. Minimal next action

1. Add `package.json` with `"type": "commonjs"` to the deterministic pre-seed, tagged
   `DETERMINISTIC_PRESEED`.
2. Record that the previous fixture was invalid and why.
3. Restart the live acceptance honestly from a fresh pre-seed — **not** a resume. The existing
   chain is not corrupted, but its baseline commit does not contain the `package.json`, so
   resuming would re-run against a tree whose oracle still cannot execute.
4. Change nothing in `src/`.
