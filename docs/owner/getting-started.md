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

Install the Serva extension and open a project folder. Serva activates when the folder
contains a `.serva` store, shows the state in the status bar, and opens the Control Center
when you click it. Opening a folder never starts work and never spends anything.
