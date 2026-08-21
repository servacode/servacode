import { fail } from '../core/errors.js';
import type { AgentContract } from './schema.js';
import type { ToolPolicy } from '../engine/types.js';

/**
 * AgentContract -> ToolPolicy. SPEC: 19 §5 (SC-POL-026), 32 §1.3, 33 §3.
 *
 * The whole point: **Serva computes the policy; the agent never requests one.** The
 * contract declares a tool surface in the notation of 32 §1.3, and this module turns
 * that declaration into a concrete capability grant. An agent has no input into this
 * function beyond being the agent it is.
 *
 * Phase 3 additionally enforces a hard ceiling. Producer roles with write or exec
 * authority are present in the registry — all 55 load — but cannot be dispatched,
 * because the substrate that would make their write scope enforceable at call time
 * (33 §2–§3, 19 TR-6) is the Engineering Factory's work, not Phase 3's. Granting a
 * write tool whose scope Serva cannot enforce would be an L3 boundary presented as an
 * L1 one, which is precisely the misrepresentation 33 PC-5 forbids.
 */

/** Engine tool names Phase 3 will not grant to any agent, under any contract. */
export const PHASE3_FORBIDDEN_TOOLS: readonly string[] = Object.freeze([
  'Edit',
  'Write',
  'NotebookEdit',
  'Bash',
  'PowerShell',
  'Agent',
  'Task',
  'WebFetch',
  'WebSearch',
  'Monitor',
  'CronCreate',
  'CronDelete',
  'SendMessage',
  'Artifact',
]);

/** The read-only engine tools Phase 3 may grant, and nothing else. */
export const PHASE3_READ_TOOLS: readonly string[] = Object.freeze(['Read', 'Glob', 'Grep']);

/** Deny patterns always sent, so a tool absent from the allowlist is doubly excluded. */
export const ALWAYS_DENY: readonly string[] = Object.freeze(['mcp__*', ...PHASE3_FORBIDDEN_TOOLS]);

export const CapabilityLevel = {
  /** No tools at all. Valid, and the Phase 3 default (19 IV-5). */
  NO_TOOLS: 'NO_TOOLS',
  /** Read-only filesystem inspection within the project root. */
  READ_ONLY: 'READ_ONLY',
  /** Requires write/exec authority Phase 3 does not enable. */
  NOT_ENABLED: 'NOT_ENABLED',
} as const;
export type CapabilityLevel = (typeof CapabilityLevel)[keyof typeof CapabilityLevel];

export interface ParsedToolSurface {
  readonly storeRead: readonly string[];
  readonly storeWrite: readonly string[];
  readonly fsRead: boolean;
  readonly fsWrite: boolean;
  readonly exec: boolean;
  readonly net: boolean;
}

/**
 * Does `<verb> = ...` in a filesystem-scope string grant anything?
 *
 * Written as two positive tests rather than one negative lookahead: `\s*(?!none)`
 * looks correct and is not, because the regex engine backtracks `\s*` to empty and the
 * lookahead then passes against the space. That flaw reads as a grant where the
 * contract says NONE -- the one direction a capability check must never fail in.
 */
function grants(verb: 'read' | 'write', scope: string): boolean {
  // Literal regexes, not RegExp(string): a string-built pattern needs doubled
  // backslashes and silently degrades to a different pattern if one is lost.
  const mentioned = verb === 'read' ? /read\s*=/ : /write\s*=/;
  const none = verb === 'read' ? /read\s*=\s*none\b/ : /write\s*=\s*none\b/;
  if (!mentioned.test(scope)) return false;
  return !none.test(scope);
}

