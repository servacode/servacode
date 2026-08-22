import { resolve } from 'node:path';
import { fail } from '../core/errors.js';
import type { AgentContract } from './schema.js';
import type { ToolPolicy } from '../engine/types.js';

/**
 * AgentContract -> ToolPolicy. SPEC: 19 §5 (SC-POL-026), 32 §1.3, 33 §3.
 *
 * Serva computes the policy; the agent never requests one.
 *
 * The correction this file carries: **availability is not permission.** Restricting
 * which tools exist in the model's toolset and pre-approving which calls may execute
 * are two different mechanisms, and a policy that recorded a tool as "allowed" while
 * emitting only the availability half was describing a grant the permission layer had
 * not actually made. Serva's record and the engine's behaviour have to be the same
 * fact, or the trace is fiction.
 *
 * The second correction: a contract's filesystem scope is prose, and prose is not an
 * enforceable path rule. It is translated through a CLOSED vocabulary. A scope this
 * module does not recognise fails closed — it is never widened into project-wide
 * authority, because widening is the direction that costs something.
 */

/** Engine tool names Phase 3 will not make available to any agent, under any contract. */
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

/** The read-only engine tools Phase 3 may make available, and nothing else. */
export const PHASE3_READ_TOOLS: readonly string[] = Object.freeze(['Read', 'Glob', 'Grep']);

/** Tool-level denials always emitted, so an unavailable tool is also unapproved. */
export const ALWAYS_DENY_TOOLS: readonly string[] = Object.freeze([
  'mcp__*',
  ...PHASE3_FORBIDDEN_TOOLS,
]);

/**
 * Serva's own store directory.
 *
 * Denied to every governed run, without exception. It holds the audit trail a run must
 * not be able to read or reason about, other runs' context bundles, and — while they
 * are in flight — the composed prompt files of every concurrent run. An agent able to
 * read `.serva` could read another run's instructions.
 */
export const SERVA_INTERNAL_DIR = '.serva';

export const CapabilityLevel = {
  /** No tools at all. Valid, and the Phase 3 default (19 IV-5). */
  NO_TOOLS: 'NO_TOOLS',
  /** Read-only inspection within a concretely resolved path scope. */
  READ_ONLY: 'READ_ONLY',
  /** Requires write/exec/network authority, or a scope Serva cannot express. */
  NOT_ENABLED: 'NOT_ENABLED',
} as const;
export type CapabilityLevel = (typeof CapabilityLevel)[keyof typeof CapabilityLevel];

export interface ParsedToolSurface {
  readonly storeRead: readonly string[];
  readonly storeWrite: readonly string[];
  readonly fsReadTerm: string | undefined;
  readonly fsWrite: boolean;
  readonly exec: boolean;
  readonly net: boolean;
}

/**
 * What does `read = ...` name, if anything?
 *
 * Written as positive tests rather than a negative lookahead: `\s*(?!none)` looks
 * correct and is not, because the engine backtracks `\s*` to empty and the lookahead
 * then passes against the space. That reads as a grant where the contract says NONE —
 * the one direction a capability check must never fail in.
 */
function readTerm(scope: string): string | undefined {
  const lowered = scope.toLowerCase().trim();
  if (lowered === 'none' || /^none\b/.test(lowered)) return undefined;
  const m = /read\s*=\s*([^;]+)/.exec(lowered);
  if (m === null) return undefined;
  const term = m[1]!.trim().replace(/\.$/, '');
  return term === 'none' || term.length === 0 ? undefined : term;
}

