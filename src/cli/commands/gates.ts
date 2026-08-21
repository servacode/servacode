import { emitJson, tryOpenRuntime, wantsJson } from './_shared.js';
import { getCatalogues } from '../../catalogue/index.js';
import { readGateResults } from '../../gates/engine.js';
import { SEVERITY_DISPOSITION } from '../../gates/compose.js';
import type { ParsedArgs } from '../main.js';

/**
 * `serva gates` — the gate catalogue, the composition table, and recorded results.
 *
 * The disposition table is printed from the implementation, not from prose, so a
 * reviewer can compare it directly against 31 §4.1.1.
 */
export function cmdGates(args: ParsedArgs): number {
  const cat = getCatalogues();
  const id = args.flags['id'];
  const rt = tryOpenRuntime(args);
  const results = rt === undefined ? [] : readGateResults(rt.store);

  const gates = typeof id === 'string' ? cat.gates.filter((g) => g.id === id) : cat.gates;

  if (wantsJson(args)) {
    emitJson({ gates, dispositionTable: SEVERITY_DISPOSITION, results });
    rt?.close();
    return 0;
  }

  console.log('Quality gates (catalogue 30 §7)');
  for (const g of gates) {
    const mine = results.filter((r) => r.gateRef === g.id);
    const latest = mine[mine.length - 1];
    console.log(
      '  ' +
        g.id.padEnd(30) +
        (g.blocking ? 'blocking ' : 'advisory ') +
        'after ' +
        g.afterStage.padEnd(22) +
        (latest === undefined ? '' : '  last: ' + latest.verdict),
    );
  }

  if (typeof id !== 'string') {
    console.log('');
    console.log('Severity disposition table (31 §4.1.1) — as implemented:');
    for (const [sev, byValue] of Object.entries(SEVERITY_DISPOSITION)) {
      console.log('  ' + sev);
      for (const [value, disp] of Object.entries(byValue)) {
        console.log('    ' + value.padEnd(16) + disp);
      }
    }
    console.log('');
    console.log('MAJOR + INDETERMINATE never yields an unqualified PASS (31 §4.1.1, R4).');
  }

  if (results.length > 0) {
    console.log('');
    console.log('Recorded gate results: ' + String(results.length));
    for (const r of results.slice(-10)) {
      console.log(
        '  ' +
          r.evaluatedAt +
          '  ' +
          r.gateRef.padEnd(30) +
          r.verdict +
          (r.qualifications.length > 0
            ? '  (' + String(r.qualifications.length) + ' qualification(s))'
            : ''),
      );
    }
  }

  rt?.close();
  return 0;
}
