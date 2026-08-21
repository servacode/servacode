# PHASE 4 — CLOSURE REPORT

Serva Code · branch `phase-4-engineering-factory`
Bundle: `SERVA_CODE_PHASE_4_CLOSED.zip`

Three blockers, three root causes, no redesign. Phase 5 not started.

---

## 1. Real substrate implementation architecture

The old `HostExecutionSubstrate` conflated two independent questions and could answer
neither. It is replaced by three composable pieces:

| Piece | Question it answers | Implementations |
|---|---|---|
| `ExecTransport` | **Where** does the process run? | `LocalPosixTransport`, `WslTransport` |
| `SandboxLauncher` | **How** is it contained once there? | `BubblewrapLauncher`, `UnimplementedLauncher` |
| `SandboxedExecutionSubstrate` | probe → qualify → execute | one, over any transport + launcher |

A transport is deliberately dumb: it runs an argv and reports what happened. It contains
nothing and claims nothing — a transport that also enforced would make a transport
failure indistinguishable from a containment success, and "the command failed" would
start meaning "the boundary held".

**The path is now complete and real:**

```
prerequisites detected → Q-A…Q-K RUN through execute() → HARD derived from what
they proved → execute() runs Producer commands through that same boundary
```

There is no option, flag or constructor argument that sets the enforcement class.

## 2. Windows → WSL2 delegation model

```
Windows host (Serva orchestrates, keeps running here)
  → WslTransport, ONE distribution, selected deterministically
    → bubblewrap inside the guest
      → the engineering worktree
```

Only *execution* crosses. The worktree stays on the host filesystem, reached through
`/mnt/<drive>`, so the owner can open it in their editor while a Producer works in it.

Selection is deterministic and never "whichever answered": `SERVA_WSL_DISTRO` wins when
set, else the default WSL2 distribution, else the first WSL2 one by name. A
qualification measured against one distribution says nothing about another.

**Native Windows remains NON-HARD.** What changed is where the prerequisites *point*:
at the guest, which can satisfy them.

## 3. Real prerequisite detection

`WIN_NO_NATIVE_SANDBOX` is gone. It was `satisfied: false` forever, so the documented
remedy led nowhere — a dead end dressed as guidance. Every prerequisite now names
something a person can do:

`GUEST_NODE` · `GUEST_GIT` · `GUEST_BWRAP` · `GUEST_SOCAT` · `GUEST_ENGINE` ·
`SECCOMP_FILTER` · `USER_NAMESPACES` · `ENGINE_VERSION` — and, before a guest exists,
`WSL_DISTRIBUTION` or `WSL_VERSION_2` with the exact `wsl --set-version` command.

A binary resolving under `/mnt/` is still the Windows executable reached through interop
and still does not count.

## 4. Seccomp detection

Was hard-coded `satisfied: false`. It is now **detected**, two ways, because a global npm
install and a packaged binary land in different places:

1. an `srt` binary on the guest's PATH (rejecting `/mnt/`);
2. `npm ls -g --parseable @anthropic-ai/sandbox-runtime`.

The old behaviour was worse than a missing feature: a machine that *had* the filter would
have been told to install it, forever.

## 5. Actual Q-A…Q-K execution

Each case is a small program written to a file **with its paths already interpolated**,
then run through `this.execute()` — the same method a Producer command uses. File rather
than `node -e`: `wsl.exe` re-parses a Windows command line, so a quoted script is a
fidelity risk on that boundary and a file path is one token.

| | proves |
|---|---|
| Q-A | the permitted write SUCCEEDS — a boundary that refuses everything is broken, not safe |
| Q-B/C/G/H | checkout, outside, symlink and `../` writes refused |
| Q-D/E | store and other-run reads masked |
| Q-F | a **child process** cannot escape — the case that separates HARD from SOFT |
| Q-I | no network without a grant |
| Q-J | no host launch through interop |
| Q-K | **counts transport invocations**: exactly one means no unsandboxed retry |

`NOT_RUN` on a blocking case still costs the substrate HARD. Capabilities are derived
per dimension, because they fail separately — filesystem isolation can be perfect while
host escape is wide open.

**The launcher's argv template is asserted, not trusted.** Over-restrict → Q-A fails.
Under-restrict → Q-B…Q-K fail. Simply wrong → it does not launch. Every failure mode
ends in the same place: not HARD.

**Qualification fingerprint** covers engine version, transport, kernel, distro, launcher
and its version. `qualificationIsStale()` compares it. A timestamp could not answer this:
an hour-old qualification on an unchanged machine is fine; a minute-old one is worthless
after a kernel upgrade.

## 6. Actual `execute()`

Maps host paths to guest paths, builds the spec from `writeScope` / `readScope` /
`denyRead` / `networkAllowed`, and runs `launcher.wrap(command, spec)` through the
transport. Enforces cwd, write scope, timeout, output cap and the scrubbed environment
(`env -i` inside the guest).

