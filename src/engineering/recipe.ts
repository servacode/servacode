import { z } from 'zod';
import { EvidenceClass } from '../vocab/index.js';
import { fail } from '../core/errors.js';

/**
 * ExecutionRecipe. SPEC: Phase 4 §11, 16 (evidence), 22 DG-1.
 *
 * **Claude does not turn prose into shell execution.** A model may RECOMMEND a recipe
 * by name; Serva decides which registered recipe runs. The gap between those two
 * sentences is the whole point of this file: a system that let an agent supply the
 * command line would have no boundary at all, however good its sandbox.
 *
 * A recipe is `executable` plus an argument ARRAY. There is no shell, so there is
 * nothing for an argument to escape into. `shellEvaluation` exists for the rare
 * genuine case and is marked, requires a qualified substrate, and is refused by
 * default — a capability nobody can reach by accident.
 */

const SAFE_EXECUTABLE = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

export const ExecutionRecipeSchema = z
  .object({
    id: z.string().regex(/^SC-RECIPE-[A-Z0-9-]+$/),
    purpose: z.string().min(1),
    /** A bare program name. Never a path, never a shell line. */
    executable: z.string().regex(SAFE_EXECUTABLE),
    args: z.array(z.string()),
    /** Where it runs. WORKSPACE is the only value a Producer-facing recipe may use. */
    cwdPolicy: z.enum(['WORKSPACE', 'PROJECT_ROOT']),
    /** MINIMAL scrubs the environment to a documented allowlist. */
    environmentPolicy: z.enum(['MINIMAL', 'INHERIT_SAFE']),
    networkPolicy: z.enum(['NONE', 'DECLARED_HOSTS']),
    declaredHosts: z.array(z.string()).default([]),
    timeoutMs: z.number().int().positive().max(3_600_000),
    maxOutputBytes: z.number().int().positive().max(8_000_000),
    /** Which exit codes mean "the thing being measured is fine". */
    successExitCodes: z.array(z.number().int()).min(1),
    /** The class of evidence a successful run may support (16 §3). */
    evidenceClass: z.nativeEnum(EvidenceClass),
    /** The runtime component that owns this recipe (30 §5). */
    runtimeComponentId: z.string().regex(/^SC-RTC-\d{3}$/),
    /** When this recipe applies. Free text, read by humans, never executed. */
    applicability: z.string().min(1),
    /**
     * Explicit, and almost never true. A recipe that needs a shell is a recipe whose
     * arguments are interpreted by something other than the program it names.
     */
    shellEvaluation: z.boolean().default(false),
  })
  .strict();

export type ExecutionRecipe = z.output<typeof ExecutionRecipeSchema>;

/**
 * Environment variables a MINIMAL recipe keeps.
 *
 * Everything else is dropped, including every credential the ambient shell happens to
 * be carrying. A build does not need the owner's tokens, and an inherited environment
 * is the quietest exfiltration channel there is.
 */
export const MINIMAL_ENV_KEYS: readonly string[] = Object.freeze([
  'PATH',
  'HOME',
  'LANG',
  'LC_ALL',
  'TZ',
  'TMPDIR',
  'TEMP',
  'TMP',
  'SystemRoot',
  'COMSPEC',
  'PATHEXT',
  'NUMBER_OF_PROCESSORS',
]);

/** Names that look like secrets and are dropped even from an INHERIT_SAFE recipe. */
export const SECRET_ENV_PATTERNS: readonly RegExp[] = Object.freeze([
  /TOKEN/i,
  /SECRET/i,
  /PASSWORD/i,
  /PASSWD/i,
  /CREDENTIAL/i,
  /\bKEY\b/i,
  /API_KEY/i,
  /AUTH/i,
  /SESSION/i,
  /COOKIE/i,
  /^AWS_/i,
  /^AZURE_/i,
  /^GOOGLE_/i,
  /^GH_/i,
  /^GITHUB_/i,
  /^NPM_/i,
  /^ANTHROPIC_/i,
  /^CLAUDE/i,
]);

