import { createProject, newProjectRefusal } from '../../app/create.js';
import { fail } from '../../core/errors.js';
import type { ParsedArgs } from '../main.js';

/**
 * `serva init` is one caller of the creation service, not the creation service.
 *
 * SPEC: Phase 6 closure §4; 03 §2.
 *
 * The rules about what may be created live in `src/app/create.ts`, which the
 * `Serva: New Project` command calls too. This file's whole job is turning flags into a
 * request and a result into terminal output — so a project made here and one made from the
 * Control Center are the same project, made the same way.
 */
export function cmdInit(args: ParsedArgs): number {
  const name = args.positionals[0] ?? '';
  const idea = args.flags['idea'];
  const rootFlag = args.flags['root'];
  const root = typeof rootFlag === 'string' && rootFlag !== '' ? rootFlag : process.cwd();

  if (typeof idea !== 'string') {
    fail({
      code: 'E_VALIDATION',
      message: 'serva init requires --idea',
      remedy:
        'The Idea is captured verbatim and is the only immutable record of what was actually asked (03 §2). Pass --idea "<text>".',
      specRef: '03 SC-STAGE-002',
    });
  }

  const refusal = newProjectRefusal({ root, name, idea });
  if (refusal !== undefined) {
    fail({
      code: 'E_VALIDATION',
      message: refusal.message,
      remedy: refusal.remedy,
      details: { field: refusal.field },
      specRef: '03 SC-STAGE-002',
    });
  }

  const created = createProject({ root, name, idea });

  console.log('Initialized Serva project');
  console.log('  id       ' + created.projectId);
  console.log('  name     ' + created.name);
  console.log('  root     ' + created.root);
  console.log('  store    ' + created.storePath);
  console.log('  profile  ' + created.profile);
  console.log('');
  console.log('The Idea has been recorded verbatim and is immutable (03 §2):');
  console.log('  ' + created.idea);
  console.log('');
  console.log('Next: serva status');
  return 0;
}
