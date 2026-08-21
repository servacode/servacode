# PHASE 4 — ENGINEERING FACTORY REPORT

Serva Code · branch `phase-4-engineering-factory` · commit `09ce3f1`
Bundle: `SERVA_CODE_PHASE_4_AUDIT.zip`

Two sentences govern everything below.

> **Claude never certifies its own work.**
> **NO EVIDENCE = NOT VERIFIED.**

Every design decision in this phase is downstream of one of them.

---

## 1. What was built

`OWNER REQUEST → DETERMINISTIC PLAN → ISOLATED WORKSPACE → PRODUCER → SCOPE
CONFORMANCE → DETERMINISTIC BUILD/TEST/LINT/SECURITY → INDEPENDENT REVIEWER →
QUALITY GATE → ACCEPT / REWORK / ESCALATE → DETERMINISTIC LOCAL INTEGRATION`

31 files, 8,340 lines. 125 new offline tests, 4 live. `npm run verify`: **625 tests
green**, format / lint / typecheck / build clean.

## 2. Execution substrate abstraction

`src/substrate/types.ts` defines `ExecutionSubstrate` with `probe()`, `qualify()`,
`capabilities()`, `execute()` and `explain()`. Nothing above it knows what enforces the
boundary — only what was proved about it.

## 3. The enforcement class is derived, never asserted

`deriveEnforcementClass(tests, capabilities)` reaches `HARD` only when **every blocking
qualification case PASSED** and both write and execute are enforced. A `NOT_RUN`
blocking case counts against a substrate exactly as `FAILED` does: "we could not check
whether it escapes" and "it escapes" are the same fact for this decision. WSL2 is a
*candidate*, never a synonym for HARD.

## 4. The qualification catalogue

`src/substrate/qualification.ts` — cases Q-A … Q-K, each carrying an `expectation` and a
`rationale`. They are adversarial: write outside scope, read a credential path, escape
by symlink, escape by subprocess, reach the network, reach the host. `BLOCKING_CASE_IDS`
names the subset that gates HARD.

## 5. This machine cannot be qualified, and says so

`npm run test:engineering-live` on this host:

```
  host:      win32/x64          isolation: NONE
  class:     NONE               authority: REFUSED
  PLATFORM_PREREQUISITE_REQUIRED — 5 item(s):
    - WIN_NO_NATIVE_SANDBOX   A sandbox-capable platform (macOS, Linux or WSL2)
    - WSL_CLAUDE              Claude Code installed inside the WSL2 distribution
    - WSL_NODE                Node.js inside the WSL2 distribution
    - WSL_SOCAT               socat
    - WSL_SECCOMP_FILTER      @anthropic-ai/sandbox-runtime (the seccomp filter)
```

Each carries a `why` and a `remedy`. **Nothing was installed, enabled or rebooted.** The
seccomp filter is called out specifically because on WSL2 it is the only thing that
blocks the Unix socket used to launch Windows host binaries — bubblewrap can be working
perfectly while host escape remains open.

## 6. No silent fallback

The live suite's not-HARD path does not skip. It asserts the refusal, then proves the
consequence: `listExecutions(store)` is empty, no worktree exists, the checkout is clean.
Serva did not downgrade itself to SOFT to make the demo pass.

## 7. Refusal is enforced at the point of execution

`runRecipe()` calls `engineeringAuthorityRefusal()` **before it starts a process**, not
only at the factory level. A guard further up can be forgotten; this one cannot be routed
around.

## 8. Isolated engineering workspaces

One Git worktree per attempt, on branch `serva/<work-item>/<attempt>`. Every path segment
is validated against the Phase 2 confinement rule and resolved through symlinks before
containment is judged.

## 9. Worktrees live outside the repository

`<parent>/.serva-workspaces/<basename>-<digest8>`. Inside the project was the obvious
choice and it was wrong: a worktree under the root appears in the primary checkout's
`git status`, so `git add .` would sweep an entire engineering attempt into a commit.
A test proved it — `editing the worktree leaves the primary checkout byte-clean` failed
before the move.

## 10. Serva owns Git

`GitService` is the single choke point with a closed verb set. `FORBIDDEN_GIT_VERBS`
refuses `push`, `merge`, `rebase`, `remote`, `config`, `filter-branch`. Arguments are
checked for option-like values even inside arrays. **Phase 4 performs no remote write of
any kind.**

