# Getting started

## What you need

Serva runs on Windows and does its engineering work inside a Linux guest, under a sandbox.
You need:

- **Windows with WSL2** — `wsl --install` in an administrator terminal, then restart.
- **A Linux distribution** — `wsl --install -d Ubuntu`. Set up a normal user; do not run as
  root.
- **Claude Code inside the guest**, signed in with your Claude subscription. Serva never
  creates an API key and never asks for one.
- **bubblewrap** inside the guest — `sudo apt install bubblewrap`. This is what contains
  the code-writing agent.
- **Git.**

## Install Serva

Serva is delivered as two files. You do not need a copy of the source, and there is nothing
to compile.

- `serva-code-1.0.1.tgz` — the runtime and the `serva` command
- `serva-code-1.0.1.vsix` — the VS Code extension

### Check what you downloaded first

`release-manifest.json` and `SHA256SUMS` ship beside them. A file that was truncated or
altered in transit installs exactly as convincingly as one that was not, so check it before
you trust it:

```
Get-FileHash serva-code-1.0.1.tgz -Algorithm SHA256
```

Compare the result with the line for that file in `SHA256SUMS`. If they differ, download it
again rather than installing it.

### The runtime

```
npm install -g serva-code-1.0.1.tgz
```

That puts `serva` on your PATH. Open a new terminal — in any folder, not a special one — and
check:

```
serva --version
```

Then tell Serva it is installed, so it can offer you a way back if a later version turns out
to be worse:

```
serva install adopt
```

This records the version you are running under `~/.serva-code`. Serva downloads nothing; it
only writes down what you installed. `serva install status` shows what is there, and once you
have more than one version, `serva install use <version>` moves between them — refusing the
move if it would strand a project written by a newer build.

### The extension

In VS Code: **Extensions → ... → Install from VSIX**, and choose the `.vsix` file. Or from a
terminal:

```
code --install-extension serva-code-1.0.1.vsix
```

The extension carries everything it needs and does not require the runtime install above to
be present, though you will want both.

## Check the machine

```
serva machine doctor
```

It inspects, and repairs nothing. Every line is a measurement, and anything that is not
READY comes with the exact next step. A line that says UNKNOWN means Serva could not
measure it — different from "missing", and it will say which.

## Qualify the machine

Prerequisites being present is not the same as being measured. Before Serva will let an
agent write code on this computer, it runs an adversarial qualification and records what it
found:

```
serva engineering qualify
```

Until that passes Serva still works — it will plan, research, specify and design — but it
will not run write-capable engineering. That is not caution for its own sake: a
code-writing agent outside a measured sandbox is a code-writing agent with your whole
machine.

## In VS Code

Open a project folder. Serva activates when the folder
contains a `.serva` store, shows the state in the status bar, and opens the Control Center
when you click it. Opening a folder never starts work and never spends anything.