export function scrubEnvironment(
  policy: ExecutionRecipe['environmentPolicy'],
  source: NodeJS.ProcessEnv,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(source)) {
    if (v === undefined) continue;
    if (policy === 'MINIMAL') {
      if (MINIMAL_ENV_KEYS.includes(k)) out[k] = v;
      continue;
    }
    if (SECRET_ENV_PATTERNS.some((re) => re.test(k))) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Validate a recipe before it can be registered.
 *
 * Rejecting at registration rather than at execution matters: a malformed recipe found
 * at run time has already had a worktree built for it and an agent dispatched at it.
 */
export function validateRecipe(recipe: ExecutionRecipe): void {
  for (const a of recipe.args) {
    if (a.includes('\0')) {
      fail({
        code: 'E_VALIDATION',
        message: 'Recipe ' + recipe.id + ' has an argument containing a NUL byte',
        remedy: 'Arguments are literal strings passed to execve; a NUL truncates them.',
        details: { recipeId: recipe.id },
      });
    }
  }
  if (recipe.shellEvaluation) {
    fail({
      code: 'E_CAPABILITY_NOT_ENABLED',
      message: 'Recipe ' + recipe.id + ' requests shell evaluation, which Phase 4 does not grant',
      remedy:
        'Express the operation as an executable plus an argument array. A recipe that needs a shell is one whose arguments are interpreted by something other than the program it names.',
      details: { recipeId: recipe.id },
      specRef: 'Phase 4 §11',
    });
  }
  if (recipe.networkPolicy === 'DECLARED_HOSTS' && recipe.declaredHosts.length === 0) {
    fail({
      code: 'E_VALIDATION',
      message: 'Recipe ' + recipe.id + ' declares network access with no hosts',
      remedy: 'A network grant names its hosts, or it is NONE.',
      details: { recipeId: recipe.id },
    });
  }
}

/**
 * The registered recipes. A model names one; it does not compose one.
 *
 * Deliberately small and node-flavoured: these are the operations Phase 4 needs to
 * measure a change in this repository's own idiom. Adding a recipe is a deliberate act
 * with a reviewer, not a runtime capability.
 */
export const BUILTIN_RECIPES: readonly ExecutionRecipe[] = Object.freeze([
  ExecutionRecipeSchema.parse({
    id: 'SC-RECIPE-TYPECHECK',
    purpose: 'Type-check the workspace without emitting output.',
    executable: 'npx',
    args: ['--no-install', 'tsc', '--noEmit'],
    cwdPolicy: 'WORKSPACE',
    environmentPolicy: 'MINIMAL',
    networkPolicy: 'NONE',
    timeoutMs: 300_000,
    maxOutputBytes: 1_000_000,
    successExitCodes: [0],
    evidenceClass: EvidenceClass.EXECUTION,
    runtimeComponentId: 'SC-RTC-011',
    applicability: 'A TypeScript workspace with a tsconfig.',
  }),
  ExecutionRecipeSchema.parse({
    id: 'SC-RECIPE-BUILD',
    purpose: 'Build the workspace.',
    executable: 'npm',
    args: ['run', 'build', '--silent'],
    cwdPolicy: 'WORKSPACE',
    environmentPolicy: 'MINIMAL',
    networkPolicy: 'NONE',
    timeoutMs: 600_000,
    maxOutputBytes: 2_000_000,
    successExitCodes: [0],
    evidenceClass: EvidenceClass.EXECUTION,
    runtimeComponentId: 'SC-RTC-011',
    applicability: 'A workspace whose package.json declares a build script.',
  }),
  ExecutionRecipeSchema.parse({
    id: 'SC-RECIPE-UNIT-TEST',
    purpose: 'Run the unit test suite.',
    executable: 'npm',
    args: ['test', '--silent'],
    cwdPolicy: 'WORKSPACE',
    environmentPolicy: 'MINIMAL',
    networkPolicy: 'NONE',
    timeoutMs: 900_000,
    maxOutputBytes: 4_000_000,
    successExitCodes: [0],
    evidenceClass: EvidenceClass.EXECUTION,
    runtimeComponentId: 'SC-RTC-012',
    applicability: 'A workspace whose package.json declares a test script.',
  }),
  ExecutionRecipeSchema.parse({
    id: 'SC-RECIPE-LINT',
    purpose: 'Check the workspace against the project standards.',
    executable: 'npm',
    args: ['run', 'lint', '--silent'],
    cwdPolicy: 'WORKSPACE',
    environmentPolicy: 'MINIMAL',
    networkPolicy: 'NONE',
    timeoutMs: 300_000,
    maxOutputBytes: 1_000_000,
    successExitCodes: [0],
    evidenceClass: EvidenceClass.EXECUTION,
    runtimeComponentId: 'SC-RTC-013',
    applicability: 'A workspace whose package.json declares a lint script.',
  }),
]);

export class RecipeRegistry {
  private readonly byId: Map<string, ExecutionRecipe>;

  constructor(recipes: readonly ExecutionRecipe[] = BUILTIN_RECIPES) {
    for (const r of recipes) validateRecipe(r);
    this.byId = new Map(recipes.map((r) => [r.id, r]));
  }

  all(): readonly ExecutionRecipe[] {
    return [...this.byId.values()];
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  /**
   * Resolve a recipe by id.
   *
   * The one place a model-supplied string touches execution, and it can only ever
   * select from this map — never extend it, never modify an entry.
   */
  get(id: string): ExecutionRecipe {
    const r = this.byId.get(id);
    if (r === undefined) {
      return fail({
        code: 'E_NOT_FOUND',
        message: 'Unknown execution recipe: ' + id,
        remedy:
          'Serva executes registered recipes only. A recommendation that names no registered recipe is a recommendation, not a command.',
        details: { recipeId: id, registered: [...this.byId.keys()] },
        specRef: 'Phase 4 §11',
      });
    }
    return r;
  }

  byComponent(runtimeComponentId: string): readonly ExecutionRecipe[] {
    return this.all().filter((r) => r.runtimeComponentId === runtimeComponentId);
  }
}
