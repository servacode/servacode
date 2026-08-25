import type { InvocationRequest } from '../types.js';

/**
 * Build the argument ARRAY for one governed `claude` invocation.
 *
 * SPEC: ADR-002 §3, 19 §5 (tool restriction), 19 §3 (session policy), 33 §5.
 *
 * Pure and synchronous so the exact command line is unit-testable without spawning
 * anything. Every value goes into its own array element and is never concatenated
 * into a shell string: there is no shell, so there is nothing for a request to
 * escape into. The prompt itself never appears in argv at all — it is written to
 * stdin — which keeps untrusted owner text out of the process arguments entirely.
 */

export const CLAUDE_BIN = 'claude';

/**
 * Flags that would defeat the governance boundary.
 *
 * Enforced by ABSENCE: `buildArgv` constructs its argv explicitly and never adds one of these,
 * and `ai.security.test.ts` proves it for every flag in the list. There is deliberately no
 * runtime filter — a filter would imply something upstream might legitimately ask for one.
 */
export const FORBIDDEN_FLAGS: readonly string[] = Object.freeze([
  '--dangerously-skip-permissions',
  '--allow-dangerously-skip-permissions',
  '--permission-mode=bypassPermissions',
  '--continue',
  '-c',
  '--resume',
  '-r',
  '--bare',
]);

export interface ArgvOptions {
  /** Emitted only when the probe reports the flag is supported by this version. */
  readonly supportsTurnLimit: boolean;
  readonly supportsAmbientConfigIsolation: boolean;
  /** The session identifier for this run. Derived by the adapter; see sessionUuidFor. */
  readonly sessionId: string;
  /**
   * Path to the file holding the composed system prompt.
   *
   * The prompt is NOT passed as an argument. Two reasons, both real:
   *
   *   1. Windows caps a process command line at about 32,767 characters, and a
   *      B-STANDARD context budget is 80,000. Passing the prompt inline would fail at
   *      spawn time for any bundle of realistic size -- on the owner's own platform.
   *   2. Arguments are visible to any process listing. A bundle contains repository
   *      excerpts and the owner's request; none of that belongs in `ps` output.
   */
  readonly systemPromptFile: string;
}

/**
 * The isolation set (ADR-002 §3, finding F-3/F-4).
 *
 * `--safe-mode` rather than `--bare`: bare mode never reads OAuth credentials and
 * requires ANTHROPIC_API_KEY, which would move the owner to a separately billed
 * route (SC-POL-035). Safe mode disables the same ambient configuration —
 * CLAUDE.md, skills, plugins, hooks, MCP servers, custom agents, auto memory —
 * while leaving authentication working normally.
 */
export const ISOLATION_ARGS: readonly string[] = Object.freeze([
  '--safe-mode',
  '--strict-mcp-config',
  '--setting-sources',
  '',
  '--disable-slash-commands',
  '--no-session-persistence',
]);

export function buildArgv(request: InvocationRequest, opts: ArgvOptions): string[] {
  const argv: string[] = ['--print'];

  // stream-json makes tool calls and usage observable; 19 TR-2 needs them recorded.
  argv.push('--output-format', 'stream-json', '--verbose');

  // 19 SO-1: every invocation declares an output schema.
  argv.push('--json-schema', JSON.stringify(request.outputSchema));

  // 19 §4: the context is constructed. --system-prompt-file REPLACES the default
  // prompt rather than appending to it, so nothing ambient survives into the role.
  // The file form keeps an 80KB bundle off a 32KB command line; see ArgvOptions.
  argv.push('--system-prompt-file', opts.systemPromptFile);

  // 19 SM-1..SM-5: a fresh session id per run, never resumed, never persisted.
  if (request.sessionPolicy === 'NEW') {
    argv.push('--session-id', opts.sessionId);
  } else {
    // CONTINUE exists only for an intra-run tool loop (19 §3). It is not reachable
    // from Phase 3's dispatcher, which always requests NEW.
    argv.push('--resume', request.sessionPolicy.continue);
  }

  if (opts.supportsAmbientConfigIsolation) argv.push(...ISOLATION_ARGS);

  /*
   * The sandbox profile for this run.
   *
   * Emitted AFTER the isolation args on purpose. `--setting-sources ''` disables every
   * ambient source; this names one file explicitly, so the only settings in force are
   * the ones Serva generated for this run. The two together are "nothing ambient, and
   * exactly this" — either alone would be wrong in a different direction.
   */
  if (request.settingsPath !== undefined) {
    argv.push('--settings', request.settingsPath);
  }

  // 19 §15 / ADR-002 F-5: fail closed, and never wait for a prompt that cannot come.
  argv.push('--permission-mode', 'dontAsk');

  /*
   * Availability and permission are TWO flags, and emitting only the first was a real
   * governance defect.
   *
   *   --tools           which tools exist in the model's toolset
   *   --allowedTools    which calls are PRE-APPROVED to execute
   *   --disallowedTools which calls are refused; deny outranks approve in every mode
   *
   * Under `dontAsk` every call that would otherwise prompt is auto-denied, so a tool
   * that is available but unapproved is a tool the model can see and cannot use.
   * Serva was recording those as granted. Now the argv carries the same grant Serva
   * recorded, which is the only way the trace can be true.
   *
   * 19 IV-5: an empty toolset is valid and means no tools at all.
   */
  argv.push('--tools', request.tools.available.join(','));
  if (request.tools.approve.length > 0) argv.push('--allowedTools', ...request.tools.approve);
  if (request.tools.deny.length > 0) argv.push('--disallowedTools', ...request.tools.deny);

  if (opts.supportsTurnLimit) argv.push('--max-turns', String(request.budget.maxTurns));
  if (request.model !== undefined) argv.push('--model', request.model);

  return argv;
}

/**
 * A run id is not a UUID, and `--session-id` requires one. Derive a stable v4-shaped
 * identifier from the run id so the mapping is reproducible from the trace and no
 * randomness enters the deterministic core.
 */
export function sessionUuidFor(runId: string, digest: (s: string) => string): string {
  const h = digest(runId);
  const hex = h
    .replace(/[^0-9a-f]/g, '')
    .padEnd(32, '0')
    .slice(0, 32);
  const variant = ((parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    '4' + hex.slice(13, 16),
    variant + hex.slice(17, 20),
    hex.slice(20, 32),
  ].join('-');
}
