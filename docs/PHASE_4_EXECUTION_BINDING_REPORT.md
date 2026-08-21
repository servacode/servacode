# PHASE 4 — EXECUTION BINDING CLOSURE REPORT

Serva Code · branch `phase-4-engineering-factory` · commit `7226f97`
Bundle: `SERVA_CODE_PHASE_4_FINAL.zip`

One defect, one root cause, fixed. Phase 5 not started.

> Serva measured `Windows → WSL2 → bubblewrap → worktree`.
> The Producer ran `Windows → spawn("claude") → native Windows, no sandbox`.
>
> Both were true at once, and every check passed, because the only question asked at
> dispatch was `enforcementClass === HARD` — **a claim with no subject.**

---

## 1. Actual Producer execution boundary

`ExecutionBoundary` ([boundary.ts](src/substrate/boundary.ts)) carries: `purpose`,
`transport`, `guest`, `engineLocation`, `engineVersion`, `sandboxMechanism`,
`sandboxVersion`, `profileDigest`, `simulated`, and a `fingerprint` over all of it.

`boundaryMismatch()` reports differences **field by field**, not "digests differ" — an
operator who has just been refused needs to know which thing moved.

This is **condition 0** of the capability gate, checked ahead of the enforcement class:
a HARD class for the wrong boundary is more dangerous than no class at all, because it
reads as permission. `actualBoundary` is a **required** field of `ProducerGateInput`, so
no call site can omit it and compile.

## 2. Host versus guest engine architecture

```
Windows Serva orchestrator (stays on the host)
  → WslProcessLauncher, the exact selected distribution
    → the guest's own `claude`
      → Claude Code's sandbox, configured by Serva's profile
        → the host-mounted engineering worktree
```

`ClaudeCliEngineAdapter` no longer calls `spawn` directly; a `ProcessLauncher` decides
where, and every path crossing into argv (`--system-prompt-file`, `--settings`, cwd) is
translated through it. The adapter was **refactored, not duplicated** — one Claude
integration, one `AgentRuntime`, and the runtime stays provider-agnostic.

Read-only Phase 3 agents keep the host engine: their governance is the tool policy, which
holds wherever the process runs. A write- or exec-capable Producer may not.

## 3. Guest Claude probe, auth and billing

`resolveEngineeringEngine()` probes the guest for real: executable path (**refusing one
under `/mnt/`**, which is the Windows binary reached through interop), version,
`auth status`, authenticated state, billing route, and the three capabilities Serva
governs through — structured output, tool restriction, settings isolation.

Missing auth is `GUEST_ENGINE_AUTH`; an API-key or third-party route is
`GUEST_ENGINE_BILLING`. **No credential is copied into the guest, no token extracted, no
login attempted**, and `WSLENV` is left unset so Windows-side `ANTHROPIC_API_KEY` cannot
cross and silently change the billing route.

There is **no fallback to the host engine** for a Producer. On Windows without a usable
guest, `resolveEngineeringEngine` returns no adapter at all — there is nothing to
dispatch onto the host.

## 4. Qualification ↔ boundary binding

The qualification carries the boundary it measured. At dispatch the boundary is derived
**independently**, from `runtime.engineLocation()` — the runtime's own engine, not a
value the caller supplied.

Independently observed at dispatch: **transport, guest, engine executable, profile
policy digest**. Those are exactly the fields that were wrong. Carried from the
qualification: sandbox mechanism and version — re-probing the guest per dispatch would
be a second measurement, not a second opinion. That distinction is stated in the code so
the check is not read as proving more than it does.

`profileDigest` is **path-independent** (`policyDigest`): every attempt has its own
worktree, so a digest over concrete paths would refuse every dispatch while looking
rigorous. It moves when the write-scope shape, denied reads, network stance, or either
of `failIfUnavailable` / `allowUnsandboxedCommands` changes.

`CAPABILITY_BOUND` records the boundary description and fingerprint alongside the policy.

## 5. socat / seccomp responsibility cleanup

There are two boundaries and they were sharing one prerequisite list:

| | RECIPE | PRODUCER |
|---|---|---|
| what it contains | `npm test`, `npm run build`, lint | the engine session and its Bash children |
| mechanism | bubblewrap, invoked by Serva | Claude Code's sandbox runtime |
| binaries | node, git, bwrap | node, git, bwrap, **socat** |
| syscall filter | not used | **is the launcher** |
| engine version | not applicable | required |

`socat` moved to where its network proxy is actually used. The standalone "is the filter
installed?" checkbox is **gone**: on the Producer boundary the filter *is* the launcher
that wraps every qualification case, so detection and participation are now the same
fact. Presence has stopped standing in for enforcement, and Q-J remains the measured
check. `ENGINE_VERSION` likewise applies only where an engine exists.

## 6. The sandbox actually measured for Producers

`ClaudeSandboxLauncher` wraps each adversarial case in the **same sandbox runtime, with
the same settings profile**, that a Producer receives. It **reads the runtime's command
line from `--help`** rather than assuming one, and reports itself unavailable — with the
help text it saw — if the surface is unfamiliar. A wrong guess yields a refusal with a
legible reason, never a Producer running loose.

A blanket network grant is refused outright: the engine reaching the provider is not a
reason to give every Producer subprocess egress.

**Stated limit:** this measures the Bash sandbox. It does **not** measure the model's own
tool-call permission layer, which is governed separately by the availability and
permission rules Serva computes and is covered by the Phase 3 capability tests.

## 7. Dispatch refusal on mismatch

`producerRefusal` refuses, in this order: boundary mismatch → wrong purpose → simulated →
enforcement class → the eight prior conditions. Refusals happen **before** a worktree is
created, a model is called or a command runs.