bubblewrap argv: `--unshare-all` (network absent, not refused) · `--share-net` only on an
explicit grant · `--die-with-parent` · `--new-session` · `--ro-bind / /` then per-path
`--bind-try` · masks **last**, because bubblewrap applies left to right and the last word
must be the denial.

Refuses when the launcher is unavailable — there is no branch that runs the command
unwrapped. That is `failIfUnavailable` as a property of the code rather than a setting.
And there is deliberately no code after the result is captured: Q-K asserts the absence
of a retry by counting, because a rule that exists only in a comment is not a rule.

## 7. Fake substrate claim correction

Renamed `SimulatedExecutionSubstrate`. Its documented claim is now precise:

- **it does** check preconditions in-process before spawning, and refuses when not HARD —
  which makes the factory above it testable against something that genuinely says no;
- **it does not** contain anything. A child it starts is an ordinary host process.

Its qualification outcomes are **declared by a fixture, not measured**. `probe.simulated`
is `true`, every result detail says `SIMULATED:`, the fingerprint carries the marker so a
persisted qualification cannot later be mistaken for a real one, and
`serva engineering status` prints *"SIMULATED SUBSTRATE — this is not a containment
boundary."* Its own tests now claim determinism, not containment; the live suite asserts
`simulated === false`.

## 8. Producer AgentRuntime wiring

`src/engineering/dispatch.ts` → `dispatchProducer()`, through the **existing** Phase 3
runtime. No second AI runtime.

`AgentRunRequest` gained an optional `capability` grant. The runtime does not take it on
trust: `assertGrantWithinContract()` proves the grant does not exceed the contract before
anything is bound — a tool implying write needs a declared `fs.write`, a network scope
needs a declared one, and the always-denied set must be denied. A grant implements a
contract; it does not extend one. `cwd` is the **worktree**, which is what makes every
relative permission rule mean "inside this worktree".

`CAPABILITY_BOUND` records the grant actually used, plus its basis and the profile
digest, so *"what could run X do?"* is answerable from the log alone.

## 9. Sandbox profile wiring

`buildSandboxProfile` → `writeSandboxProfile` (under `.serva`, which the run itself is
denied) → `verifySandboxProfileInForce` → `InvocationRequest.settingsPath` → argv
`--settings <path>`, after `--setting-sources ''`. Nothing ambient, and exactly this.

The first version of the pre-dispatch check probed Serva's substrate to conclude
something about the **engine's** sandbox. Those are different boundaries and proving one
says nothing about the other — a real gap could have hidden behind a green check. It now
verifies what is actually verifiable without a model call: the engine can carry an
isolated settings source; the file is on disk and still digests to what Serva intended;
no drift against any effective policy the engine reports. What it **cannot** establish —
whether the engine honours the profile at runtime — is returned as `unprovedBoundary` and
printed, rather than quietly counted as verified.

## 10. Actual Reviewer AgentRun wiring

`dispatchReviewer()` — separate run, fresh session, `resolveReviewerPolicy` (no `Edit`,
no `Write`, no `Bash`, empty write scope). Its context is the work item, the exact
ChangeSet, the **measured evidence**, and the diff. It is not given the Producer's
reasoning: a reviewer that can read the argument reviews the argument rather than the
artifact. A test asserts the Producer's summary is absent from the reviewer's prompt.

## 11. Removal of the raw JudgedInput acceptance path

This made a required, BLOCKING criterion pass:

```ts
judged: [{ criterionId: 'EC-REVIEW', outcome: 'PASS', runRef: 'anything' }]
```

No run had to exist; `runRef` was never resolved against anything. The record would then
claim an independent review that never happened.

The production path now takes judged inputs from `judgedForChangeSet()`, which returns
only reviews validated against **ten conditions read from the run's own event log**: the
run exists · terminated · has an `AgentRunRecord` · COMPLETED · is the expected canonical
verifier · is not the Producer · is bound to this work item · had a read-only
`CAPABILITY_BOUND` grant · used a session distinct from the Producer's · returned a
locally-valid verdict echoing **this** ChangeSet.

The seam survives as `testOnlyJudged`, named so nobody reaches for it by accident. Every
result it touches is flagged `usedUnvalidatedJudgement`, and `acceptChange` refuses it —
plus an independent second check that a real review exists for the ChangeSet at all. Two
checks against the same fact from different directions.

## 12. ChangeSet → stage → commit identity

```
verified ChangeSet C
  → stage exactly C          scoped `git add -A -- <paths>`, both sides of a rename
  → prove INDEX == C         else CHANGESET_INTEGRATION_MISMATCH, nothing committed
  → commit
  → prove COMMIT == C        derived independently from the object database
  → only then record acceptance
```

The old code staged `entries where status !== 'D'` with a plain `git add`, so every
deletion vanished and every rename lost its old side. Nothing downstream would notice,
because every check had run against the worktree rather than the commit.

