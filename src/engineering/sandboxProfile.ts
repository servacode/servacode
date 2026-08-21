import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { canonicalJson, digestOf } from '../core/hash.js';
import { SERVA_INTERNAL_DIR } from '../agents/toolPolicy.js';

/**
 * The sandbox policy Serva generates for one engineering run.
 *
 * SPEC: Phase 4 §4, ADR-003 §3.2.
 *
 * Generated per run and written to a Serva-owned settings file. **Never inherited from
 * ambient project or user configuration**, for the same reason Phase 3 refuses ambient
 * context: a policy the repository can influence is a policy the thing being governed
 * can influence.
 *
 * Two settings carry most of the weight, and both close a hole rather than adding a
 * feature:
 *
 *   failIfUnavailable          by default a sandbox that cannot start produces a
 *                              warning and the command runs UNSANDBOXED. This makes it
 *                              a hard failure.
 *   allowUnsandboxedCommands   by default a sandboxed command that fails can be retried
 *                              without the sandbox. False disables that entirely and
 *                              makes `dangerouslyDisableSandbox` inert.
 *
 * Together: the sandbox cannot fail to start quietly, and it cannot get out of the way
 * once it has. A boundary with an automatic fallback is a suggestion.
 */

export interface SandboxProfileInput {
  readonly worktreePath: string;
  readonly projectRoot: string;
  /** Extra absolute paths a recipe genuinely needs to write, each with a reason. */
  readonly additionalWrite?: readonly string[];
  readonly networkAllowed?: boolean;
}

export interface GeneratedSandboxProfile {
  readonly settings: Record<string, unknown>;
  readonly digest: string;
  /** Written to disk only when a run needs it; the caller owns the lifetime. */
  readonly path?: string;
}

/** Credential locations denied to every engineering run, on every platform. */
export const CREDENTIAL_DENY_READ: readonly string[] = Object.freeze([
  '~/.ssh',
  '~/.aws',
  '~/.azure',
  '~/.config/gcloud',
  '~/.config/gh',
  '~/.claude',
  '~/.netrc',
  '~/.npmrc',
  '~/.docker/config.json',
  '~/.gitconfig',
  '~/.git-credentials',
]);

export function buildSandboxProfile(input: SandboxProfileInput): GeneratedSandboxProfile {
  const worktree = resolve(input.worktreePath);
  const project = resolve(input.projectRoot);

  const settings = {
    sandbox: {
      enabled: true,
      // A sandbox that cannot start must stop the run, not warn and continue.
      failIfUnavailable: true,
      // No retry-without-the-sandbox, and dangerouslyDisableSandbox becomes inert.
      allowUnsandboxedCommands: false,
      // Nothing is excluded. An exclusion is a command that runs outside the boundary,
      // which is the thing this profile exists to prevent.
      excludedCommands: [],
      filesystem: {
        // The worktree, and whatever a recipe justified. Nothing else.
        allowWrite: [worktree, ...(input.additionalWrite ?? []).map((p) => resolve(p))],
        denyWrite: [project, join(project, SERVA_INTERNAL_DIR), '~/'],
        allowRead: [worktree, project],
        denyRead: [join(project, SERVA_INTERNAL_DIR), ...CREDENTIAL_DENY_READ],
      },
      network: { enabled: input.networkAllowed === true },
    },
  };

  return { settings, digest: digestOf(canonicalJson(settings)) };
}

/**
 * Write the profile for one run into its own directory.
 *
 * Under `.serva`, which every governed run is denied — so an agent cannot read the
 * policy governing it, and certainly cannot edit it. A policy the governed party can
 * rewrite is not a policy.
 */
export function writeSandboxProfile(
  profile: GeneratedSandboxProfile,
  projectRoot: string,
  runId: string,
): GeneratedSandboxProfile {
  const dir = join(resolve(projectRoot), SERVA_INTERNAL_DIR, 'tmp', 'sandbox-' + runId);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'settings.json');
  writeFileSync(path, JSON.stringify(profile.settings, null, 2), 'utf8');
  return { ...profile, path };
}

export function removeSandboxProfile(profile: GeneratedSandboxProfile): void {
  if (profile.path === undefined) return;
  rmSync(join(profile.path, '..'), { recursive: true, force: true });
}

/**
 * Compare the policy Serva INTENDED with the one the engine actually reported.
 *
 * The factory must know the EFFECTIVE policy, not the intended one. A profile that was
 * written and then ignored — a settings source that did not load, a version that reads
 * a key differently — would leave Serva recording a boundary that was never in force.
 */
export function sandboxProfileDrift(
  intended: GeneratedSandboxProfile,
  effective: Record<string, unknown> | undefined,
): string | undefined {
  if (effective === undefined) {
    return 'The engine reported no effective sandbox policy, so Serva cannot confirm the profile it wrote was applied.';
  }
  const want = intended.settings['sandbox'] as Record<string, unknown>;
  const got = effective['sandbox'] as Record<string, unknown> | undefined;
  if (got === undefined) return 'The effective settings contain no sandbox section.';

  for (const key of ['enabled', 'failIfUnavailable', 'allowUnsandboxedCommands']) {
    if (got[key] !== want[key]) {
      return (
        'Effective sandbox.' +
        key +
        ' is ' +
        JSON.stringify(got[key]) +
        ' but Serva required ' +
        JSON.stringify(want[key]) +
        '.'
      );
    }
  }
  const excluded = got['excludedCommands'];
  if (Array.isArray(excluded) && excluded.length > 0) {
    return 'Effective policy excludes commands from the sandbox: ' + excluded.join(', ');
  }
  return undefined;
}
