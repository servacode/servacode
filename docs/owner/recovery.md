# Recovery

## Something was interrupted

Close VS Code mid-run, lose power, kill the terminal — Serva reconstructs where it was from
what is stored. It depends on no conversation, and reopening does not repeat work that
already completed or ask you again something you already answered.

If an operation ended in a state Serva cannot establish, it says **Recovery required** and
stops. It will not retry, because retrying something that may have half-happened is how one
problem becomes two. Open Recovery and it will show what completed, what did not, and
whether retrying is safe.

## The store is damaged

```
serva doctor
```

Serva verifies its own records against their digests on every read. Anything that does not
match is quarantined rather than used, and reported. Restore from your last verified backup.

## The backup is damaged

`serva verify-backup` names the files, not just the fact that something is wrong. A backup
that does not verify will not restore — Serva refuses rather than restoring most of it,
because "most of a project" is not a thing anybody can act on. You would not know which
part was missing.

## Something cannot be recovered

Serva says **UNKNOWN** or **NOT VERIFIED** and names it. It does not reconstruct project
truth by inference.

A guessed requirement is worse than a missing one: a missing one gets noticed, and a
guessed one gets built.

## After any recovery

Run `serva machine doctor`. A recovered project on a machine that has not been measured is
read-only until it is, and that is the correct order to find out.
