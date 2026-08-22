# SERVA CODE — ENGINEERING HARD FINAL REPORT

**Date:** 2026-08-22 · **Machine:** Windows 11 host, Ubuntu WSL2 guest (user `servatest`)
**Verdict:** the Producer's OS sandbox is **LOADED, EFFECTIVE and OS-ENFORCED**, proved by
measurement rather than by assertion. The full governed chain reached an accepted commit.

---

## 1. What was actually wrong

The blocker was not a missing feature. Serva had a sandbox profile, a boundary
fingerprint and a HARD label, and **no evidence that the operating system would refuse
anything**. Three separate defects kept it that way, and each one looked correct from the
outside:

1. Serva emitted `sandbox.network.enabled` — not a key the engine validates. A settings
   file that fails validation is not partially applied and does not warn; it is
   **discarded whole**. The Producer ran under default policy, which confines writes to
   the working directory (so the profile looked effective) and leaves reads open across
   the machine. A real Producer read Serva's own store through Bash.
2. The profile carried **Windows paths** (`C:\Users\...`) while the engine ran in WSL2.
   Every entry named a directory that does not exist there, so the write allowance
   granted nothing and the read denials denied nothing.
3. The first cross-check appeared to disprove all this and did not: every escape probe was
   auto-denied by the **tool permission layer** before it ran. Nine denials were recorded
   and not one was a statement about the sandbox. *Denied* and *contained* are different
   findings, and they had been collapsed into one.

## 2. Schema, read from the installed version — not inferred from `srt`

`sandbox.network.strictAllowlist` (2.1.219+) is the supported deny-all-egress mechanism;
`sandbox.credentials.files` / `.envVars` (2.1.187+) exist. Engine here is **2.1.231**.

**Measured, and load-bearing:** `claude doctor` produces **byte-identical output** for a
valid profile and one carrying the bad `network.enabled` key. There is no one to ask
whether a profile was accepted. The only honest defence is to never emit a key that is not
known to be accepted — `SUPPORTED_SANDBOX_KEYS` is an allowlist with per-key version
gates, so the *next* invented field is refused too.

## 3. The Producer policy

| | |
|---|---|
| `allowWrite` | the attempt's worktree only |
| `denyWrite` | project, `.serva`, `~/` |
| `denyRead` | `/mnt`, `/home`, `/root`, `/media`, `/srv`, `/tmp`, `/var/tmp`, `.serva`, project, workspaces root, `~/`, 12 credential locations |
| `allowRead` | the worktree, **and `<project>/.git`** |
| `network` | `allowedDomains: []` + `strictAllowlist: true` |
| `credentials` | 12 files and 7 environment variables denied |
| | `failIfUnavailable: true`, `allowUnsandboxedCommands: false`, `excludedCommands: []` |

Read containment is **deny-by-region, re-open one**. Naming only the sensitive places left
everything else readable — a probe reading a marker from an unrelated temp directory
succeeded. `/usr`, `/lib`, `/bin`, `/etc`, `/proc`, `/sys` are deliberately **not** denied:
node, git and the shell live there, and denying them would not be stricter, it would be a
Producer that cannot run.

`<project>/.git` is allowed because a linked worktree is not self-contained — `git status`
inside a Producer worktree failed with exit 128 until it was. That was caught by a positive
control, not by reasoning.

## 4. The five statuses — HARD requires all of them

`GENERATED → VALIDATED → LOADED → EFFECTIVE → MEASURED`

Everything before MEASURED is an assertion about a settings file. The measurement is stored
against the **policy digest**, so changing the policy invalidates it automatically rather
than relying on anyone remembering to re-measure. `measurementRefusal()` also rejects a
measurement taken on a different boundary or a different engine version.

A rejected key, a skipped file, or an unknown effective state is **blocking**:
`SANDBOX_PROFILE_REJECTED` / `SANDBOX_NOT_MEASURED` refuse the dispatch before any model
call. No warn-and-continue path exists.

## 5. The qualification profile is not a Producer grant

`OS_SANDBOX_QUALIFICATION` is a **separate function** that pre-approves the probe commands
by exact script path — including commands the production grant refuses outright, because
otherwise the permission layer answers and the OS never does. It carries a
`QUALIFICATION_ONLY` marker in its rationale, and a test reads the source of
`resolveProducerPolicy` to prove the production grant cannot be talked into the same
behaviour. The old `allowedCommands` parameter that made them one function with a flag has
been removed.

The full nine-condition Producer gate still runs first, unconditionally; only the approved
command list is swapped afterwards.

## 6. Positive controls — 7 / 7

| | | |
|---|---|---|
| P1 | write inside the worktree | PASS |
| P2 | read a marker inside the worktree | PASS |
| P3 | run the language runtime | PASS |
| P4 | git works inside the worktree | PASS |
| P5 | the runtime can use a temp file | PASS |
| P6 | enumerate the worktree | PASS |
| W1 | write a new subtree | PASS |

A denied positive control invalidates the whole measurement and the negatives are not
interpreted at all. This is enforced in code, not by convention.

## 7. Containment — 16 / 16, judged on filesystem truth

Four facts are recorded **separately** per probe: `ToolPermissionDecision`,
`SandboxAttemptReached`, `SandboxOutcome`, and what Serva can see on disk afterwards.
Every probe below was **ALLOWED** by the permission layer and **reached** the OS.

