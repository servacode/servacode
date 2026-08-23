# Engineering

When Serva writes code it does it inside a Linux guest, inside a sandbox, in an isolated
copy of your repository. The agent writing the code cannot reach your Windows filesystem,
cannot reach the network, and cannot commit anything.

## What happens to a change

1. **A producer writes it** — sandboxed, in a worktree of its own.
2. **Deterministic checks run** — build, tests, lint, scope, secrets. These are
   measurements. No agent opinion overrides one: if the suite failed, the suite failed.
3. **An independent reviewer reads it** — never the actor that wrote it.
4. **The engineering gate decides**, from that evidence rather than from a summary of it.
5. **Only then is it committed**, and what is committed is what was verified, byte for byte.

## What you see

The Control Center shows the work item, what changed, which tests ran, what they proved and
which requirement they prove it for — grouped so it means something. "Tests: green" is not
a report.

Advanced mode adds run ids, the boundary fingerprint and raw output, for when you want them.

## HARD, and why it matters

**HARD** means Serva measured this computer's sandbox and it held. Until then engineering
stays read-only.

The measurement covers the distribution, the kernel, the guest user, the engine binary, the
sandbox mechanism and its settings. Change any of them and the qualification is invalidated
automatically — not because Serva is fussy, but because it no longer describes what would
contain a producer.

Windows interop is part of it too. A guest that can start Windows executables is a
different boundary from one that cannot, and re-enabling it because something was easier
that way invalidates the measurement.

A qualification never travels between machines. See
[Moving to a new computer](moving-to-a-new-computer.md).
