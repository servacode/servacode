# Serva Code — owner documentation

Serva Code is a private AI software company that runs on your computer. You describe what
you want built; governed departments do the work; nothing leaves this machine unless you
send it somewhere yourself.

These pages are for using it. The architecture, the specification and the phase reports
live in `docs/serva-code/` and in the reports at the repository root — you should never
need them to run a project.

| Page | Read it when |
|---|---|
| [Getting started](getting-started.md) | First time on this computer |
| [Starting a project](new-project.md) | You have an idea and want it built |
| [Working with Serva](working-with-serva.md) | Day to day |
| [Your decisions](owner-decisions.md) | Serva is waiting for you |
| [Engineering](engineering.md) | Code is being written |
| [Backups](backups.md) | Before you need one |
| [Moving to a new computer](moving-to-a-new-computer.md) | New machine, or a reinstall |
| [Recovery](recovery.md) | Something went wrong |
| [Security model](security-model.md) | You want to know what Serva can and cannot do |
| [Troubleshooting](troubleshooting.md) | Something is not working |

## The one thing worth knowing first

Serva refuses rather than guesses. When it has no evidence for something it says
**NOT VERIFIED** and stops — it does not assume the answer is fine. That is deliberate, it
is the reason it is worth trusting, and it is also why it will sometimes stop and ask you
something a less careful tool would have decided for itself.