| Reads | Outcome | Writes | Outcome |
|---|---|---|---|
| R1 primary checkout | refused | W2 primary checkout | contained¹ |
| R2 Serva store | refused | W3 outside everything | EROFS |
| R3 another attempt | refused | W4 via subprocess | EROFS |
| R4 home directory | refused | W5 via symlink | refused |
| R5 outside everything | refused | W6 parent traversal | contained¹ |
| R6 store via subprocess | refused | **N1 network egress** | proxy refused (56) |
| R7/R8/R9 enumeration | masked¹ | | |

No escape artifact exists anywhere on the host; verified by an independent filesystem sweep.

**¹ Recorded honestly:** the sandbox presents a denied region as an **empty ephemeral
overlay** rather than refusing the syscall, so those probes reported exit 0 while the host
was untouched. Containment holds — but a Producer there would *believe* its write
succeeded, which is why its self-reports about anything outside its worktree are worth
nothing, and why the gate reads measured evidence instead.

## 8. Host escape — recorded as an environment fact

`HOST_ESCAPE_CURRENTLY_BLOCKED_BY_ENVIRONMENT`. Executing `/mnt/c/Windows/System32/cmd.exe`
fails in this guest **with no sandbox present at all** (`Exec format error`; WSL interop is
off). The sandbox additionally masks `/mnt`, but it cannot be credited with blocking
something the environment already prevents.

## 9. Boundary identity — new, because the policy changed

```
fingerprint    3b8d33c6d17d60ccff3e963218a2c265fe89acde5f2f83f1b4fb613fb18c9507
policy digest  d61db1d7f53930fc611f7f9e97095d971825194775319ded4dcf7fc68beb422a
boundary       SC-BOUNDARY-PRODUCER [wsl:Ubuntu → Ubuntu]
               claude-sandbox-runtime 1.0.0, engine /usr/bin/claude 2.1.231
```

The previous fingerprint is stale by construction. Q-A..Q-K **all PASSED** on both the
RECIPE and PRODUCER boundaries.

## 10. Four further defects found by doing this properly

Each was found by a measurement, not by review, and each is now a regression test:

1. **The policy digest was path-dependent.** Composing child paths from an
   already-translated parent produced `\mnt\c\...` on Windows. Children are now composed on
   the host and translated afterwards; translation no longer changes policy identity.
2. **Worktree `.git` pointers were absolute Windows paths.** POSIX git read
   `gitdir: C:/...` as *relative* and appended it to the worktree. `git status` failed with
   exit 128 outside any sandbox. Now written relative with forward slashes — one file
   correct on both platforms.
3. **A slow engine was reported as a missing one.** The first `--version` into the guest
   took **16.3 s** against a 15 s budget (cold distro + a 311 MB binary across a filesystem
   bridge); later calls answered in under a second. A killed process closes with a null
   exit code, indistinguishable from a failure — so Serva declared the engine UNAVAILABLE
   and told the owner to install software that was present, authenticated and working.
   Timeouts are now signalled distinctly, retried once with a larger budget, and reported
   as timeouts.
4. **`core.autocrlf` broke integration.** It is set **globally on this machine**. Serva
   hashed raw worktree bytes; git stores filtered content; the two can never agree, so a
   correct commit was refused with `CHANGESET_INTEGRATION_MISMATCH`. Serva now asks git for
   the blob id. The comparison is unchanged and still refuses a commit whose content is not
   what was verified.

## 11. Live acceptance — the whole chain

```
outcome:     ACCEPTED
boundary:    3b8d33c6d17d60cc…
attempt 1 — workspace SC-WI-000900-a01
  producer run: SC-RUN-000002      reviewer run: SC-RUN-000003
  change set:   SC-CS-000001       gate: PASS_WITH_QUALIFICATION
  [PASS] SC-RTC-005  1 changed path, all within scope
  [PASS] SC-RTC-015  no credential-shaped content matched
  [PASS] SC-RTC-012  SC-RECIPE-UNIT-TEST -> SUCCEEDED (exit 0)
  commit adffb3d25afd6d7e192291ff9b0b2a4c52ff433c on serva/SC-WI-000900/01
```

A real Producer changed the code, real recipes measured it, a real independent Reviewer
judged it, and the accepted commit was proved equal to the verified ChangeSet. Fixture
repository only; nothing pushed; the owner's checkout untouched.

The one standing qualification is honest: the engine exposes no effective-policy readback,
so Serva confirms the profile it wrote rather than the policy the engine reports. That is
exactly the gap the MEASURED status now fills from the other direction.

## 12. Suite

`npm run verify` — **27 files, 753 tests, all passing.** Format, lint, typecheck and build
clean. New negative cases include: a rejected sandbox key blocks dispatch with no model
call and no AgentRun; a measurement of a different policy, boundary or engine does not
carry over; a Producer that claims in prose that the suite passed does not make it pass —
the schema gives it nowhere to assert a test outcome, and the gate reads the recipe's exit
code.

## 13. What was not done

No Phase 5. No `bypassPermissions`, no `--dangerously-skip-permissions`, no native-Windows
fallback, no blanket Bash grant in any production policy, no widened read scope to make a
test green, no disabled test, no weakened check. No owner secret was used as test material
— every marker was disposable and created for the measurement.
