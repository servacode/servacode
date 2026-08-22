import { resolve } from 'node:path';
import {
  ALWAYS_DENY_TOOLS,
  PHASE3_READ_TOOLS,
  assertGrantWithinContract,
  parseToolSurface,
} from '../../agents/toolPolicy.js';
import { fail } from '../../core/errors.js';
import type { AgentContract } from '../../agents/schema.js';
import type { ToolPolicy } from '../../engine/types.js';

/**
 * THE GRANT FOR AN AGENT WHOSE CONTRACT DECLARES NETWORK — AND WHICH GETS NONE.
 *
 * SPEC: §10, §42, 19 §5, 33 PC-5.
 *
 * Phase 3's `resolveToolPolicy` refuses any contract declaring network, and the reason it
 * gives is right: it cannot enforce network at call time. Serva's answer is not to enforce
 * it — it is to not grant it. Retrieval happens OUTSIDE the run, in the research gateway,
 * under Serva's own authority, and the agent receives captured evidence as data.
 *
 * So the grant computed here is strictly READ-ONLY with `network: 'NONE'`. It is narrower
 * than the contract, which is the only direction a grant may ever differ:
 * `assertGrantWithinContract` proves that before anything is bound, so this cannot become
 * a way to widen authority by computing it somewhere new.
 *
 * The same shape is used for the whole research chain. The analyst, strategist and
 * verifier declare no network at all and would resolve normally — routing them through
 * here too keeps one answer to "what may an intelligence run touch": nothing but its
 * context.
 */
export function resolveIntelligencePolicy(
  contract: AgentContract,
  opts: { readonly projectRoot: string; readonly enabled: ReadonlySet<string> },
): ToolPolicy {
  if (!opts.enabled.has(contract.id)) {
    return fail({
      code: 'E_CAPABILITY_NOT_ENABLED',
      message: 'Agent ' + contract.id + ' (' + contract.name + ') is not enabled for execution',
      remedy:
        'Enabling an agent is a scope decision, not a configuration tweak. Add it to the Phase 5 set deliberately.',
      details: { agentId: contract.id },
      specRef: '19 §5, 33 PC-5',
    });
  }

  const surface = parseToolSurface(contract);
  if (surface.fsWrite || surface.exec) {
    return fail({
      code: 'E_CAPABILITY_NOT_ENABLED',
      message:
        'Agent ' +
        contract.id +
        ' declares filesystem write or command execution, which no intelligence run may have',
      remedy:
        'Company intelligence reads and reasons. Producing code is Phase 4 work under a measured boundary.',
      details: { agentId: contract.id, tools: contract.tools },
      specRef: '19 §5',
    });
  }

  const policy: ToolPolicy = {
    /*
     * No tools at all. An intelligence run receives its context in the prompt and returns
     * structured output; it has nothing to read from disk and nowhere to write.
     */
    available: [],
    approve: [],
    deny: [...ALWAYS_DENY_TOOLS, ...PHASE3_READ_TOOLS],
    filesystem: { read: [], write: [], readDenied: [resolve(opts.projectRoot)] },
    /* The declared scope is deliberately NOT honoured. Serva retrieves; the agent does not. */
    network: 'NONE',
    maxToolCalls: 0,
    rationale: [
      'company intelligence run: reads its context, returns structured output',
      'no filesystem, no execution, no network',
      ...(surface.net
        ? [
            'contract declares network scope (' +
              contract.networkScope +
              '), and it is NOT granted: retrieval is performed by the research gateway under Serva’s authority, and this run receives captured evidence as untrusted data',
          ]
        : []),
    ],
  };

  /* A grant may narrow a contract; it may never widen one. Proved, not assumed. */
  return assertGrantWithinContract(contract, policy);
}
