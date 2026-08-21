/**
 * Incremental parser for Claude Code's `--output-format stream-json`.
 *
 * SPEC: 19 §5 (capture tool calls), 19 §7 (engine failure handling), 22.
 *
 * Two properties this module exists to guarantee:
 *
 *   1. **Partial chunks are normal.** A child process delivers bytes, not lines. A
 *      JSON object can and will be split across two `data` events, so the parser
 *      buffers and only interprets complete lines.
 *   2. **Malformed data never disappears and never crashes.** An unparseable line is
 *      recorded as a diagnostic and the stream continues. Silently dropping it would
 *      hide exactly the provider-behaviour change 19 §7 says to detect, and throwing
 *      would turn a cosmetic output glitch into a failed governed run.
 *
 * The parser understands only what Serva needs: init metadata, tool use, tool results,
 * usage, retries and the terminal result. Anything else is counted and ignored, which
 * is what lets a provider add message types without breaking a governed run.
 */

export interface StreamToolUse {
  readonly kind: 'tool_use';
  readonly name: string;
  readonly id: string;
}
export interface StreamToolResult {
  readonly kind: 'tool_result';
  readonly forId: string;
  readonly isError: boolean;
  /** A short excerpt only; full tool output is not part of the governance record. */
  readonly excerpt: string;
}
export interface StreamInit {
  readonly kind: 'init';
  readonly sessionId?: string;
  readonly model?: string;
  readonly tools: readonly string[];
  readonly mcpServers: readonly string[];
  readonly declaredCapabilities: readonly string[];
  readonly slashCommands: readonly string[];
}
export interface StreamRetry {
  readonly kind: 'retry';
  readonly attempt: number;
  readonly error: string;
  readonly status?: number;
}
export interface StreamResult {
  readonly kind: 'result';
  readonly isError: boolean;
  readonly subtype?: string;
  readonly sessionId?: string;
  readonly text?: string;
  readonly structuredOutput?: unknown;
  readonly numTurns?: number;
  readonly durationMs?: number;
  readonly totalCostUsd?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}
export interface StreamUnparseable {
  readonly kind: 'unparseable';
  readonly line: string;
  readonly reason: string;
}

export type StreamEvent =
  StreamInit | StreamToolUse | StreamToolResult | StreamRetry | StreamResult | StreamUnparseable;

/** Longest single line accepted. A runaway line is truncated, reported, and skipped. */
const MAX_LINE = 4 * 1024 * 1024;
const EXCERPT = 400;

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
function obj(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}
function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/** Names out of `mcp_servers`/`plugins` arrays, which hold objects with a `name`. */
function namesOf(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((e) => (typeof e === 'string' ? e : str(obj(e)?.['name'])))
    .filter((n): n is string => n !== undefined);
}

export class StreamParser {
  private buffer = '';
  private overlong = false;

  /** Feed a chunk; returns the events completed by it. Safe to call with '' . */
  push(chunk: string): StreamEvent[] {
    this.buffer += chunk;
    const events: StreamEvent[] = [];
    for (;;) {
      const nl = this.buffer.indexOf('\n');
      if (nl < 0) break;
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (this.overlong) {
        // We already reported the truncation; discard the tail of that line.
        this.overlong = false;
        continue;
      }
      const ev = this.parseLine(line);
      if (ev !== undefined) events.push(...ev);
    }
    if (this.buffer.length > MAX_LINE) {
      const kept = this.buffer.slice(0, EXCERPT);
      this.buffer = '';
      this.overlong = true;
      events.push({
        kind: 'unparseable',
        line: kept,
        reason: 'line exceeded ' + String(MAX_LINE) + ' bytes and was discarded',
      });
    }
    return events;
  }

  /**
   * Flush at end of stream. A trailing line without a newline is still a message;
   * dropping it would lose the `result` event on a provider that omits the final
   * newline.
   */
  end(): StreamEvent[] {
    const rest = this.buffer;
    this.buffer = '';
    if (rest.trim().length === 0) return [];
    return this.parseLine(rest) ?? [];
  }

  private parseLine(line: string): StreamEvent[] | undefined {
    const t = line.trim();
    if (t.length === 0) return undefined;
    let raw: unknown;
    try {
      raw = JSON.parse(t);
    } catch (e) {
      return [
        {
          kind: 'unparseable',
          line: t.slice(0, EXCERPT),
          reason: e instanceof Error ? e.message : 'not JSON',
        },
      ];
    }
    const o = obj(raw);
    if (o === undefined) {
      return [{ kind: 'unparseable', line: t.slice(0, EXCERPT), reason: 'not a JSON object' }];
    }
    return interpret(o);
  }
}

export function interpret(o: Record<string, unknown>): StreamEvent[] {
  const type = str(o['type']);
  const subtype = str(o['subtype']);

  if (type === 'system' && subtype === 'init') {
    return [
      {
        kind: 'init',
        ...(str(o['session_id']) === undefined ? {} : { sessionId: str(o['session_id'])! }),
        ...(str(o['model']) === undefined ? {} : { model: str(o['model'])! }),
        tools: strArray(o['tools']),
        mcpServers: namesOf(o['mcp_servers']),
        declaredCapabilities: strArray(o['capabilities']),
        slashCommands: strArray(o['slash_commands']),
      },
    ];
  }

  if (type === 'system' && subtype === 'api_retry') {
    return [
      {
        kind: 'retry',
        attempt: num(o['attempt']) ?? 0,
        error: str(o['error']) ?? 'unknown',
        ...(num(o['error_status']) === undefined ? {} : { status: num(o['error_status'])! }),
      },
    ];
  }

  if (type === 'result') {
    const usage = obj(o['usage']);
    return [
      {
        kind: 'result',
        isError: o['is_error'] === true,
        ...(subtype === undefined ? {} : { subtype }),
        ...(str(o['session_id']) === undefined ? {} : { sessionId: str(o['session_id'])! }),
        ...(str(o['result']) === undefined ? {} : { text: str(o['result'])! }),
        ...(o['structured_output'] === undefined
          ? {}
          : { structuredOutput: o['structured_output'] }),
        ...(num(o['num_turns']) === undefined ? {} : { numTurns: num(o['num_turns'])! }),
        ...(num(o['duration_ms']) === undefined ? {} : { durationMs: num(o['duration_ms'])! }),
        ...(num(o['total_cost_usd']) === undefined
          ? {}
          : { totalCostUsd: num(o['total_cost_usd'])! }),
        ...(num(usage?.['input_tokens']) === undefined
          ? {}
          : { inputTokens: num(usage?.['input_tokens'])! }),
        ...(num(usage?.['output_tokens']) === undefined
          ? {}
          : { outputTokens: num(usage?.['output_tokens'])! }),
      },
    ];
  }

  // assistant / user messages carry the tool_use and tool_result blocks.
  const message = obj(o['message']);
  const content = message?.['content'];
  if (!Array.isArray(content)) return [];

  const out: StreamEvent[] = [];
  for (const block of content) {
    const b = obj(block);
    if (b === undefined) continue;
    const bt = str(b['type']);
    if (bt === 'tool_use') {
      out.push({ kind: 'tool_use', name: str(b['name']) ?? 'UNKNOWN', id: str(b['id']) ?? '' });
    } else if (bt === 'tool_result') {
      const c = b['content'];
      const excerpt =
        typeof c === 'string' ? c.slice(0, EXCERPT) : JSON.stringify(c ?? null).slice(0, EXCERPT);
      out.push({
        kind: 'tool_result',
        forId: str(b['tool_use_id']) ?? '',
        isError: b['is_error'] === true,
        excerpt,
      });
    }
  }
  return out;
}
