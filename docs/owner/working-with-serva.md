# Working with Serva

You have a company, not a chatbot. This is what that means day to day.

## Asking for something

Open the Control Center (`Serva: Open Control Center`) and type what you want under **Ask
Serva**, in your own words. Or from a terminal:

```
serva route "add order tracking so a customer can see where their food is"
```

Serva records exactly what you typed, classifies it, asks for a plan, checks that plan itself,
and queues the departments that will do the work. What comes back is what the *company* did —
the class your request was given, the departments queued, or the point at which Serva stopped
and why.

You are not talking to a model. Nothing you type is handed to an unrestricted session, and
there is no reply written for you to read. If that sounds like a limitation, it is the same
limitation that makes the rest of this trustworthy: everything Serva tells you is derived from
something recorded, and you can go and look at it.

## Seeing where things are

```
serva status                       what state the project is in, and the next action
serva intelligence status          where the company has got to, and what is stopping it
serva intelligence readiness       every blocker, derived rather than declared
```

The Control Center shows the same things, plus the lifecycle stage by stage.

## When Serva stops

Serva stops rather than guessing. There are three reasons, and they read differently:

**A question only you can answer.** See [Owner decisions](owner-decisions.md).

**Something is not verified.** No evidence means not verified — never "probably fine". The
blocker names what is missing.

**The machine cannot do it.** Write-capable engineering needs a measured boundary on *this*
computer. `serva machine bootstrap` says what is missing and who has to fix it.

## Following the work

```
serva runs                 every governed run in this project
serva run <SC-RUN-...>     one run's event log
serva context <SC-RUN-...> exactly what that run was shown
```

That last one matters more than it looks. An agent's answer is only as good as what it was
given, and Serva keeps the exact context so you can check.

## What Serva will not do

It will not answer an owner decision for you. It will not mark its own work verified. It will
not run write-capable engineering on an unqualified machine. It will not carry a qualification
from one computer to another. None of these are settings.

## Where your work lives

Everything is in your project folder, under `.serva`. It is yours, it is on your disk, and
nothing leaves the machine except the requests Serva makes to the engine on your behalf.

See also: [Getting started](getting-started.md) · [Engineering](engineering.md) ·
[Backups](backups.md)