## 11. Producer capability: eight conditions, all required

`producerRefusal()` — HARD substrate · contract loads · agent in the enabled set ·
contract declares the capability · isolated worktree exists · worktree is not the
checkout · independent reviewer available · executors available. Any one false gives
`E_CAPABILITY_NOT_ENABLED` **with the reason**. There is no downgrade path to read-only.

## 12. Capabilities are not enabled merely because the tools exist

`PHASE4_CANDIDATE_PRODUCERS` is a deliberate list, and membership is necessary and
nowhere near sufficient. SC-AGENT-190 (Integration Engineer) is listed and refused every
time: its contract declares `DECLARED_HOSTS` network scope and Phase 4 grants a Producer
no network. It stays in the set so the status **explains** why it is off.

## 13. The reviewer is read-only by construction

`resolveReviewerPolicy()` grants no `Edit`, no `Write`, no `Bash`, and an empty write
scope. Not read-only by configuration — there is nothing to widen.

## 14. Publishing verbs are denied at the tool layer too

`PRODUCER_DENIED_COMMANDS` denies `git push/remote/config/merge/rebase/reset/clean/
worktree`, `gh`, `curl`, `wget`, `ssh`, `scp`, `npm publish`, `sudo`. `Agent` and `Task`
are denied because a Producer that could spawn a subagent would run an ungoverned run
inside a governed one.

## 15. Escape hatches are never enabled

`--dangerously-skip-permissions`, `bypassPermissions` and `dangerouslyDisableSandbox`
appear only inside refusal lists. A live test scans `src/**` and fails on any occurrence
not in a refusing context.

## 16. Sandbox profile generated by Serva, failing closed

`buildSandboxProfile()` sets `sandbox.failIfUnavailable: true` and
`sandbox.allowUnsandboxedCommands: false`, grants write only to the worktree, denies the
checkout and `.serva`, and leaves network off unless explicitly granted.
`sandboxProfileDrift()` detects divergence between intended and effective policy.

## 17. Recipes are data; a model names one, it never composes one

`ExecutionRecipe` is `executable` (a bare program name — never a path, never a shell
line) plus an argument **array**. There is no shell, so there is nothing for an argument
to escape into. `shellEvaluation` is refused at registration. `RecipeRegistry.get()` is
the only place a model-supplied string touches execution, and it can only *select*.

## 18. The environment is constructed, not inherited

`MINIMAL` keeps a documented allowlist and drops everything else. `INHERIT_SAFE` still
drops anything credential-shaped (`*TOKEN*`, `*SECRET*`, `ANTHROPIC_*`, `CLAUDE*`, `AWS_*`
…). A build does not need the owner's tokens, and an inherited environment is the
quietest exfiltration channel there is.

## 19. Executions are bounded and recorded as fact

Wall-clock timeout, capped output, exit code, duration, environment **digest** (never
values), substrate class and qualification digest. Raw output never enters the permanent
trace — digests plus a 2,000-character excerpt. A timeout is `TIMED_OUT`, which routes to
`INDETERMINATE`, **not** to `FAIL`: "the code is wrong" and "we could not find out" are
different claims.

## 20. Deterministic runtime components

`SC-RTC-005` Scope Conformance · `SC-RTC-011` Build · `SC-RTC-012` Test · `SC-RTC-013`
Lint · `SC-RTC-015` Secrets. No model, no prompt, no judgement — each runs a registered
recipe or a pure check and records what it observed.

## 21. Serva computes the ChangeSet; the agent does not declare it

`buildChangeSet()` observes the worktree with `lstat` (a symlink is recorded as a
symlink, never followed silently) and produces a content digest plus a diff digest. An
agent that could name its own diff could omit a line from it.

## 22. Evidence is bound to a ChangeSet, so staleness is computable

Every evidence record names its ChangeSet. `deriveEvidenceValidity()` returns `STALE` for
any other — **derived, never written**. The historical record is never mutated. This is
the mechanical answer to "but the tests passed earlier": they did, against something
else.

## 23. Scope conformance stops the run

If the change escaped its declared scope, the deterministic checks **do not run**.
Measuring an unauthorized change would produce true statements about work nobody asked
for, and the green would read as the headline. Findings cover outside-scope, forbidden,
escapes-workspace, unexpected binary, unexpected symlink, credential file, lockfile,
git metadata.

