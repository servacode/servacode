# ADR-002 — AI Engine Integration

**Status:** ACCEPTED
**Date:** 2026-08-21
**Decides:** How Serva Code invokes an AI execution engine (`19` §1.1, `33` §5, `SC-POL-035`).
**Supersedes:** nothing. **Superseded by:** nothing.
**Decision class:** TECHNOLOGY (`09` §2) — engineering authority, not owner authority.

---

## 1. Context

`19` §1 fixes the position of the engine: it is a **subordinate capability** invoked
under a role, with a constructed context, a restricted toolset and a required output
schema. It never talks to the store. Phase 3 must make that real without letting the
engine become the governing application.

Three constraints shape the choice, and two of them are owner constraints rather than
engineering ones:

- **C-1 (owner).** Serva Code is a personal, local tool used only by its owner, who
  already has an authenticated paid Claude environment. Serva must use that where
  officially supported.
- **C-2 (owner, and `SC-POL-035`).** No silent switch to a separately billed route.
  No API account creation, no key prompt, no automatic login, no token extraction.
- **C-3 (`19` §1.1).** Serva Code must not depend on behaviour outside the
  `EngineAdapter` interface. Changing engines must be a decision, not a rewrite.

---

## 2. Capability research

Conducted 2026-08-21 against the locally installed CLI and current official
documentation. Local probe:

```
$ claude --version
2.1.218 (Claude Code)

$ claude auth status          # read-only; --json is the default
{ "loggedIn": true, "authMethod": "claude.ai", "apiProvider": "firstParty",
  "subscriptionType": "max", ... }
```

Sources consulted (retrieved 2026-08-21):

| Source | What it settled |
|---|---|
| `claude --help`, `claude auth status --help` (v2.1.218, local) | The exact flag surface this machine has |
| https://code.claude.com/docs/en/headless | `-p`, `--output-format json\|stream-json`, `--json-schema` → `structured_output`, `system/init` `capabilities`, `system/api_retry`, SIGTERM → exit 143, `--bare` auth behaviour |
| https://code.claude.com/docs/en/cli-reference | `--tools ""`, `--safe-mode` vs `--bare`, `--disallowedTools "*"`, `--max-turns`, `--session-id`, `--no-session-persistence`, `--strict-mcp-config`, `--setting-sources` |
| https://code.claude.com/docs/en/permission-modes | `dontAsk` semantics; `-p` starting mode; actions no mode auto-approves |
| https://code.claude.com/docs/en/agent-sdk/overview | The SDK's third-party authentication restriction |

### 2.1 Findings that decided the transport

**F-1 — The Agent SDK is not available to us on the owner's billing route.** The SDK
overview states: *"Unless previously approved, Anthropic does not allow third party
developers to offer claude.ai login or rate limits for their products, including
agents built on the Claude Agent SDK. Use the API key authentication methods
described in the Quickstart instead."* Adopting the SDK therefore means adopting an
API key, which C-2 forbids.

**F-2 — `--bare` is disqualified for the same reason.** The headless documentation is
explicit: *"Set `ANTHROPIC_API_KEY` before running it, because bare mode doesn't use
your subscription login"* and *"In bare mode, Claude Code never reads OAuth
credentials or the system keychain."* `--bare` is the recommended mode for scripted
calls in general, and it is the wrong mode for **this** owner, because it changes the
billing route. This is the single most consequential finding of the research: the
generally-recommended answer is the one C-2 rules out.

