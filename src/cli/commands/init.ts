import { ServaRuntime } from '../../app/runtime.js';
import { fail } from '../../core/errors.js';
import type { ParsedArgs } from '../main.js';

export function cmdInit(args: ParsedArgs): number {
  const name = args.positionals[0];
  if (name === undefined || name.length === 0) {
    fail({
      code: 'E_VALIDATION',
      message: 'serva init requires a project name',
      remedy: 'Usage: serva init <name> --idea "<the raw idea, verbatim>"',
    });
  }
  const idea = args.flags['idea'];
  if (typeof idea !== 'string' || idea.trim().length === 0) {
    fail({
      code: 'E_VALIDATION',
      message: 'serva init requires --idea',
      remedy:
        'The Idea is captured verbatim and is the only immutable record of what was actually asked (03 §2). Pass --idea "<text>".',
      specRef: '03 SC-STAGE-002',
    });
  }

  const rootFlag = args.flags['root'];
  const rt = ServaRuntime.init(name, idea, {
    ...(typeof rootFlag === 'string' ? { root: rootFlag } : {}),
  });
  const project = rt.requireProject();

  console.log('Initialized Serva project');
  console.log('  id       ' + project.id);
  console.log('  name     ' + project.name);
  console.log('  root     ' + rt.root);
  console.log('  store    ' + rt.store.paths.serva);
  console.log('  profile  ' + project.profile);
  console.log('');
  console.log('The Idea has been recorded verbatim and is immutable (03 §2).');
  console.log('Next: serva status');
  rt.close();
  return 0;
}
