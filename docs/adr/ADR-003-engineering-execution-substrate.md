# ADR-003 — Engineering Execution Substrate

**Status:** ACCEPTED
**Date:** 2026-08-21
**Decides:** On what substrate Serva may grant write and execute authority to a Producer agent (`33` §2–§3, `19` TR-1, `SC-POL-026`).
**Supersedes:** nothing. **Superseded by:** nothing.
**Decision class:** TECHNOLOGY, with a **CONSTITUTIONAL** boundary: the rule that HARD is earned rather than assumed is not an engineering convenience.

---

## 1. The problem Phase 4 creates

Phases 2 and 3 were safe by construction: the engine could read a little and write
nothing. Phase 4 asks for `Edit`, `Write` and `Bash` — the capability to change the
owner's code and run commands on their machine.

`33` PC-5 already says the enforcement class must be **detected and declared, never
assumed**. Phase 4 is where that stops being a formality. An agent granted `Bash`
under an unenforced boundary is not a governed agent; it is a shell.

The failure this ADR exists to prevent is specific and easy to commit: **granting the
capability because the provider exposes the tool.** Claude Code offers `Bash` on every
platform. That says nothing about whether anything can contain it.

---

## 2. Platform research

Conducted 2026-08-21. Sources (retrieved that day):

| Source | What it settled |
|---|---|
| https://code.claude.com/docs/en/sandboxing | Supported platforms, required packages, WSL2 host-escape mechanics, `failIfUnavailable`, `allowUnsandboxedCommands`, filesystem policy shape |
| https://code.claude.com/docs/en/settings (sandbox settings) | Path-prefix semantics, `denyRead`/`allowRead` precedence, `excludedCommands`, `allowAllUnixSockets` |
| Local probe of this host and of its WSL2 distribution | What is actually present here |

### 2.1 Findings

**F-1 — Native Windows has no sandbox.** Verbatim: *"The sandbox is built into Claude
Code and runs on macOS, Linux, and WSL2. **Native Windows is not supported.** On
Windows, run Claude Code inside a WSL2 distribution."*

The owner's host is Windows. This alone settles the question for the host: native
Windows can never be qualified HARD for engineering execution, because there is no
enforcement mechanism to qualify.

**F-2 — Linux and WSL2 need two packages.** `bubblewrap` enforces filesystem
isolation; `socat` relays network traffic through the sandbox proxy. Without them the
sandbox does not start.

**F-3 — WSL2 can reach the Windows host, and one optional package is what stops it.**
This is the most consequential finding, and it is the one that would be easiest to
miss. Verbatim:

> *"On WSL2, WSL hands a launch of a Windows binary such as `cmd.exe`,
> `powershell.exe`, or anything under `/mnt/c/` to the Windows host over a Unix
> socket, so whether a sandboxed command can launch one follows the sandbox's
> Unix-socket settings: **the optional seccomp filter has to be installed to block the
> socket in the first place.**"*

So a WSL2 sandbox **without** the seccomp filter (`@anthropic-ai/sandbox-runtime`) can
launch Windows host executables. The filesystem isolation is real and the host escape
is still open, because the escape does not go through the filesystem — it goes through
a socket. A substrate in that state must not be called HARD however well bubblewrap is
working.

**F-4 — Fail-closed is available and must be used.** By default a sandbox that cannot
start produces a warning and commands run **unsandboxed**. `sandbox.failIfUnavailable:
true` makes it a hard failure instead. Separately, a sandboxed command that fails can
be retried without the sandbox; `sandbox.allowUnsandboxedCommands: false` — "Strict
sandbox mode" — disables that escape hatch entirely and makes the
`dangerouslyDisableSandbox` parameter *completely ignored*.

Both are required. The first closes "the sandbox never started"; the second closes
"the sandbox started and then got out of the way".

**F-5 — Filesystem rules are OS-enforced and cover child processes.** *"These paths are
enforced at the OS level, so all commands running inside the sandbox, **including their
child processes**, respect them."* This is what makes the substrate categorically
different from Phase 3's `Read()`/`Edit()` permission rules, which govern only the
model's own tool calls and cannot constrain a `python` subprocess at all.

**F-6 — Ubuntu 24.04+ may block unprivileged user namespaces** via AppArmor, which
bubblewrap needs. Checked with
`sysctl kernel.apparmor_restrict_unprivileged_userns`.

### 2.2 This host, probed

Read-only probe. Nothing was installed, enabled, or reconfigured.

```
host            : win32 x64, Windows 11
claude (host)   : 2.1.218
WSL             : installed, default distribution Ubuntu, default version 2
WSL distro      : Ubuntu 26.04 LTS, kernel 6.6.114.1-microsoft-standard-WSL2
  git           : /usr/bin/git (2.53.0)
  bubblewrap    : /usr/bin/bwrap                     PRESENT
  python3       : /usr/bin/python3
  socat         : MISSING
  node          : MISSING
  claude        : MISSING
  npm           : /mnt/c/Program Files/nodejs/npm    ← the WINDOWS binary, via interop
  apparmor_restrict_unprivileged_userns : key absent (no restriction to lift)
WSL interop     : binfmt WSLInterop present and ENABLED
  /mnt/c/Windows/System32/cmd.exe                    executable from inside WSL
  /mnt/c/.../powershell.exe                          executable from inside WSL
```

