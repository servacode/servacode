# Backups

Everything Serva knows lives on this computer. Take backups.

```
serva backup --to E:\serva-backups\rahalgo-2026-08
```

Without `--confirm` it prints what it would do and writes nothing. Add `--confirm` to write
it. In VS Code: **Serva: Create a verified backup**.

## What "verified" means

Serva writes the backup, then re-opens it, re-hashes every file and compares against the
manifest. Only then does it call it a backup.

A half-written backup that reported success would be worse than a failure, because you
would stop worrying about it.

You can check any backup at any time, and should before you rely on one:

```
serva verify-backup E:\serva-backups\rahalgo-2026-08
```

## What is in it

Your project's source, its git history, and everything Serva knows — decisions, evidence,
gate results, research and its verification, agent run records — plus the schema version
needed to read it on a future Serva.

## What is deliberately not in it

- **Credentials of any kind.** Claude authentication, API keys, tokens, `.env` files, SSH
  keys. Serva excludes them by name AND scans file contents, so a key pasted into a note is
  refused too. A backup gets copied to a USB stick; a secret inside one is a secret forever.
- **Machine qualification.** HARD describes a computer, not a project.
- **`node_modules`, build output, caches.** Reproducible, and large.

Everything left out is listed in the backup's own manifest with the reason. An omission
nobody recorded is indistinguishable from an oversight.

## Where to keep them

Somewhere that is not this disk. A backup on the drive that fails is not a backup.
