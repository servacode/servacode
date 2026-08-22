import { PHASE3_ENABLED_AGENTS } from '../app/ai.js';

/**
 * THE AGENTS PHASE 5 TURNS ON.
 *
 * SPEC: 19 §5, 33 PC-5.
 *
 * Phase 3 enabled five agents and said why: enabling an agent is a scope decision, not a
 * configuration tweak. That remains true, so this is a separate, explicit list rather than
 * an edit to the Phase 3 constant — which stays exactly as it was, and still describes
 * what Phase 3 shipped.
 *
 * Every agent below is read-only company intelligence. None writes files, runs commands,
 * or holds a network tool: retrieval belongs to the research gateway, which Serva operates
 * on the agent's behalf. So enabling these grants the ability to REASON about a project
 * and record structured conclusions, and nothing else.
 *
 * The set is upstream-only on purpose. Downstream agents — implementation, QA, release —
 * are not enabled here even though their contracts exist, because Phase 5 is the front
 * half of the company and turning on an agent Serva has no governed path for would be
 * enabling a capability nobody had decided to use.
 */
export const PHASE5_INTELLIGENCE_AGENTS: ReadonlySet<string> = new Set([
  ...PHASE3_ENABLED_AGENTS,

  'SC-AGENT-020', // Product Manager                - intake framing, scope, validation
  'SC-AGENT-040', // Business Analyst               - actors, rules, processes, money
  'SC-AGENT-050', // Requirements Engineer          - functional requirements and ACs
  'SC-AGENT-051', // NFR Specialist                 - measurable quality targets
  'SC-AGENT-052', // Requirements Quality Verifier  - INDEPENDENT of 050 and 051
]);

/**
 * Research and downstream design departments, enabled as each is wired.
 *
 * Kept separate from the set above so that "which agents can currently run" stays
 * readable, and so enabling the research class — the only one whose contract declares
 * network scope — remains a visible, separate decision.
 */
export const PHASE5_RESEARCH_AGENTS: ReadonlySet<string> = new Set([
  'SC-AGENT-060', // Market Researcher    - contract declares net(declared research hosts)
  'SC-AGENT-061', // Competitive Analyst  - NO network; reasons over captured findings
  'SC-AGENT-062', // Innovation Strategist- NO network; may not edit findings
  'SC-AGENT-063', // Source Verifier      - NO network, by design; checks captures only
]);

/** Everything Phase 5 can currently run. */
export const PHASE5_ENABLED_AGENTS: ReadonlySet<string> = new Set([
  ...PHASE5_INTELLIGENCE_AGENTS,
  ...PHASE5_RESEARCH_AGENTS,
]);