## 8. EngineeringFactory production orchestration

[implement.ts](src/app/implement.ts) → `implementWorkItem()`: validate → resolve engine →
refuse unless **that** boundary is HARD → worktree → **real** `dispatchProducer` →
`buildChangeSet` → deterministic checks → **real** `dispatchReviewer` → gate →
`acceptChange` or bounded rework. It composes the existing functions and reimplements
none of them. `dispatchProducer`/`dispatchReviewer` now have production callers.

## 9. CLI

`serva implement <work-item-id>` — asks the owner nothing about implementation
technology. Prints governance, execution boundary, producer, workspace, ChangeSet,
measured checks, reviewer, gate, result. When the boundary is not HARD it stops before
any worktree mutation, model dispatch or command execution and prints the exact
prerequisites.

## 10. Offline tests

**705 green** (+32). Format, lint, typecheck, build clean.

| suite | tests | covers |
|---|---|---|
| `eng.binding.test.ts` | 21 | boundary mismatch refusals, guest probe, production flow, no-shortcut scans |
| `eng.substrate.test.ts` | 60 | boundary identity, per-boundary prerequisites, real qualification |
| `eng.dispatch.test.ts` | 16 | Producer/Reviewer AgentRuns, anti-fabrication |
| `eng.integration.test.ts` | 13 | ChangeSet → commit identity (unchanged, still green) |
| others | 595 | Phases 1–3 preserved |

Boundary binding: WSL-qualified + native engine → refused; distro A ≠ distro B; version X
≠ Y; changed profile invalidates; recipe boundary ≠ Producer boundary; simulated refused
without an explicit opt-in; exact boundary eligible; `CAPABILITY_BOUND` carries the
fingerprint. Plus scans proving **no file under `src/` sets `allowSimulatedBoundary` or
`testOnlyJudged`**, and that the boundary check precedes the enforcement-class check.

No offline test spends a model call.

## 11. Live result

```
RECIPE boundary   SC-BOUNDARY-RECIPE [wsl:Ubuntu → Ubuntu 26.04 LTS] bubblewrap 0.11.1
  [ ok ] GUEST_GIT   [ ok ] GUEST_BWRAP   [ ok ] SANDBOX_LAUNCHER   [ ok ] USER_NAMESPACES
  [MISS] GUEST_NODE
  class: NONE

PRODUCER boundary the Producer runs inside WSL2 "Ubuntu"; native Windows has no sandbox
  guest engine: (not found)   authenticated: false   class: NONE   authority: REFUSED
  refusal: PLATFORM_PREREQUISITE_REQUIRED: GUEST_ENGINE

ACCEPTANCE  BLOCKED — no worktree, no Producer, no Reviewer, no command, no model call.
```

6 live tests green. No native-host adapter is constructed for a Windows Producer.

## 12. Remaining machine prerequisites

| id | remedy |
|---|---|
| `GUEST_NODE` | install Node.js inside the Ubuntu distribution |
| `GUEST_ENGINE` | install Claude Code inside the distribution |
| then `GUEST_ENGINE_AUTH` | run `claude` there once and sign in |
| then `SANDBOX_LAUNCHER` | `npm install -g @anthropic-ai/sandbox-runtime` inside it |

`git`, `bwrap` (0.11.1) and unprivileged user namespaces are already present. **Serva
installed nothing.**

## 13. Commit

`7226f97` — *serva: Phase 4 execution binding — the qualified boundary is the one that
runs*. Prior: `1da2227`, `83dcac4`, `09ce3f1`.

## 14. Remaining Critical / High defects

None Critical. Honest High-severity limits:

1. **The HARD path has never executed on this machine.** The chain is complete and
   exercised offline end to end; it has not been measured against a real sandbox runtime,
   because the guest lacks node and the engine. HARD remains a code path here, not an
   observed fact.
2. **The sandbox runtime's command line is read from `--help`, not from a contract.** If
   the flag surface differs from what Serva recognises, the boundary reports unavailable —
   fail-closed, but it means a version bump could block a working machine until Serva
   learns the new surface.
3. **macOS has no launcher.** Seatbelt is unimplemented; a macOS host refuses to execute.
4. **Two facts in the dispatch comparison are carried, not re-observed** (sandbox
   mechanism and version). Stated in §4 and in the code.
5. `wsl.exe` argument fidelity remains an assumption, not a load-bearing one: Q-A runs
   through the same path, so a transport that mangles arguments fails to qualify.

### Defects found and fixed while doing this

- **`which` is unreachable under `env -i`** — GNU `env` resolves against the emptied
  environment, so every binary probe reported MISSING. The live report showed
  `GUEST_BWRAP: MISS` beside a launcher printing `bubblewrap 0.11.1`. Replaced with
  `sh -c 'command -v'`; executables now resolve to an absolute guest path before running,
  which additionally refuses a `node` resolving under `/mnt/`.
- **A cold WSL2 distribution booted inside the first probe's own timeout**, failing it.
  The transport now warms once, untimed.
- **`compareVersions` returns 0 for anything unparseable**, so `'UNKNOWN' >= min` was true
  and `ENGINE_VERSION` passed for a version nobody had established.
- **An empty ChangeSet passed every check vacuously** and reached `acceptChange`, where
  only `git commit` stopped it. Now routed to rework.

## 15. Phase 5

**Not started.** No deployment, no remote push, no GitHub PR, no browser or Android
testing, no VS Code UI. Nothing was installed, enabled, rebooted or reconfigured. The
ChangeSet → stage → commit integration was not reopened.