function grantsWrite(scope: string): boolean {
  const lowered = scope.toLowerCase();
  if (!/write\s*=/.test(lowered)) return false;
  return !/write\s*=\s*none\b/.test(lowered);
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
  const declaredFsRead = /fs\.read\(([^)]*)\)/.exec(t);
  return {
    storeRead: capture('store.read'),
    storeWrite: capture('store.write'),
    fsReadTerm:
      readTerm(contract.filesystemScope) ??
      (declaredFsRead === null ? undefined : declaredFsRead[1]?.trim()),
    fsWrite: /fs\.write\(/.test(t) || grantsWrite(contract.filesystemScope),
    exec: /\bexec\(/.test(t),
    /*
     * The LEADING TOKEN decides, not the whole string.
     *
     * `networkScope` is prose with a verdict at the front: SC-AGENT-063 reads
     * "NONE — it verifies against *captured* content, not by re-fetching". Comparing the
     * entire field to 'NONE' classified that as network-GRANTED — the one agent whose
     * whole purpose depends on being unable to fetch. A contract that explains itself
     * must not thereby acquire a capability it explicitly disclaims.
     */
    net: !/^\s*none\b/i.test(contract.networkScope),
  };
}

/* ------------------------------------------------- filesystem scope translation */

export interface ReadScope {
  /** Absolute roots the agent may read under. Empty means no filesystem grant. */
  readonly roots: readonly string[];
  /** Absolute subtrees refused even inside a granted root. */
  readonly denied: readonly string[];
  readonly basis: string;
}

/**
 * The CLOSED vocabulary of filesystem read scopes Serva can enforce.
 *
 * Every term maps to a concrete, checkable path set. A contract naming anything else
 * is not approximated — "read = release artifacts" has no mechanical meaning, and
 * guessing that it means the project root would hand an agent authority its contract
 * never granted.
 */
const KNOWN_READ_TERMS: Readonly<Record<string, 'PROJECT_TREE' | 'STORE_ONLY'>> = Object.freeze({
  workspace: 'PROJECT_TREE',
  'workspace tree': 'PROJECT_TREE',
  'workspace, metadata only': 'PROJECT_TREE',
  /*
   * "project metadata" is STORE-tier data, not a directory. 19 §1 is explicit that the
   * engine never talks to the store: Serva reads project metadata itself and puts it in
   * the context bundle. The correct translation is therefore NO filesystem grant — a
   * narrowing, and a mechanical one rather than a guess.
   */
  'project metadata': 'STORE_ONLY',
});

export function translateReadScope(
  term: string | undefined,
  projectRoot: string,
): ReadScope | undefined {
  if (term === undefined) {
    return { roots: [], denied: [], basis: 'contract grants no filesystem read' };
  }
  const normalized = term.toLowerCase().replace(/\s+/g, ' ').trim();
  const known = KNOWN_READ_TERMS[normalized];
  if (known === undefined) return undefined;
  if (known === 'STORE_ONLY') {
    return {
      roots: [],
      denied: [],
      basis:
        '"' +
        term +
        '" names store-tier data, which the engine never reads directly (19 §1); Serva supplies it in the context bundle instead',
    };
  }
  const root = resolve(projectRoot);
  return {
    roots: [root],
    denied: [resolve(root, SERVA_INTERNAL_DIR)],
    basis: '"' + term + '" resolves to the project tree, excluding Serva internals',
  };
}

/**
 * The capability level Phase 3 can actually enforce for this contract.
 *
 * NOT_ENABLED covers two distinct causes: a capability whose scope Serva cannot police
 * at call time (write, exec, network), or a read scope it cannot express as paths.
 */
export function capabilityLevelFor(contract: AgentContract, projectRoot = '.'): CapabilityLevel {
  const s = parseToolSurface(contract);
  if (s.fsWrite || s.exec || s.net) return CapabilityLevel.NOT_ENABLED;
  const scope = translateReadScope(s.fsReadTerm, projectRoot);
  if (scope === undefined) return CapabilityLevel.NOT_ENABLED;
  return scope.roots.length > 0 ? CapabilityLevel.READ_ONLY : CapabilityLevel.NO_TOOLS;
}

export interface ResolveOptions {
  /** Agents the project has explicitly enabled for execution. */
  readonly enabled: ReadonlySet<string>;
  readonly projectRoot: string;
  /** Extra absolute subtrees to refuse inside the granted root (per-run carve-outs). */
  readonly additionalDenied?: readonly string[];
}

/**
 * Build a permission rule scoped RELATIVE TO THE WORKING DIRECTORY.
 *
 * Absolute rules were the first attempt and they did not hold. The absolute anchor is
 * a POSIX form — `Read(//Users/alice/secrets/**)` — and a Windows path carries a drive
 * letter that does not survive it, so the deny rule silently matched nothing and a
 * governed run read a file it had been "refused". A live test caught it; no offline
 * test could have, because the rule string looked perfectly reasonable.
 *
 * The relative form is portable and precise here because Serva always runs the engine
 * with `cwd` set to the project root: a rule anchored at the current directory is a
 * rule anchored at the project. Per the rule syntax, a deny pattern with a single
 * directory segment matches that directory at any depth beneath the anchor, which is
 * exactly the containment `.serva` needs.
 */
export function relativeRule(tool: string, relativePath: string): string {
  const clean = relativePath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
  return tool + '(' + clean + ')';
}

/** Everything beneath the working directory. */
export const EVERYTHING_UNDER_CWD = '**';

/**
 * Build a permission rule anchored at an ABSOLUTE path in the execution environment.
 *
 * The counterpart to `relativeRule`, and both are needed. A cwd-relative rule governs
 * a relative request; a model that names the same file by its absolute path matches
 * neither the relative rule nor anything else, so under `dontAsk` the call is denied.
 * That is exactly how a reviewer with `Read(**)` came to be refused every read of the
 * worktree it was pointed at.
 *
 * The anchor is `//` followed by a POSIX path. The earlier finding that absolute rules
 * "did not hold" was specific to Windows drive letters, which do not survive that
 * anchor — the paths here are guest paths and are already POSIX. Measured directly
 * against the engine: `Read(//tmp/x/**)` authorises an absolute read of `/tmp/x/a.txt`,
 * and a `disallowedTools` rule on a subtree still refuses it.
 */
export function absoluteRule(tool: string, absolutePosixPath: string): string {
  const clean = absolutePosixPath.replace(/\\/g, '/').replace(/^\/+/, '');
  return tool + '(//' + clean + ')';
}

/**
 * Resolve the runtime capability grant for one agent.
 *
 * Throws rather than degrading to a smaller grant: an agent that needs to read and is
 * silently given nothing will report on files it never opened, which is worse than a
 * refusal that says so.
 */
/**
 * Tools whose availability implies a capability the contract has to declare.
 *
 * Used to prove an explicitly granted policy does not exceed its contract. The mapping
 * is deliberately coarse: if a tool can write a byte or start a process, it needs the
 * corresponding declaration, and no argument about how narrowly it is scoped changes
 * that.
 */
const CAPABILITY_IMPLYING_TOOLS: Readonly<Record<string, 'fsWrite' | 'exec'>> = Object.freeze({
  Edit: 'fsWrite',
  Write: 'fsWrite',
  NotebookEdit: 'fsWrite',
  Bash: 'exec',
  PowerShell: 'exec',
});

/** Never available to a governed run, whatever else it was granted. */
const NEVER_AVAILABLE: readonly string[] = Object.freeze([
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

/**
 * Prove an explicitly resolved grant does not exceed the contract it claims to serve.
 *
 * Phase 3's `resolveToolPolicy` refuses any contract declaring write, execute or
 * network, because no substrate could enforce them. Phase 4 supplies a substrate, so
 * the grant is computed by the engineering capability gate and handed to the runtime.
 *
 * That hand-off is the risk: a caller could pass a policy wider than anything the
 * contract describes, and the runtime would faithfully record the wider one. So the
 * runtime does not trust it. This function is the check, and it is deliberately about
 * the CONTRACT rather than about Phase 4 — the runtime stays ignorant of engineering,
 * and a future phase granting some other capability gets the same scrutiny for free.
 */
export function assertGrantWithinContract(contract: AgentContract, policy: ToolPolicy): ToolPolicy {
  const surface = parseToolSurface(contract);

  for (const tool of policy.available) {
    const needs = CAPABILITY_IMPLYING_TOOLS[tool];
    if (needs !== undefined && !surface[needs]) {
      return fail({
        code: 'E_CAPABILITY_NOT_ENABLED',
        message:
          'Granted policy makes ' +
          tool +
          ' available to ' +
          contract.id +
          ', whose contract declares no ' +
          (needs === 'fsWrite' ? 'filesystem write' : 'command execution'),
        remedy:
          'A grant implements a contract; it does not extend one. Narrow the grant, or change the contract deliberately.',
        details: { agentId: contract.id, tool, tools: contract.tools },
        specRef: '19 §5, SC-POL-026',
      });
    }
    if (NEVER_AVAILABLE.includes(tool)) {
      return fail({
        code: 'E_CAPABILITY_NOT_ENABLED',
        message: 'Granted policy makes ' + tool + ' available, which no governed run may have',
        remedy:
          'A run that could reach the network or spawn a subagent would be an ungoverned run inside a governed one.',
        details: { agentId: contract.id, tool },
        specRef: '19 §5',
      });
    }
  }

  if (policy.network !== 'NONE' && !surface.net) {
    return fail({
      code: 'E_CAPABILITY_NOT_ENABLED',
      message:
        'Granted policy allows network scope ' +
        policy.network +
        ' for ' +
        contract.id +
        ', whose contract declares none',
      remedy: 'Network access is declared in the contract or it is not granted.',
      details: { agentId: contract.id, networkScope: contract.networkScope },
      specRef: '19 TR-1',
    });
  }

  if (policy.filesystem.write.length > 0 && !surface.fsWrite) {
    return fail({
      code: 'E_CAPABILITY_NOT_ENABLED',
      message: 'Granted policy gives ' + contract.id + ' a writable path with no contract for it',
      remedy: 'Narrow the grant, or change the contract deliberately.',
      details: { agentId: contract.id, write: policy.filesystem.write },
      specRef: '19 §5',
    });
  }

  for (const denied of NEVER_AVAILABLE) {
    if (!policy.deny.includes(denied)) {
      return fail({
        code: 'E_CAPABILITY_NOT_ENABLED',
        message: 'Granted policy does not deny ' + denied,
        remedy:
          'An unavailable tool must also be unapproved. Availability and permission are two mechanisms, and only denying both closes the gap.',
        details: { agentId: contract.id, missing: denied },
        specRef: '19 §5',
      });
    }
  }

  return policy;
}

export function resolveToolPolicy(contract: AgentContract, opts: ResolveOptions): ToolPolicy {
  const surface = parseToolSurface(contract);
  const root = resolve(opts.projectRoot);

  if (!opts.enabled.has(contract.id)) {
    return fail({
      code: 'E_CAPABILITY_NOT_ENABLED',
      message: 'Agent ' + contract.id + ' (' + contract.name + ') is not enabled for execution',
      remedy:
        'Phase 3 enables a narrow non-destructive agent set. Enabling this agent is a scope decision, not a configuration tweak.',
      details: { agentId: contract.id },
      specRef: '19 §5, 33 PC-5',
    });
  }

  if (surface.fsWrite || surface.exec || surface.net) {
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

  const scope = translateReadScope(surface.fsReadTerm, root);
  if (scope === undefined) {
    // FAIL CLOSED. The alternative would be to read "release artifacts" as "the whole
    // project", which grants authority the contract never described.
    return fail({
      code: 'E_CAPABILITY_NOT_ENABLED',
      message:
        'Agent ' +
        contract.id +
        ' declares a filesystem read scope Serva cannot translate into an enforceable path rule: "' +
        String(surface.fsReadTerm) +
        '"',
      remedy:
        'Serva enforces only scopes it can express as concrete paths. Narrow the contract to a recognised scope, or add a translation rule with its path semantics stated. Approximating a narrow scope into project-wide read authority is not an option.',
      details: {
        agentId: contract.id,
        filesystemScope: contract.filesystemScope,
        recognised: Object.keys(KNOWN_READ_TERMS),
      },
      specRef: '19 TR-6, 32 §1.3',
    });
  }

  const readOnly = scope.roots.length > 0;
  const available = readOnly ? [...PHASE3_READ_TOOLS] : [];
  const denied = [...scope.denied, ...(opts.additionalDenied ?? []).map((p) => resolve(p))];
  // The absolute paths above are the RECORD; these are the enforceable RULES.
  const deniedRelative = readOnly ? [SERVA_INTERNAL_DIR + '/**'] : [];

  // Pre-approval. Under a fail-closed non-interactive permission mode, an available
  // tool with no approving rule is refused — so availability alone is not a grant.
  //
  // The rules are relative to the working directory, which the adapter always sets to
  // the project root. `scope.roots` holds the absolute paths those rules resolve to,
  // so the record stays concrete even though the rule is expressed relatively.
  const approve: string[] = [];
  if (readOnly) {
    for (const tool of PHASE3_READ_TOOLS) approve.push(relativeRule(tool, EVERYTHING_UNDER_CWD));
  }

  // Denials. Deny outranks approve in every mode, which is what makes a carve-out
  // inside a granted root actually hold.
  const deny: string[] = [...ALWAYS_DENY_TOOLS];
  for (const rel of deniedRelative) {
    for (const tool of PHASE3_READ_TOOLS) deny.push(relativeRule(tool, rel));
  }

  const rationale = [
    'contract tool surface: ' + contract.tools,
    'contract filesystem scope: ' + contract.filesystemScope,
    'contract network scope: ' + contract.networkScope,
    'read scope translation: ' + scope.basis,
    readOnly
      ? 'available tools: ' + available.join(', ')
      : 'no tools made available; an empty toolset is a valid grant (19 IV-5)',
    approve.length === 0
      ? 'no pre-approval rules, because nothing is available to approve'
      : 'pre-approved: ' + approve.join(' '),
    denied.length === 0
      ? 'no path carve-outs'
      : 'refused inside the granted root: ' + denied.join(', '),
    'the engine is never granted store access: it never talks to the store (19 §1)',
  ];

  return {
    available,
    approve,
    deny,
    filesystem: { read: scope.roots, write: [], readDenied: denied },
    network: 'NONE',
    maxToolCalls: readOnly ? 40 : 0,
    rationale,
  };
}

/**
 * An agent must never be able to widen its own grant. This is the assertion that makes
 * that checkable: the policy handed to the engine is compared against the one Serva
 * computed, and any addition — or any dropped denial — is an isolation failure.
 */
export function assertPolicyNotWidened(computed: ToolPolicy, used: ToolPolicy): void {
  const availableSet = new Set(computed.available);
  const extraAvailable = used.available.filter((t) => !availableSet.has(t));
  if (extraAvailable.length > 0) {
    fail({
      code: 'E_ISOLATION',
      message: 'Tool availability was widened after resolution: ' + extraAvailable.join(', '),
      remedy:
        'ToolPolicy is computed by Serva from the contract. Nothing downstream may add to it (SC-POL-026).',
      details: { computed: computed.available, used: used.available },
      specRef: '19 §5',
    });
  }

  const approveSet = new Set(computed.approve);
  const extraApprove = used.approve.filter((r) => !approveSet.has(r));
  if (extraApprove.length > 0) {
    fail({
      code: 'E_ISOLATION',
      message: 'Pre-approval was widened after resolution: ' + extraApprove.join(', '),
      remedy: 'Approval rules are derived from the contract read scope and nothing else.',
      details: { computed: computed.approve, used: used.approve },
      specRef: '19 §5',
    });
  }

  const usedDeny = new Set(used.deny);
  const dropped = computed.deny.filter((d) => !usedDeny.has(d));
  if (dropped.length > 0) {
    fail({
      code: 'E_ISOLATION',
      message: 'Denial rules were dropped after resolution: ' + dropped.join(', '),
      remedy: 'A denial may be added downstream but never removed.',
      details: { dropped },
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

  const extraWrite = used.filesystem.write.filter((p) => !computed.filesystem.write.includes(p));
  if (extraWrite.length > 0) {
    fail({
      code: 'E_ISOLATION',
      message: 'Filesystem write scope was widened: ' + extraWrite.join(', '),
      remedy: 'Write scope is the task boundary and is set by Serva (19 TR-6).',
      details: { extra: extraWrite },
      specRef: '19 TR-6',
    });
  }

  const extraRead = used.filesystem.read.filter((p) => !computed.filesystem.read.includes(p));
  if (extraRead.length > 0) {
    fail({
      code: 'E_ISOLATION',
      message: 'Filesystem read scope was widened: ' + extraRead.join(', '),
      remedy: 'Read scope is translated from the contract and may not be extended.',
      details: { extra: extraRead },
      specRef: '19 TR-6',
    });
  }
}