**F-3 — `--safe-mode` gives the isolation without the billing change.** The CLI
reference: *"Start with all customizations disabled … CLAUDE.md, skills, plugins,
hooks, MCP servers, custom commands and agents, output styles, workflows, custom
themes, custom keybindings, status line and file-suggestion commands, LSP servers,
and auto memory do not load. Authentication, model selection, built-in tools, and
permissions work normally, **which differs from `--bare`**."* That last clause is
exactly the property `19` §4 needs (context is built, never inherited) combined with
the property C-1 needs (the owner's existing login keeps working).

**F-4 — Ambient configuration is a live risk without it.** Under `-p`, and *without*
`--safe-mode` or `--bare`, Claude Code runs the hooks in a project's
`.claude/settings.json` and connects the servers in its `.mcp.json` **even in a
folder never trusted**, because a `-p` session shows no trust dialog. A governed
AgentRun that inherited those would be governed by the repository, not by Serva.

**F-5 — `dontAsk` is the fail-closed non-interactive permission mode.** *"Claude Code
auto-denies every tool call that would otherwise prompt you … the session never waits
for input."* For `-p` the built-in starting mode is Manual, which can wait; so the
mode must be passed explicitly. `dontAsk` still permits the read-only Bash command
set, so it is necessary but not sufficient — tool restriction must also be explicit.

**F-6 — Structured output is first-class.** `--output-format json --json-schema
'<schema>'` returns the validated object in the `structured_output` field alongside
`session_id` and usage metadata. Invalid schemas are rejected at startup rather than
silently ignored (v2.1.205+).

**F-7 — Cost figures are client-side estimates.** `total_cost_usd` and the per-model
breakdown are *"client-side estimates"* that *"can differ from your actual bill"*. On
a subscription route they do not describe what the owner is charged.

---

## 3. Decision

**Transport: the locally installed Claude Code CLI, invoked as a child process with an
argument array, behind `ClaudeCliEngineAdapter`.**

The engine-facing invocation for a governed run is:

```
claude --print
       --output-format stream-json --verbose      # observable tool calls + usage
       --json-schema <contract output schema>     # contractual structured output
       --system-prompt <Serva-composed>           # full replacement, not an append
       --session-id <fresh uuid per run>          # 19 SM-1..SM-5
       --no-session-persistence                   # sessions are disposable
       --safe-mode                                # F-3: isolation, auth preserved
       --strict-mcp-config                        # no MCP, since none is passed
       --setting-sources ''                       # no user/project/local settings
       --disable-slash-commands
       --permission-mode dontAsk                  # F-5: fail closed, never waits
       --tools <resolved allowlist, '' for none>  # 19 TR-1
       --disallowedTools <explicit denies>        # defence in depth
       --max-turns <budget>
```

with the prompt delivered on **stdin**, `cwd` set to the project root, and a
runtime-enforced wall-clock deadline (SIGTERM, then SIGKILL).

### 3.1 Rejected alternatives

| Option | Why rejected |
|---|---|
| **Claude Agent SDK (TypeScript)** | F-1: requires API-key auth for third-party products, violating C-2. Also adds a dependency and an agent loop Serva must not delegate to (`19` §10) |
| **Anthropic Messages API directly** | Requires an API key and an API account. C-2 forbids both. Would also mean reimplementing the tool loop Serva explicitly does not want to own yet |
| **`claude --bare`** | F-2: never reads OAuth; would silently move the owner to a separately billed route |
| **`claude -p` with no isolation flags** | F-4: the repository's hooks and MCP servers would govern the run |
| **Reusing one long-lived session** | `19` SM-1..SM-5 forbid it, and it recreates exactly the fragility `SC-POL-020` exists to prevent |

### 3.2 Consequences accepted

- Serva depends on a **local CLI binary and its flag surface**. Mitigated by the
  capability probe (`19` §7, last row: *"Engine version/behavior changes underneath →
  capability probe on session start"*), which records the version and the detected
  capability set on every run, and by keeping every provider-specific string inside
  the adapter boundary.
- `--safe-mode` disables **skills**, which the owner may otherwise rely on
  interactively. That is correct for a governed run: a skill is ambient instruction,
  and `19` §4 says context is constructed.
- Cost is reported as `UNKNOWN` on a subscription route (F-7). Serva records the
  provider's estimate as an *estimate*, clearly labelled, and never as the owner's
  bill.
- The adapter cannot observe a tool denial the CLI makes internally unless it appears
  in the stream. Where a denial is not observable, Serva records what it *granted*
  (`CAPABILITY_BOUND`) rather than claiming a denial it did not see.

---

## 4. Authentication and billing route

Serva **reads** authentication state and never manages it.

- Probe uses `claude auth status --json`, a read-only command.
- Serva never runs `claude auth login`, never runs `claude setup-token`, never
  prompts for a key, and never reads, copies, stores or logs a credential value.
- The probe persists only: provider, transport, version, `authenticated`,
  `authenticationKind`, `billingMode`, capability flags and `checkedAt`. The
  `email`, `orgId` and `orgName` fields the CLI returns are deliberately **discarded**
  — they are identity, and the probe record has no need of them.
- Billing route is **derived, not guessed**:

  | Signal | `billingMode` |
  |---|---|
  | `authMethod: "claude.ai"` + a `subscriptionType` | `SUBSCRIPTION` |
  | `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` set, or `authMethod` names an API key | `API_KEY` |
  | Bedrock / Vertex / Foundry environment detected | `THIRD_PARTY_CLOUD` |
  | Anything else | `UNKNOWN` |

- **No silent fallback.** If the detected route is not the one the project is
  configured to accept, Serva refuses to dispatch and says so. The owner may later
  configure a different route explicitly; Phase 3 introduces no automatic path to one.

---

## 5. Why the Core stays agnostic

`EngineAdapter` (`19` §1.1) is the whole contract: `health()`, `capabilities()`,
`estimate()`, `invoke()`. Everything provider-specific — flag names, stream shapes,
`auth status` parsing, exit codes — lives under `src/engine/claude/`. Nothing outside
that directory imports it; the runtime is handed an adapter. `FakeEngineAdapter`
implements the same interface deterministically, which is what lets the entire
automated suite run with no model calls and no cost.

The test that this boundary is real: a grep for Claude-specific identifiers outside
`src/engine/claude/` must return nothing, and it is enforced as an automated test.
