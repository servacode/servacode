# Moving to a new computer

```
serva migrate
```

prints this sequence and tells you what this machine still needs.

## On the old machine

```
serva backup --to <external drive> --confirm
serva verify-backup <that path>
```

It must say **verified**. If it does not, stop and take another one — do not carry a backup
you have not proved.

## On the new machine

1. Install Serva.
2. `serva restore <that path> --to <your projects folder>` — this only *inspects*. Read what
   it says, including what will not come back.
3. Re-run it with `--confirm`.
4. `serva machine doctor` — it lists what this computer still needs.
5. Sign in to Claude in the guest.
6. `serva engineering qualify`.

## What moves, and what does not

**Moves:** your project, its git history, every decision, every piece of evidence, every
gate result, the research and its verification.

**Does not move:**

- **Claude authentication.** Sign in on the new machine. Serva never copies credentials
  between computers, and never generates an API key to avoid the step.
- **Machine qualification.** The new machine starts UNQUALIFIED and must measure itself.

That second one is the one that matters. If HARD travelled with a backup, restoring would
be a way to inherit a security clearance from a computer that no longer exists — possibly
one with no sandbox installed at all. Serva would rather make you wait ten minutes.

## Restoring over something

Serva refuses to write over an existing project unless you say so explicitly, and when you
do it moves the previous contents aside rather than deleting them. If the destination holds
a *different* project it says so by name, because that is the mistake worth catching.
