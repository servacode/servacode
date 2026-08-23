# Working with Serva

## The status

The status bar shows the truth about the project, derived from what is stored — never from
the fact that a panel loaded.

| It says | It means |
|---|---|
| **Active** | Running, nothing waiting |
| **Your decision needed** | Stopped on something only you can answer |
| **Blocked** | A gate refused, or a department could not proceed |
| **Engineering** | Code is being written under the sandbox |
| **Machine not qualified** | This computer has not been measured, so engineering cannot run |
| **Changed outside Serva** | Files changed that Serva did not change |
| **Recovery required** | Something ended in a state Serva cannot establish |

## From a terminal

```
serva overview          what the status bar shows
serva status            the lifecycle in detail
serva release           release readiness, condition by condition
serva actions           every action the interface can perform
```

The CLI and the VS Code panel call the same code. There is one company underneath, and a
state change made from a panel is the same change made from a terminal.

## If you edit code yourself

You can. It is your computer and your repository. Serva notices, marks those changes as
**ungoverned**, and offers you the choice: review the difference, bring it in as a change
request, or discard it. It will not adopt your work silently and it will not delete it.

## Asking why

Every decision is recorded with its reason, its evidence, the alternatives considered and
what would make Serva reconsider. Open one in the Control Center to see all of it.

What you will not see is a model's internal reasoning. That is not evidence, and Serva does
not keep it.