The `npm` line is worth pausing on: inside WSL, `npm` resolves to the **Windows host
executable** through interop. That is not a curiosity, it is F-3 demonstrated on this
machine before any sandbox is involved.

---

## 3. Decision

### 3.1 Enforcement class is earned, never assumed

`ExecutionSubstrate` exposes `probe()`, `qualify()`, `capabilities()`, `execute()` and
`explain()`. `qualify()` runs adversarial tests against a disposable fixture workspace
and the class is derived from what they prove:

- **HARD** — every qualification test passed, including subprocess escape, symlink
  escape, host escape and the no-unsandboxed-retry check.
- **SOFT** — a boundary exists but is harness-level only: it constrains the model's
  tool calls and not arbitrary child processes.
- **NONE** — no enforceable boundary.

**Write and execute authority requires HARD.** There is no SOFT engineering mode. A
Producer that cannot be contained is not dispatched, and Serva says why.

`WSL2 = HARD` is explicitly **not** hard-coded. WSL2 is a *candidate*. F-3 is exactly
why: two WSL2 machines can differ on host escape by one optional package, and only a
test can tell them apart.

### 3.2 The sandbox profile Serva generates per run

```jsonc
{
  "sandbox": {
    "enabled": true,
    "failIfUnavailable": true,        // F-4: never silently unsandboxed
    "allowUnsandboxedCommands": false, // F-4: no retry escape hatch
    "excludedCommands": [],            // nothing runs outside the boundary
    "filesystem": {
      "allowWrite": ["<worktree>"],    // the isolated worktree, and nothing else
      "denyWrite": ["<project root>", "<.serva>", "~/"],
      "denyRead":  ["~/.ssh", "~/.aws", "~/.claude", "~/.config/gh", "<.serva>"],
      "allowRead": ["<worktree>", "<project root>"]
    },
    "network": { "enabled": false }
  }
}
```

Generated by Serva for that run and written to a Serva-owned settings file, never
inherited from ambient project or user configuration. Phase 3's isolation flags remain:
`--safe-mode`, `--setting-sources ''`, `--strict-mcp-config`, `--disable-slash-commands`.
`--dangerously-skip-permissions` and `bypassPermissions` remain on the forbidden list
asserted by test.

The factory records the **effective** profile it observed, not the profile it intended.

### 3.3 Qualification on this host: NONE

Running the qualification against this machine yields **NONE**, on two independent
grounds:

1. **The host itself is native Windows**, where the sandbox does not exist (F-1).
2. **The WSL2 candidate cannot be qualified**, because Claude Code is not installed
   inside it, and neither are `socat` nor the seccomp filter that F-3 identifies as the
   only thing standing between a sandboxed command and the Windows host.

Serva therefore reports `PLATFORM_PREREQUISITE_REQUIRED` and refuses to dispatch any
Producer. It does not fall back to SOFT.

### 3.4 What Serva will not do about it

Nothing is installed, enabled or reconfigured automatically. Not WSL features, not
`apt` packages, not npm globals, and no reboot. The prerequisites are reported with the
exact command that would satisfy each, and the decision to run them is the owner's.

The reasoning is not caution for its own sake. A system whose safety rests on a
sandbox should not be in the business of silently changing the machine that sandbox
runs on.

---

## 4. Prerequisites for HARD on this host

Owner-authorized, in a WSL2 distribution:

| # | Prerequisite | Why | Command |
|---|---|---|---|
| 1 | Claude Code inside WSL2 | The engine must run where the sandbox runs; the Windows install cannot be sandboxed (F-1) | install Claude Code inside the distribution |
| 2 | Node.js inside WSL2 | Required by the engine and by prerequisite 4; today `npm` resolves to the Windows binary through interop | install via the distribution's package manager or a version manager |
| 3 | `socat` | Required for the sandbox to start at all (F-2) | `sudo apt-get install socat` |
| 4 | `@anthropic-ai/sandbox-runtime` seccomp filter | **The only thing that blocks the Unix socket WSL uses to launch Windows binaries (F-3).** Without it, host escape is open | `npm install -g @anthropic-ai/sandbox-runtime` |
| 5 | `bubblewrap` | Filesystem isolation | already present |

Only after all five, and only if `qualify()` passes every adversarial test — including
the host-escape test that prerequisite 4 exists to satisfy — does this host become
HARD.

---

## 5. Consequences accepted

- **Phase 4 ships fully implemented and unable to run a live Producer on this
  machine.** That is the correct outcome, not a shortfall: the factory is complete, the
  substrate is not, and the two are deliberately separable. Every component is
  exercised offline against a deterministic fake substrate.
- **The qualification suite is itself a maintenance burden.** It has to be re-run when
  Claude Code changes, because F-3 is a version- and package-dependent behaviour. The
  substrate record therefore carries the engine version it was qualified against, and a
  qualification is not valid for a different one.
- **A qualified substrate is still not a guarantee.** It is a measurement, on one
  machine, at one moment, against the escapes we thought to try. `explain()` states
  what was tested so a reader can see the shape of what was not.