## 24. The Secrets Scanner reports without disclosing

Ten rules. A finding carries path, line, category, severity, match **digest** and match
**length** — never the value. Placeholders are downgraded to MEDIUM, never suppressed:
the scanner does not get to decide that a comment is telling the truth. **No discovered
secret value is ever sent to a model or written to the store.**

## 25. One gate engine, not two

`evaluateEngineeringGate()` builds a `QualityGate` and a set of `CriterionEvaluation`s
and hands them to the **Phase 2 engine**. Composition, severity binding, waiver
validation and the disposition table all stay where they already lived. There is no
second verdict system to diverge.

## 26. Absence is INDETERMINATE, never PASS and never FAIL

`testsExistence` is `false` for every engineering criterion. A missing test result means
nobody looked. Missing evidence → `NOT_VERIFIED`. A missing reviewer verdict is
`INDETERMINATE`, not an implicit approval. Stale evidence cannot satisfy a criterion
however green it was.

## 27. Acceptance carries its provenance

An accepted change becomes a local commit on its own branch whose message names the work
item, the ChangeSet, the producer, the reviewer, the gate result and every evidence id.
A reviewer's approval is JUDGED basis, so the honest verdict is
`PASS_WITH_QUALIFICATION` — accepted, and the record says out loud that one reason was
judgement rather than measurement.

## 28. Rework is bounded and built from evidence

`canRework()` is capped by the work item's own `maxAttempts`; past it the answer is "an
owner decision, not another retry". `reworkContext()` is composed from **evidence**, not
from the previous attempt's reasoning, and states explicitly that nothing carries
forward.

## 29. Reconciliation reports; it never repairs by overwriting

Eleven divergence kinds, each with a remedy and a `selfRepairable` flag. A dirty primary
checkout, a missing worktree and an external edit are separate conditions. Serva reports
divergence and **does not overwrite the owner's work to make its own records look right**.

## 30. Owner-facing surface

`serva engineering status | qualify | doctor | reconcile`, `serva worktrees`,
`serva changes`, `serva evidence`. Output leads with the authority state, because a green
list of workspaces under an unqualified substrate would be actively misleading.
Governance is three-valued — ACTIVE / DEGRADED / BLOCKED — never a boolean.

**Defect found and fixed while writing these tests:** `engineeringStatus` asked Phase 3's
`capabilityLevelFor` whether a Producer could be enabled. That function answers what
*read-only* level a contract can be granted and treats a declared `fs.write` as
disqualifying — so every Producer was reported permanently unavailable on a fully
qualified substrate, with a plausible-sounding reason. Split out
`producerContractRefusal()` and used that instead.

## 31. Verification

| Suite | Tests | Result |
|---|---|---|
| `npm run verify` (whole repo) | 625 | green |
| `tests/eng.substrate.test.ts` | 31 | green |
| `tests/eng.workspace.test.ts` | 31 | green |
| `tests/eng.factory.test.ts` | 51 | green |
| `tests/eng.status.test.ts` | 12 | green |
| `npm run test:engineering-live` | 4 | green — **BLOCKED, PLATFORM_PREREQUISITE_REQUIRED** |

Offline tests run **real child processes against real disposable Git repositories**,
never against the Serva source tree. `npm run test:claude` was **not** re-run: no Phase 4
change touches the engine adapter, the agent runtime or the tool policy, so a live model
call would spend the owner's usage for no signal.

---

## What Phase 4 deliberately did not do

No deployment. No production credentials. No GitHub PR automation. No remote push. No
Playwright, no Android, no VS Code extension UI. No automatic installation of WSL, no
Windows optional components, no reboots, no privileged OS changes, no system security
configuration.

## Honest limits

- **This machine cannot run a Producer.** Everything above is verified against a
  simulated substrate that genuinely enforces its boundary in-process and genuinely
  refuses — but it is not an OS sandbox, and it does not claim to be. Qualifying a real
  HARD substrate requires the five prerequisites in §5, and that is the owner's decision.
- **The live acceptance has never run its HARD path on this host.** The code path exists
  and is exercised offline; it has not been proved against bubblewrap and seccomp.
- The escape-hatch scan in §15 is a contextual heuristic over source text, not a
  semantic analysis.

**STOP. Phase 5 not started.**
