import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { ServaRuntime } from './runtime.js';
import { storePaths } from '../store/paths.js';
import { SERVA_VERSION } from '../portability/version.js';

/**
 * CREATING A PROJECT, ONCE, FOR EVERY SURFACE.
 *
 * SPEC: Phase 6 closure §4; §11, §13.
 *
 * An independent audit found that Serva Code could only be started from a terminal. The
 * extension is the primary experience and it had no way to bring a project into existence, so
 * the first thing an owner had to do with a VS Code product was leave it.
 *
 * The fix is not a second creation path in the extension. Two paths would drift, and the one
 * that drifted would be the one nobody ran in CI — a project made from the panel would end up
 * subtly different from one made from the CLI, and the difference would surface much later as
 * a project that behaves oddly for no visible reason.
 *
 * So there is one service. `serva init` calls it and prints; the `Serva: New Project` command
 * calls it and opens a window. Everything that decides whether creation is allowed, and what
 * exists afterwards, lives here where a test can reach it without VS Code.
 *
 * THE IDEA IS VERBATIM. Neither surface may summarise, tidy or translate what the owner
 * typed: it is the only immutable record of what was actually asked (03 §2), and every later
 * disagreement about scope is settled against it. Trimming the surrounding whitespace is the
 * only thing done to it, and that is done here so both surfaces do the same thing.
 */

export const NewProjectField = {
  ROOT: 'ROOT',
  NAME: 'NAME',
  IDEA: 'IDEA',
} as const;
export type NewProjectField = (typeof NewProjectField)[keyof typeof NewProjectField];

export interface NewProjectRefusal {
  readonly field: NewProjectField;
  readonly message: string;
  readonly remedy: string;
}

export interface NewProjectRequest {
  /** The directory the project will live in. It must already exist. */
  readonly root: string;
  readonly name: string;
  /** The owner's own words. Captured verbatim. */
  readonly idea: string;
}

export interface NewProject {
  readonly projectId: string;
  readonly name: string;
  readonly root: string;
  readonly storePath: string;
  readonly profile: string;
  readonly servaVersion: string;
  /** Exactly what was recorded, so a surface can show the owner what it kept. */
  readonly idea: string;
}

/** A project name is a label a person reads, not a path segment. */
const NAME_MAX = 80;

/**
 * Why this request cannot be carried out, or `undefined`.
 *
 * Separated from `createProject` so a wizard can check one field at a time, as the owner
 * types it, and say what is wrong before they have entered the rest. A wizard that collects
 * three answers and then refuses the first has wasted the other two.
 */
export function newProjectRefusal(
  o: Partial<NewProjectRequest>,
  field?: NewProjectField,
): NewProjectRefusal | undefined {
  const check = (f: NewProjectField): boolean => field === undefined || field === f;

  if (check(NewProjectField.NAME)) {
    const name = (o.name ?? '').trim();
    if (name === '') {
      return {
        field: NewProjectField.NAME,
        message: 'A project needs a name.',
        remedy: 'Give it the name you would use when talking about it.',
      };
    }
    if (name.length > NAME_MAX) {
      return {
        field: NewProjectField.NAME,
        message: 'That name is ' + String(name.length) + ' characters; the limit is 80.',
        remedy: 'Shorten it. The idea below is where the detail belongs.',
      };
    }
    /*
     * The name reaches audit lines, panel headings and backup manifests. A control character
     * or a line break there is invisible in one surface and corrupting in another.
     */
    if (/[\u0000-\u001f\u007f]/.test(name)) {
      return {
        field: NewProjectField.NAME,
        message: 'That name contains a control character.',
        remedy: 'Use ordinary text.',
      };
    }
  }

  if (check(NewProjectField.IDEA)) {
    const idea = (o.idea ?? '').trim();
    if (idea === '') {
      return {
        field: NewProjectField.IDEA,
        message: 'Serva needs the idea in your own words.',
        remedy:
          'Write what you actually want, however roughly. It is recorded verbatim and never ' +
          'changed, and every later question about scope is answered against it.',
      };
    }
  }

  if (check(NewProjectField.ROOT)) {
    const root = (o.root ?? '').trim();
    if (root === '') {
      return {
        field: NewProjectField.ROOT,
        message: 'Serva needs a folder to put the project in.',
        remedy: 'Choose an empty folder, or a folder holding the code this project is about.',
      };
    }
    const absolute = resolve(root);
    if (!existsSync(absolute) || !statSync(absolute).isDirectory()) {
      return {
        field: NewProjectField.ROOT,
        message: absolute + ' is not a folder that exists.',
        remedy: 'Create the folder first, then choose it. Serva does not create it for you.',
      };
    }
    if (existsSync(storePaths(absolute).serva)) {
      return {
        field: NewProjectField.ROOT,
        message: 'A Serva project already exists in ' + absolute + '.',
        remedy:
          'Open that project instead. Creating a second one over it would put two companies ' +
          'in one folder, and neither would be able to trust what it read.',
      };
    }
  }

  return undefined;
}

/**
 * Bring a project into existence.
 *
 * Refuses before it creates anything: the check above runs first, so a rejected request
 * leaves the folder exactly as it was rather than half-initialised.
 */
export function createProject(o: NewProjectRequest): NewProject {
  const refusal = newProjectRefusal(o);
  if (refusal !== undefined) {
    const error = new Error(refusal.message) as Error & {
      code: string;
      field: NewProjectField;
      remedy: string;
    };
    error.code = 'E_VALIDATION';
    error.field = refusal.field;
    error.remedy = refusal.remedy;
    throw error;
  }

  const root = resolve(o.root.trim());
  const rt = ServaRuntime.init(o.name.trim(), o.idea.trim(), { root });
  try {
    const project = rt.requireProject();
    return {
      projectId: project.id,
      name: project.name,
      root: rt.root,
      storePath: rt.store.paths.serva,
      profile: project.profile,
      servaVersion: SERVA_VERSION,
      idea: project.idea.text,
    };
  } finally {
    rt.close();
  }
}
