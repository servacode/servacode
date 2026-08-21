import { emitJson, tryOpenRuntime, wantsJson } from './_shared.js';
import { getCatalogues } from '../../catalogue/index.js';
import { GATE_OUTCOME_MAPPING } from '../../lifecycle/mapping.js';
import type { WorkflowRun } from '../../domain/schemas.js';
import type { ParsedArgs } from '../main.js';

/**
 * `serva workflows` — the workflow catalogue, live run states, and the
 * gate-outcome to process-state mapping (31 §6.2).
 */
export function cmdWorkflows(args: ParsedArgs): number {
  const cat = getCatalogues();
  const rt = tryOpenRuntime(args);

  const runs: WorkflowRun[] =
    rt === undefined
      ? []
      : rt.store
          .listWorkingIds('workflowRun')
          .map((id) => rt.store.getWorking<WorkflowRun>('workflowRun', id)?.body)
          .filter((r): r is WorkflowRun => r !== undefined);

  if (wantsJson(args)) {
    emitJson({ workflows: cat.workflows, runs, gateOutcomeMapping: GATE_OUTCOME_MAPPING });
    rt?.close();
    return 0;
  }

  console.log('Workflows (catalogue 30 §8)');
  for (const w of cat.workflows) {
    const mine = runs.filter((r) => r.workflowRef === w.id);
    console.log(
      '  ' +
        w.id.padEnd(12) +
        w.name.padEnd(34) +
        (mine.length === 0 ? '' : String(mine.length) + ' run(s)'),
    );
  }

  console.log('');
  console.log('Gate outcome -> process state (31 §6.2) — as implemented:');
  console.log(
    '  ' +
      'verdict'.padEnd(26) +
      'ledger(V5d)'.padEnd(14) +
      'stage(V5c)'.padEnd(14) +
      'workItem(V5a)'.padEnd(18) +
      'workflow(V5b)',
  );
  for (const [verdict, m] of Object.entries(GATE_OUTCOME_MAPPING)) {
    const stage =
      m.stageStateNext === undefined ? m.stageState : m.stageState + '>' + m.stageStateNext;
    console.log(
      '  ' +
        verdict.padEnd(26) +
        m.ledgerDisposition.padEnd(14) +
        stage.padEnd(14) +
        m.workItemState.padEnd(18) +
        m.workflowState,
    );
  }

  if (runs.length > 0) {
    console.log('');
    console.log('Runs:');
    for (const r of runs) {
      console.log(
        '  ' +
          r.id.padEnd(22) +
          r.workflowRef.padEnd(12) +
          r.state.padEnd(12) +
          'completed=' +
          String(r.completedSteps.length),
      );
    }
  }

  rt?.close();
  return 0;
}
