# Troubleshooting

## "This machine has not been qualified"

Expected on a new or restored machine. Run `serva machine doctor`, fix anything not READY,
then `serva engineering qualify`.

## The doctor says UNKNOWN

Serva could not measure it — usually because the Linux guest did not answer. That is
different from "missing", and telling you to install something you already have would be
worse than saying so. Fix the line above it first: the doctor orders them so the root cause
carries the real remedy.

## "Not signed in"

Run `claude` inside the guest and sign in with your Claude subscription. Serva never creates
an API key, and copying credentials from another machine is not supported.

## A gate says NOT_VERIFIED

There is no evidence either way — it means nobody checked, not that something failed. The
gate names what is missing. Absent evidence never passes, and that is the point.

## Serva is asking something it should know

Tell us. A question about a technical choice is a bug: Serva is supposed to decide those.
The question includes why Serva believed it could not, which is the part worth reading.

## Something changed outside Serva

The status says **Changed outside Serva**. Open it: review the difference, bring it in as a
change request, or discard it. Serva will not adopt it silently and will not delete it.

## Nothing happens when I open the folder

Serva activates only for folders containing a `.serva` store. Run `serva init` there, or
open the folder that has one.

## The panel is blank or stale

**Serva: Refresh** re-opens the store and re-reads from disk. The panel never holds state of
its own — everything on it came from the store when it was drawn.

## Where to look next

```
serva doctor
```

Application integrity, store health, catalogues, git, the engine, machine qualification,
backup health and known blockers — in one place, each with what to do about it.