**Identity is a content map, not a diff.** The same change has more than one legitimate
shape: a rename in the worktree is a deletion plus an untracked addition, because git
cannot detect a rename into a file it is not tracking; once staged, `--find-renames`
reports one `R`. Comparing statuses would reject a correct integration; comparing diff
text would too, since untracked files are absent from a worktree diff and present in a
staged one. So identity canonicalises to the only invariant: **which paths ended up with
which content**, keyed by **git blob id** (computed in-process from exact bytes, never by
decoding stdout as UTF-8 — that corrupts binaries and can split a multi-byte sequence
across chunks).

A pre-staged index is **refused, not cleared**: `git reset` is not in Serva's verb set,
and discarding somebody's staged work to make an integration succeed is a destructive act
taken for convenience.

**Also fixed:** ChangeSet identity was a fresh id per inspection, so re-verifying an
unchanged worktree destroyed its own evidence — measure, then measure again with a
reviewer required, and a change that had just passed came back `NOT_VERIFIED`. Identity
is now a function of the change. Staleness is unaffected: edit a file and the digest
moves.

## 13. Deletion / rename integration tests

`tests/eng.integration.test.ts`, 13 tests, real repositories:

modified · new · **deletion** · **rename (both sides)** · mixed add+modify+delete ·
byte-identical content · unrelated dirty path not staged · verified file modified after
the gate → refused pre-commit · verified file deleted after the gate → refused ·
pre-staged index → refused · identity derived from git · differing base is a difference ·
an entry with no content identity is refused.

## 14. Offline test count and result

**673 tests green** (was 625; +48). Format, lint, typecheck and build clean.

| Suite | Tests |
|---|---|
| `eng.substrate.test.ts` | 48 |
| `eng.dispatch.test.ts` | 16 |
| `eng.integration.test.ts` | 13 |
| `eng.factory.test.ts` | 52 |
| `eng.workspace.test.ts` | 31 |
| `eng.status.test.ts` | 13 |
| everything from Phases 1–3 | preserved, unchanged |

Every offline test runs real child processes against real disposable Git repositories,
and **no offline test spends a model call** — Producer and Reviewer dispatch are
exercised end to end through `FakeEngineAdapter`.

## 15. Live engineering result

`npm run test:engineering-live` — 4 tests green.

```
  host:          win32/x64
  guest:         Ubuntu 26.04 LTS
  substrate:     sandboxed:wsl:Ubuntu
  chosen because Windows host delegating execution to WSL2 distribution "Ubuntu".
                 Native Windows remains NON-HARD; the guest is the candidate.
  isolation:     BUBBLEWRAP
  engine:        2.1.218
  class:         NONE
  authority:     REFUSED

  verdict:  BLOCKED — PLATFORM_PREREQUISITE_REQUIRED
  No worktree was created. No Producer was dispatched. No Reviewer was
  dispatched. No command was run. No model call was made.
```

The delegation model is working: WSL2 was found, the guest was probed, and `git` and
`bwrap` are already present there.

## 16. Remaining machine prerequisites

Four, all inside the Ubuntu guest, all satisfiable:

| id | remedy |
|---|---|
| `GUEST_NODE` | install Node.js inside the distribution |
| `GUEST_SOCAT` | `sudo apt-get install socat` |
| `GUEST_ENGINE` | install Claude Code inside the distribution |
| `SECCOMP_FILTER` | `npm install -g @anthropic-ai/sandbox-runtime` (inside the distribution) |

**Serva installed none of them and will not.** Changing the machine a sandbox runs on is
the owner's decision.

## 17. Git commits

- `09ce3f1` Phase 4 — engineering factory and verified execution
- `83dcac4` Phase 4 engineering factory report
- *this commit* Phase 4 closure — real substrate, real dispatch, exact integration

## 18. Remaining Critical / High defects

None known that are Critical. Honest High-severity limits, stated rather than buried:

1. **The HARD path has never executed on this machine.** The code path exists, is
   exercised offline end to end with a scripted engine, and is ready for qualification —
   but bubblewrap containment itself has not been measured here, because the guest is
   missing four packages. Until it is, `HARD` is a code path, not an observed fact.
2. **macOS has no launcher.** Seatbelt is not implemented; a macOS host reports the
   prerequisite unsatisfied and refuses to execute. Honest, and a real gap.
3. **Whether the engine honours the sandbox profile at runtime is not established
   pre-dispatch.** It is reported as `unprovedBoundary` rather than assumed. Closing it
   needs either an engine that reports its effective policy or a live measurement.
4. **`wsl.exe` argument fidelity is an assumption**, not a load-bearing one: Q-A runs
   through the same path, so a transport that mangles arguments fails to qualify.
5. The escape-hatch scan is a contextual heuristic over source text, not semantic
   analysis.

## 19. Phase 5

**Not started.** No deployment, no remote push, no GitHub PR, no browser or Android
testing, no VS Code UI. Nothing was installed, enabled, rebooted or reconfigured on this
machine.
