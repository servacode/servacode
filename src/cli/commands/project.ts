import { emitJson, openRuntime, wantsJson } from './_shared.js';
import { SERVA_VERSION, SPEC_BASELINE } from '../../app/runtime.js';
import type { ParsedArgs } from '../main.js';

export function cmdProject(args: ParsedArgs): number {
  const rt = openRuntime(args);
  const project = rt.requireProject();
  const versions = rt.store.listCanonVersions('project', project.id);

  const payload = {
    ...project,
    root: rt.root,
    storePath: rt.store.paths.serva,
    canonVersions: versions,
    servaVersion: SERVA_VERSION,
    specBaseline: SPEC_BASELINE,
  };

  if (wantsJson(args)) {
    emitJson(payload);
    rt.close();
    return 0;
  }

  console.log('Project');
  console.log('  id            ' + project.id);
  console.log('  name          ' + project.name);
  console.log('  created       ' + project.createdAt);
  console.log('  profile       ' + project.profile);
  console.log('  risk class    ' + project.riskClass);
  console.log('  serva         ' + SERVA_VERSION + ' (spec baseline ' + SPEC_BASELINE + ')');
  console.log('  root          ' + rt.root);
  console.log('  store         ' + rt.store.paths.serva);
  console.log('  canon versions ' + (versions.length === 0 ? '(none)' : versions.join(', ')));
  console.log('');
  console.log('Idea (verbatim, immutable — 03 §2)');
  console.log('  captured      ' + project.idea.capturedAt);
  console.log('  source        ' + project.idea.source);
  console.log('  text          ' + project.idea.text);

  rt.close();
  return 0;
}
