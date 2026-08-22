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
  /**
   * The POLICY, with paths replaced by the role they play.
   *
   * `digest` covers the concrete settings and therefore differs for every attempt,
   * because every attempt has its own worktree. That makes it useless as a boundary
   * identity: comparing it would refuse every dispatch while looking rigorous.
   *
   * This digest answers the question that actually matters — is the POLICY the same one
   * that was measured? Change a path and it holds; change the write scope shape, the
   * denied reads, the network stance, or either of the two settings that decide whether
   * the sandbox can be got out of the way, and it moves.
   */
  readonly policyDigest: string;
  /** Written to disk only when a run needs it; the caller owns the lifetime. */
  readonly path?: string;
}

/** Replace concrete paths with the role they play, so the digest describes the policy. */
function policyShape(
  settings: Record<string, unknown>,
  worktree: string,
  project: string,
): unknown {
  const label = (p: string): string => {
    const n = resolve(p);
    if (n === worktree) return '<WORKTREE>';
    if (n === project) return '<PROJECT>';
    if (n.startsWith(worktree))
      return '<WORKTREE>' + n.slice(worktree.length).split(String.fromCharCode(92)).join('/');
    if (n.startsWith(project))
      return '<PROJECT>' + n.slice(project.length).split(String.fromCharCode(92)).join('/');
    return p;
  };
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return label(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = walk(x);
      return out;
    }
    return v;
  };
  return walk(settings);
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
      /*
       * `allowedDomains`, not `{ enabled: false }`.
       *
       * The engine's network layer is an allowlist of domains; an empty list is the
       * denial. `enabled` is not a key it validates, and a settings file that fails
       * validation is silently ignored — so the WHOLE sandbox profile was dropped and
       * the run fell back to defaults: writes confined to the working directory, reads
       * open across the machine.
       *
       * Measured, not inferred. A real Producer with Bash reached
       * `cat <project>/.serva/SECRET_MARKER.txt` and got the contents, while the same
       * case refused under the standalone runtime. One malformed key had voided every
       * read protection in the profile while the write protections — which come from
       * the default policy — kept working and made it look fine.
       */
      network: { allowedDomains: input.networkAllowed === true ? ['*'] : [] },
    },
  };

  return {
    settings,
    digest: digestOf(canonicalJson(settings)),
    policyDigest: digestOf(canonicalJson(policyShape(settings, worktree, project))),
  };
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
