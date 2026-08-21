import { emitJson, tryOpenRuntime, wantsJson } from './_shared.js';
import { runDoctor } from '../../app/doctor.js';
import type { ParsedArgs } from '../main.js';

export function cmdDoctor(args: ParsedArgs): number {
  const rt = tryOpenRuntime(args);
  const report = runDoctor(rt, process.cwd());

  if (wantsJson(args)) {
    emitJson(report);
    rt?.close();
    return report.ok ? 0 : 1;
  }

  console.log('serva doctor');
  console.log('');
  for (const c of report.checks) {
    const mark = c.status === 'OK' ? '  ok  ' : c.status === 'WARN' ? ' warn ' : ' FAIL ';
    console.log('[' + mark + '] ' + c.title);
    console.log('           ' + c.detail);
    if (c.remedy !== undefined) console.log('           remedy: ' + c.remedy);
  }
  console.log('');
  console.log('Governance state: ' + report.governance);
  console.log(report.ok ? 'No failing checks.' : 'One or more checks FAILED.');

  rt?.close();
  return report.ok ? 0 : 1;
}