/** Parse the 32 §1.3 tool notation. Unrecognised entries are reported, never ignored. */
export function parseToolSurface(contract: AgentContract): ParsedToolSurface {
  const t = contract.tools;
  const capture = (verb: string): string[] => {
    const out: string[] = [];
    for (const m of t.matchAll(new RegExp(verb.replace('.', '\\.') + '\\(([^)]*)\\)', 'g'))) {
      for (const part of (m[1] ?? '').split(',')) {
        const v = part.trim();
        if (v.length > 0) out.push(v);
      }
    }
    return out;
  };
  const fsScope = contract.filesystemScope.toLowerCase();
  return {
    storeRead: capture('store.read'),
    storeWrite: capture('store.write'),
    fsRead: /fs\.read\(/.test(t) || grants('read', fsScope),
    fsWrite: /fs\.write\(/.test(t) || grants('write', fsScope),
    exec: /\bexec\(/.test(t),
    net: contract.networkScope.toUpperCase() !== 'NONE',
  };
}

/**
 * The capability level Phase 3 can actually enforce for this contract.
 *
 * Note what makes an agent NOT_ENABLED: needing a capability whose *scope* Serva
 * cannot police at call time. Network is included because 19 §5.1 scopes it to
 * declared hosts and the CLI transport gives Serva no per-host mediation.
 */
export function capabilityLevelFor(contract: AgentContract): CapabilityLevel {
  const s = parseToolSurface(contract);
  if (s.fsWrite || s.exec || s.net) return CapabilityLevel.NOT_ENABLED;
  return s.fsRead ? CapabilityLevel.READ_ONLY : CapabilityLevel.NO_TOOLS;
}

export interface ResolveOptions {
  /** Agents the project has explicitly enabled for execution (§22 of the Phase 3 brief). */
  readonly enabled: ReadonlySet<string>;
  readonly projectRoot: string;
}

/**
 * Resolve the runtime capability grant for one agent.
 *
 * Throws `E_CAPABILITY_NOT_ENABLED` rather than silently degrading to a smaller grant:
 * an agent that needs to write and is given read-only will produce a plausible report
 * about work it never did, which is worse than a refusal.
 */
export function resolveToolPolicy(contract: AgentContract, opts: ResolveOptions): ToolPolicy {
  const level = capabilityLevelFor(contract);
  const surface = parseToolSurface(contract);

  if (!opts.enabled.has(contract.id)) {
    return fail({
      code: 'E_CAPABILITY_NOT_ENABLED',
      message: 'Agent ' + contract.id + ' (' + contract.name + ') is not enabled for execution',
      remedy:
        'Phase 3 enables a narrow non-destructive agent set. Enabling this agent is a scope decision, not a configuration tweak.',
      details: { agentId: contract.id, capabilityLevel: level },
      specRef: '19 §5, 33 PC-5',
    });
  }

  if (level === CapabilityLevel.NOT_ENABLED) {
    return fail({
      code: 'E_CAPABILITY_NOT_ENABLED',
      message:
        'Agent ' +
        contract.id +
        ' requires capability Serva cannot yet enforce at call time: ' +
        [
          surface.fsWrite ? 'filesystem write' : '',
          surface.exec ? 'command execution' : '',
          surface.net ? 'network' : '',
        ]
          .filter((s) => s.length > 0)
          .join(', '),
      remedy:
        'Write, execute and network scopes are enforceable only on the isolation substrate the Engineering Factory phase introduces (33 §2-§3). Until then this agent loads but does not run.',
      details: {
        agentId: contract.id,
        tools: contract.tools,
        filesystemScope: contract.filesystemScope,
        networkScope: contract.networkScope,
      },
      specRef: '19 TR-1, TR-6, 33 PC-5',
    });
  }

  const allow = level === CapabilityLevel.READ_ONLY ? [...PHASE3_READ_TOOLS] : [];
  const rationale = [
    'contract tool surface: ' + contract.tools,
    'filesystem scope: ' + contract.filesystemScope,
    'network scope: ' + contract.networkScope,
    'resolved capability level: ' + level,
    allow.length === 0
      ? 'no tools granted; an empty allowlist is a valid grant (19 IV-5)'
      : 'granted read-only tools: ' + allow.join(', '),
    'store access is never granted to the engine: the engine never talks to the store (19 §1)',
  ];

  return {
    allow,
    deny: [...ALWAYS_DENY],
    filesystem: {
      read: level === CapabilityLevel.READ_ONLY ? [opts.projectRoot] : [],
      write: [],
    },
    network: 'NONE',
    maxToolCalls: level === CapabilityLevel.READ_ONLY ? 40 : 0,
    rationale,
  };
}

/**
 * An agent must never be able to widen its own grant. This is the assertion that
 * makes that checkable: the policy handed to the engine is compared against the one
 * Serva computed, and any addition is an isolation failure.
 */
export function assertPolicyNotWidened(computed: ToolPolicy, used: ToolPolicy): void {
  const allowed = new Set(computed.allow);
  const extra = used.allow.filter((t) => !allowed.has(t));
  if (extra.length > 0) {
    fail({
      code: 'E_ISOLATION',
      message: 'Tool policy was widened after resolution: ' + extra.join(', '),
      remedy:
        'ToolPolicy is computed by Serva from the contract. Nothing downstream may add to it (SC-POL-026).',
      details: { computed: computed.allow, used: used.allow, extra },
      specRef: '19 §5',
    });
  }
  if (used.network !== 'NONE' && computed.network === 'NONE') {
    fail({
      code: 'E_ISOLATION',
      message: 'Network access was added to a policy that granted none',
      remedy: 'Network scope comes from the contract and defaults to NONE (32 §2).',
      details: { used: used.network },
      specRef: '19 §5.1',
    });
  }
  const w = used.filesystem.write.filter((p) => !computed.filesystem.write.includes(p));
  if (w.length > 0) {
    fail({
      code: 'E_ISOLATION',
      message: 'Filesystem write scope was widened: ' + w.join(', '),
      remedy: 'Write scope is the task boundary and is set by Serva (19 TR-6).',
      details: { extra: w },
      specRef: '19 TR-6',
    });
  }
}
