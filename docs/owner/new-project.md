# Starting a project

```
serva init "RahalGo" --idea "A booking app for car rental agencies in Riyadh"
```

Or, in VS Code, **Serva: Open Control Center** and start one there.

## What Serva asks for

Only what you could tell someone over coffee:

- what the product is, and what problem it solves
- who it is for
- what success would look like
- anything already decided — a budget, a deadline, an existing system, a brand

## What Serva does not ask

It will not ask which database, which framework, which architecture, or what colour the
buttons should be. Those are its job. If it asks you something technical that is a bug —
except where you have told it a technical thing is a business constraint, in which case it
will honour it and record why.

## What happens next

Serva works through its lifecycle: it frames the request, researches the market where that
is possible, decides scope, writes requirements, designs the architecture and the
experience, plans the work, and only then writes code. Each stage ends at a gate, and a gate
with no evidence does not pass.

You will be asked things along the way. Every question arrives with what Serva recommends
and why — see [Your decisions](owner-decisions.md).

## An existing codebase

Point Serva at a folder that already has one. It reads what is there rather than assuming a
blank page, and anything it cannot establish from the code it will ask about rather than
invent.
