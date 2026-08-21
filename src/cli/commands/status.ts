import { emitJson, openRuntime, wantsJson } from './_shared.js';
import { readLedger } from '../../lifecycle/stages.js';
import { readGateResults } from '../../gates/engine.js';
import { findIncompleteRuns } from '../../events/agentRun.js';
import { readViolations } from '../../events/audit.js';
import { GateVerdict } from '../../vocab/index.js';
import type { ParsedArgs } from '../main.js';

/**
 * `serva status` — what state is this project in, and what needs attention.
 *
 * Foundation for `nextAction()` (04 §9). Everything here is answered from the
 * STORE with no engine invocation, which is the property 00 R12 requires.
 */
export function cmdStatus(args: ParsedArgs): number {
  const rt = openRuntime(args);
  const project = rt.requireProject();
  const startup = rt.startupReport;
  const ledger = readLedger(rt.store);
  const gateResults = readGateResults(rt.store);
  const incompleteRuns = findIncompleteRuns(rt.store);
  const violations = readViolations(rt.store);

  const blocking = gateResults.filter(
    (g) =>
      g.verdict === GateVerdict.FAIL ||
      g.verdict === GateVerdict.NOT_VERIFIED ||
      g.verdict === GateVerdict.BLOCKED ||
      g.verdict === GateVerdict.ESCALATED,
  );
  const qualified = gateResults.filter((g) => g.verdict === GateVerdict.PASS_WITH_QUALIFICATION);

  const payload = {
    project: {
      id: project.id,
      name: project.name,
      profile: project.profile,
      riskClass: project.riskClass,
      currentStage: project.currentStage ?? null,
    },
    governance: startup.governance,
    degradedReasons: startup.degradedReasons,
    root: rt.root,
    counts: {
      stageLedgerEntries: ledger.length,
      gateResults: gateResults.length,
      blockingGateResults: blocking.length,
      qualifiedGateResults: qualified.length,
      incompleteAgentRuns: incompleteRuns.length,
      violations: violations.length,
    },
    attention: [
      ...blocking.map((g) => g.verdict + ' at ' + g.gateRef + ' (scope ' + g.scope + ')'),
      ...incompleteRuns.map((r) => 'agent run with no terminal event: ' + r),
      ...startup.degradedReasons,
    ],
  };

  if (wantsJson(args)) {
    emitJson(payload);
    rt.close();
    return 0;
  }

  console.log('SERVA GOVERNANCE = ' + payload.governance);
  console.log('');
  console.log('Project  ' + project.name + '  (' + project.id + ')');
  console.log('Root     ' + rt.root);
  console.log('Profile  ' + project.profile + '   Risk class ' + project.riskClass);
  console.log('Stage    ' + (project.currentStage ?? '(not started)'));
  console.log('');
  console.log('Stage ledger entries   ' + payload.counts.stageLedgerEntries);
  console.log('Gate results           ' + payload.counts.gateResults);
  console.log('  blocking             ' + payload.counts.blockingGateResults);
  console.log('  qualified            ' + payload.counts.qualifiedGateResults);
  console.log('Incomplete agent runs  ' + payload.counts.incompleteAgentRuns);
  console.log('Recorded violations    ' + payload.counts.violations);

  if (payload.attention.length > 0) {
    console.log('');
    console.log('Needs attention:');
    for (const a of payload.attention) console.log('  - ' + a);
  } else {
    console.log('');
    console.log('Nothing is blocked.');
  }

  rt.close();
  return 0;
}
