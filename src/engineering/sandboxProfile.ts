import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { canonicalJson, digestOf } from '../core/hash.js';
import { SERVA_INTERNAL_DIR } from '../agents/toolPolicy.js';
import { workspacesRootFor } from './workspace.js';

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
  /**
   * A host path as the ENGINE will name it.
   *
   * Not cosmetic. Serva runs on Windows and delegates write-capable Producers to WSL2,
   * so a profile emitting `C:\\Users\\...\\worktree` names a directory that does not
   * exist in the environment enforcing it. Every entry then matches nothing: the write
   * allowance grants nothing, the read denials deny nothing, and the engine falls back to
   * its default policy — which confines writes to the working directory, so the result
   * LOOKS like a working sandbox while every read protection is absent.
   *
   * Defaults to identity, which is correct when the engine runs on the host.
   */
  readonly toExecutionPath?: (hostPath: string) => string;
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
  workspacesRoot: string,
): unknown {
  /*
   * Order matters, and it is not "most important first" — it is LONGEST PATH first.
   *
   * The worktree lives inside the workspaces root, and in a test fixture the workspaces
   * root can BE the project root. Whichever of those coincidences holds, the same policy
   * must reduce to the same shape, or the boundary identity changes for reasons that have
   * nothing to do with the policy and the comparison becomes theatre.
   */
  interface Anchor {
    readonly base: string;
    readonly name: string;
  }
  const anchors: readonly Anchor[] = [
    { base: worktree, name: '<WORKTREE>' },
    { base: workspacesRoot, name: '<WORKSPACES>' },
    { base: project, name: '<PROJECT>' },
  ].sort((a, b) => b.base.length - a.base.length);

  const label = (p: string): string => {
    // Already normalised and already translated by the caller. Re-resolving here would
    // reinterpret a guest path against the host's rules.
    const n = p;
    for (const a of anchors) {
      if (n === a.base) return a.name;
    }
    for (const a of anchors) {
      if (n.startsWith(a.base)) {
        return a.name + n.slice(a.base.length).split(String.fromCharCode(92)).join('/');
      }
    }
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

/**
 * Sandbox settings keys Serva is allowed to emit, with the version that introduced
 * each one.
 *
 * An allowlist, not a blocklist, and the difference is the whole point. Serva emitted
 * `sandbox.network.enabled` — not a key the engine validates — and a settings file that
 * fails validation is silently ignored, so the ENTIRE profile was dropped and the run
 * fell back to defaults. Writes stayed confined to the working directory, which made it
 * look correct; every read protection was simply absent, and a real Producer read the
 * Serva store through Bash.
 *
 * `claude doctor` does not help here: measured on 2.1.231, it produces byte-identical
 * output for a valid profile and one carrying that bad key. Serva therefore cannot ask
 * the engine whether a profile was accepted, which leaves one honest option — never
 * emit a key that is not known to be accepted by the detected version, and treat
 * anything else as blocking.
 */
export interface SandboxKeySpec {
  readonly path: string;
  /** Minimum engine version. Absent means every version Serva supports. */
  readonly since?: string;
}

export const SUPPORTED_SANDBOX_KEYS: readonly SandboxKeySpec[] = Object.freeze([
  { path: 'sandbox.enabled' },
  { path: 'sandbox.failIfUnavailable' },
  { path: 'sandbox.allowUnsandboxedCommands' },
  { path: 'sandbox.excludedCommands' },
  { path: 'sandbox.autoAllowBashIfSandboxed' },
  { path: 'sandbox.filesystem.allowWrite' },
  { path: 'sandbox.filesystem.denyWrite' },
  { path: 'sandbox.filesystem.allowRead' },
  { path: 'sandbox.filesystem.denyRead' },
  { path: 'sandbox.network.allowedDomains' },
  { path: 'sandbox.network.deniedDomains' },
  // Denies every host outside the allowlist instead of prompting. With an empty
  // allowlist that is "no subprocess egress at all", which is the Producer policy.
  { path: 'sandbox.network.strictAllowlist', since: '2.1.219' },
  { path: 'sandbox.credentials.files', since: '2.1.187' },
  { path: 'sandbox.credentials.envVars', since: '2.1.187' },
]);

/** Credential locations denied to every engineering run, on every platform. */
export const CREDENTIAL_DENY_FILES: readonly string[] = Object.freeze([
  '~/.ssh',
  '~/.aws',
  '~/.azure',
  '~/.config/gcloud',
  '~/.config/gh',
  '~/.claude',
  '~/.claude.json',
  '~/.netrc',
  '~/.npmrc',
  '~/.docker/config.json',
  '~/.gitconfig',
  '~/.git-credentials',
]);

/**
 * The repository's OWN git config, which the user-level deny list does not cover.
 *
 * SPEC: finding ENGINEERING-HARD-BOUNDARY/EHB-1 (MEDIUM), 1.0.1 security review.
 *
 * `.git` is re-opened for reading because a linked worktree is a pointer into it and git does
 * not work without it — measured, not assumed. The rationale for that said "the history
 * discloses nothing the worktree does not", and for objects and refs it is true. It is not
 * true of `<project>/.git/config`, which is repository-level configuration rather than
 * content: remote URLs, which can carry a token inline.
 *
 * `~/.gitconfig` and `~/.git-credentials` were already denied. The repo-level file is the same
 * class of thing and was not, which is the only reason it is named separately here.
 *
 * WHAT IS NOT YET PROVEN, STATED RATHER THAN IMPLIED: this profile already depends on ALLOW
 * beating DENY for a narrower path — the project is denied and `.git` re-opened inside it —
 * so a DENY narrower than an ALLOW is the reverse precedence, and this build has not measured
 * it. The deny is declared on both channels the sandbox offers; whether the sandbox honours it
 * over the `.git` allow is a question for a probe, not for this comment. Until that
 * measurement exists, treat the repo config as narrowed-by-intent and not as contained.
 */
export function projectGitConfig(projectPath: string): string {
  return join(projectPath, '.git', 'config');
}

/**
 * The regions a Producer has no business reading, denied as ROOTS rather than as a list
 * of specific things worth protecting.
 *
 * Measured defect: naming the project, the store, the other attempts and the home
 * directory left everything else readable, because the engine's default read model is
 * "the whole machine except what you denied". A probe reading a marker file from a
 * temporary directory outside all of those succeeded. Enumerating a denied directory
 * succeeded too. Protecting a list of known-sensitive places is the wrong shape: the
 * Producer should be able to read the code it was given and the runtime it needs, and
 * the way to say that is to deny the places user data lives and re-open exactly one.
 *
 * `/mnt` is the important one on this machine: Serva runs on Windows and delegates the
 * Producer to WSL2, so the ENTIRE Windows filesystem — the project, every other attempt,
 * and the owner's documents — hangs off `/mnt/c`. The worktree also lives there, and is
 * re-opened by `allowRead`, which wins because it is the more specific path.
 *
 * What is deliberately NOT here: `/usr`, `/lib`, `/bin`, `/etc`, `/proc`, `/sys`, `/dev`.
 * Node, git and the shell live there. Denying them would not be stricter, it would be a
 * Producer that cannot run.
 */
export const USER_DATA_ROOTS: readonly string[] = Object.freeze([
  '/mnt',
  '/home',
  '/root',
  '/media',
  '/srv',
  '/tmp',
  '/var/tmp',
]);

/** Secrets unset for every sandboxed command, whatever the filesystem policy says. */
export const CREDENTIAL_DENY_ENV: readonly string[] = Object.freeze([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'NPM_TOKEN',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
]);

/**
 * The Producer's OS sandbox policy.
 *
 * Reads are the part that had no teeth. The engine's default read model is "the whole
 * computer except a few directories", which is far too broad for a Producer: it could
 * read the owner's home, the primary checkout, another attempt's worktree, and Serva's
 * own authoritative state. So the policy denies those regions explicitly and re-opens
 * exactly one — this worktree — relying on the documented rule that the more specific
 * path wins when read regions overlap.
 *
 * The runtime is deliberately NOT denied. Node, git and the shell live under `/usr`,
 * `/lib` and `/etc`, and a policy that denied them would not be stricter, it would be
 * broken. What matters is that nothing the OWNER cares about is readable.
 *
 * Paths here are sandbox-filesystem paths: `/abs` is absolute and `~/` is home. That is
 * NOT the permission-rule syntax, where absolute is `//abs` — mixing the two is how the
 * reviewer's read grant came to match nothing.
 */
export function buildSandboxProfile(input: SandboxProfileInput): GeneratedSandboxProfile {
  /*
   * Resolve on the HOST, then translate. The order is forced: `resolve()` is
   * platform-dependent, so resolving an already-translated POSIX path on Windows would
   * turn `/home/x/wt` into `D:\\home\\x\\wt`.
   */
  const map = input.toExecutionPath ?? ((x: string): string => x);
  const hostProject = resolve(input.projectRoot);
  /*
   * Every child path is composed on the HOST and translated afterwards, never composed
   * from an already-translated parent: `join()` uses the host separator, so
   * `join('/mnt/c/proj', '.serva')` on Windows yields a backslash path that names
   * nothing anywhere.
   */
  const worktree = map(resolve(input.worktreePath));
  const project = map(hostProject);
  const workspacesRoot = map(workspacesRootFor(hostProject));
  const servaDir = map(join(hostProject, SERVA_INTERNAL_DIR));
  const gitDir = map(join(hostProject, '.git'));

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
        allowWrite: [worktree, ...(input.additionalWrite ?? []).map((p) => map(resolve(p)))],
        denyWrite: [project, servaDir, '~/'],
        /*
         * Deny the regions that matter, then re-open this worktree alone. Sibling
         * attempts live under the same parent, so denying it and allowing only this
         * one is what keeps two concurrent Producers out of each other's work.
         */
        denyRead: [
          ...USER_DATA_ROOTS,
          servaDir,
          project,
          workspacesRoot,
          '~/',
          ...CREDENTIAL_DENY_FILES,
          /* Named after `project` is denied and before `.git` is re-opened below. */
          map(projectGitConfig(hostProject)),
        ],
        /*
         * The worktree, and the repository it is a worktree OF.
         *
         * A linked worktree is not self-contained: its `.git` is a pointer into
         * `<project>/.git/worktrees/<name>`, so with the project denied, `git status`
         * inside the worktree failed with exit 128 — measured, as a positive control.
         * Every recipe and half the tooling a Producer might run shells out to git, so
         * this is not a nicety.
         *
         * It is the narrowest thing that works: `.git` only, named explicitly, while the
         * project's working tree and the Serva store stay denied. The Producer can
         * already see this repository's content — it is the code it was given — so the
         * history discloses nothing the worktree does not.
         */
        allowRead: [worktree, gitDir],
      },
      network: {
        // Empty allowlist plus strict enforcement: no subprocess egress at all, and no
        // prompting. The engine's own connection to the provider is a different channel
        // and is unaffected.
        allowedDomains: input.networkAllowed === true ? ['*'] : [],
        strictAllowlist: input.networkAllowed !== true,
      },
      credentials: {
        files: [...CREDENTIAL_DENY_FILES, map(projectGitConfig(hostProject))].map((path) => ({
          path,
          mode: 'deny',
        })),
        envVars: CREDENTIAL_DENY_ENV.map((name) => ({ name, mode: 'deny' })),
      },
    },
  };

  return {
    settings,
    digest: digestOf(canonicalJson(settings)),
    policyDigest: digestOf(canonicalJson(policyShape(settings, worktree, project, workspacesRoot))),
  };
}

export const SandboxProfileStatus = {
  /** Serva built it. Says nothing about whether the engine would accept it. */
  GENERATED: 'GENERATED',
  /** Every key is one the detected engine version is known to accept. */
  VALIDATED: 'VALIDATED',
  /** Written to disk and still byte-identical to what Serva generated. */
  LOADED: 'LOADED',
  /** The engine reported an effective policy matching it, where it can report one. */
  EFFECTIVE: 'EFFECTIVE',
  /** A probe reached the OS boundary and the boundary refused what it should. */
  MEASURED: 'MEASURED',
} as const;
export type SandboxProfileStatus = (typeof SandboxProfileStatus)[keyof typeof SandboxProfileStatus];

/** The order they must be reached in. HARD requires every one of them. */
export const SANDBOX_STATUS_ORDER: readonly SandboxProfileStatus[] = Object.freeze([
  SandboxProfileStatus.GENERATED,
  SandboxProfileStatus.VALIDATED,
  SandboxProfileStatus.LOADED,
  SandboxProfileStatus.EFFECTIVE,
  SandboxProfileStatus.MEASURED,
]);

/**
 * What an adversarial run actually observed about ONE policy.
 *
 * Bound to `policyDigest` and `boundaryFingerprint` on purpose. A measurement is a
 * statement about a specific policy on a specific machine; carrying it forward across a
 * policy change is how Serva came to record a HARD boundary for a profile the engine had
 * silently discarded. Change the policy and this no longer matches, so it no longer
 * counts — which is the drift invalidation, expressed as an identity rather than as a
 * rule someone has to remember to apply.
 */
/**
 * How a probe came to behave the way it did.
 *
 * A refusal is only evidence about the sandbox if the sandbox is what refused it. On this
 * machine a Windows binary cannot be executed from the guest at all — with or without a
 * sandbox — so crediting that refusal to the sandbox would be inventing a capability.
 */
export const ContainmentAttribution = {
  /** The OS sandbox refused it. This is the evidence the qualification exists to obtain. */
  SANDBOX: 'SANDBOX',
  /**
   * The environment already prevents it, sandbox or no sandbox. Recorded, and explicitly
   * NOT counted as containment: the probe still has to reach the boundary, but the disk
   * cannot decide whether the boundary is what stopped it.
   */
  ENVIRONMENT: 'ENVIRONMENT',
} as const;
export type ContainmentAttribution =
  (typeof ContainmentAttribution)[keyof typeof ContainmentAttribution];

export const ProbePermission = {
  ALLOWED: 'ALLOWED',
  DENIED: 'DENIED',
  NOT_CALLED: 'NOT_CALLED',
} as const;
export type ProbePermission = (typeof ProbePermission)[keyof typeof ProbePermission];

/**
 * One probe, with the facts that decide whether it is evidence at all.
 *
 * `contained` alone was not enough, and the gap it left was the whole point of the
 * exercise. A probe DENIED by the tool permission layer never runs; no forbidden file
 * appears; the disk looks clean; and "clean" was being read as "the sandbox held". Tool
 * denial is not OS containment — it is the absence of a measurement wearing its clothes.
 *
 * So the permission decision and whether the command actually executed are persisted
 * alongside the outcome, and the authoritative record can answer, on its own, "did this
 * probe pass the permission layer and reach the operating system?" without anyone having
 * to consult a console log or trust a sentence in a report.
 */
export interface ProbeObservation {
  readonly id: string;
  /** What the TOOL PERMISSION layer decided. Must be ALLOWED for the probe to mean anything. */
  readonly permission: ProbePermission;
  /** Whether the command actually executed at the OS boundary. */
  readonly reached: boolean;
  /**
   * The independent filesystem check. `undefined` means the disk cannot decide it, which
   * is only acceptable for an ENVIRONMENT-attributed probe.
   */
  readonly contained?: boolean;
  readonly attribution: ContainmentAttribution;
  /** Bounded, for diagnosis. Never load-bearing. */
  readonly outcome?: string;
  /** Why the attribution is what it is, when it is not the sandbox. */
  readonly attributionBasis?: string;
}

export interface PositiveControlObservation {
  readonly id: string;
  readonly permission: ProbePermission;
  readonly reached: boolean;
  readonly passed: boolean;
  readonly outcome?: string;
}

export interface SandboxMeasurement {
  readonly policyDigest: string;
  readonly boundaryFingerprint: string;
  readonly engineVersion: string;
  readonly measuredAt: string;
  /** Controls that had to SUCCEED. A single failure invalidates the whole measurement. */
  readonly positiveControls: readonly PositiveControlObservation[];
  /** Escapes that had to be contained, judged on filesystem truth rather than on claims. */
  readonly containment: readonly ProbeObservation[];
  /** Anything measured but not attributable to the sandbox, recorded rather than claimed. */
  readonly notes: readonly string[];
}

/**
 * THE CONTAINMENT INVARIANT.
 *
 *   OS containment PASS = permission ALLOWED and reached and independently contained.
 *
 * Anything else is not a weaker pass, it is not a measurement:
 *
 *   DENIED / NOT_CALLED     the permission layer answered, the sandbox never did
 *   ALLOWED but not reached the command did not run, so nothing was tested
 *   ALLOWED + reached + escaped        containment FAILED
 *   ALLOWED + reached + contained      containment PASSED
 *
 * An ENVIRONMENT-attributed probe is exempt from the truth requirement ONLY — it must
 * still have been allowed and must still have reached the boundary, and it never counts
 * towards sandbox evidence.
 */
export function containmentRefusal(c: ProbeObservation | undefined): string | undefined {
  if (c === undefined || typeof c !== 'object') return 'MALFORMED_OBSERVATION';
  const id = typeof c.id === 'string' && c.id.length > 0 ? c.id : '(unnamed)';
  if (typeof c.permission !== 'string' || typeof c.reached !== 'boolean') {
    return (
      id +
      ' MALFORMED_OBSERVATION: the record does not say whether the probe was permitted or whether it ran'
    );
  }
  if (c.permission !== ProbePermission.ALLOWED) {
    return (
      id +
      ' PERMISSION_' +
      c.permission +
      ': the tool permission layer answered before the sandbox could, so this probe measured the permission layer and not the OS boundary'
    );
  }
  if (!c.reached) {
    return (
      id +
      ' DID_NOT_REACH_OS_SANDBOX: the command never executed, so the absence of a forbidden artifact says nothing about containment'
    );
  }
  if (c.attribution === ContainmentAttribution.ENVIRONMENT) return undefined;
  if (c.contained === false) return id + ' ESCAPED';
  if (c.contained !== true) {
    return (
      id +
      ' NO_INDEPENDENT_TRUTH: the probe ran but nothing on disk decides whether it was contained'
    );
  }
  return undefined;
}

export const SANDBOX_MEASUREMENT_TYPE = 'sandboxMeasurement';

/**
 * Is this measurement usable, and is it about the policy in hand?
 *
 * "Every positive control passed" comes first and is absolute: if the instrument could
 * not perform an operation that SHOULD work, its denials are not evidence of anything.
 * That was the state of the first cross-check — nine denials, no positive control, and a
 * conclusion drawn from them anyway.
 */
export function measurementRefusal(
  m: SandboxMeasurement | undefined,
  o: {
    readonly policyDigest: string;
    readonly boundaryFingerprint: string;
    readonly engineVersion: string;
  },
): string | undefined {
  if (m === undefined) {
    return 'no OS-sandbox measurement is recorded for this policy, so the sandbox is unproved rather than proved';
  }
  if (m.policyDigest !== o.policyDigest) {
    return (
      'the recorded measurement is of a DIFFERENT sandbox policy (measured ' +
      m.policyDigest.slice(0, 12) +
      ', current ' +
      o.policyDigest.slice(0, 12) +
      '), so it says nothing about the policy this run would use'
    );
  }
  if (m.boundaryFingerprint !== o.boundaryFingerprint) {
    return (
      'the recorded measurement is of a DIFFERENT execution boundary (measured ' +
      m.boundaryFingerprint.slice(0, 12) +
      ', current ' +
      o.boundaryFingerprint.slice(0, 12) +
      ')'
    );
  }
  if (m.engineVersion !== o.engineVersion) {
    return (
      'the recorded measurement was taken against engine ' +
      m.engineVersion +
      ', and this run would use ' +
      o.engineVersion
    );
  }
  if (!Array.isArray(m.positiveControls) || m.positiveControls.length === 0) {
    return 'the measurement recorded no positive controls, so its denials are not evidence of containment';
  }
  const failedControls = m.positiveControls
    .filter((c) => c === undefined || c.passed !== true)
    .map((c) => c?.id ?? '(unnamed)');
  if (failedControls.length > 0) {
    return (
      'positive control(s) ' +
      failedControls.join(', ') +
      ' failed, which makes the whole measurement invalid: an instrument that cannot do what it should cannot be trusted about what it should not'
    );
  }

  if (!Array.isArray(m.containment) || m.containment.length === 0) {
    return 'the measurement recorded no containment probes, so nothing about the OS boundary was tested';
  }
  /*
   * Every containment probe, against the invariant. The first failure is named with its
   * reason, because "the measurement is invalid" is not actionable and "R2
   * DID_NOT_REACH_OS_SANDBOX" is.
   */
  for (const c of m.containment) {
    const bad = containmentRefusal(c);
    if (bad !== undefined) return bad;
  }
  /*
   * ...and at least one probe has to be actual SANDBOX evidence. A measurement whose
   * every probe was attributed to the environment proves the environment, not the
   * sandbox, however many of them there are.
   */
  if (!m.containment.some((c) => c.attribution === ContainmentAttribution.SANDBOX)) {
    return 'no containment probe was attributed to the sandbox, so nothing here is evidence that the SANDBOX contains anything';
  }
  return undefined;
}

/** Which statuses this profile has actually reached, and which it has not. */
export function sandboxProfileStatuses(o: {
  readonly profile: GeneratedSandboxProfile;
  readonly engineVersion: string;
  readonly boundaryFingerprint: string;
  /** True when the file on disk still matches what Serva generated. */
  readonly loaded: boolean;
  /** True when the invocation was actually given this settings file. */
  readonly passedToInvocation: boolean;
  readonly measurement?: SandboxMeasurement;
}): {
  readonly reached: readonly SandboxProfileStatus[];
  readonly missing: readonly SandboxProfileStatus[];
  readonly reasons: readonly string[];
} {
  const reached: SandboxProfileStatus[] = [SandboxProfileStatus.GENERATED];
  const reasons: string[] = [];

  const validation = validateSandboxProfile(o.profile, o.engineVersion);
  if (validation.ok) reached.push(SandboxProfileStatus.VALIDATED);
  else reasons.push(validation.reason ?? 'SANDBOX_PROFILE_REJECTED');

  if (o.loaded) reached.push(SandboxProfileStatus.LOADED);
  else reasons.push('the settings file Serva generated is not on disk unchanged');

  if (o.passedToInvocation) reached.push(SandboxProfileStatus.EFFECTIVE);
  else reasons.push('the invocation was not given this settings file');

  const refusal = measurementRefusal(o.measurement, {
    policyDigest: o.profile.policyDigest,
    boundaryFingerprint: o.boundaryFingerprint,
    engineVersion: o.engineVersion,
  });
  if (refusal === undefined) reached.push(SandboxProfileStatus.MEASURED);
  else reasons.push(refusal);

  return {
    reached,
    missing: SANDBOX_STATUS_ORDER.filter((x) => !reached.includes(x)),
    reasons,
  };
}

export interface SandboxValidation {
  readonly ok: boolean;
  /** Every key Serva would have emitted that the engine is not known to accept. */
  readonly rejected: readonly string[];
  readonly reason?: string;
}

function versionAtLeast(actual: string, required: string): boolean {
  const a = actual.split('.').map((n) => Number.parseInt(n, 10));
  const b = required.split('.').map((n) => Number.parseInt(n, 10));
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (Number.isNaN(x) || Number.isNaN(y)) return false;
    if (x !== y) return x > y;
  }
  return true;
}

/** Every leaf path in an object, dotted. */
function leafPaths(value: unknown, prefix: string): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [prefix];
  const out: string[] = [];
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out.push(...leafPaths(v, prefix === '' ? k : prefix + '.' + k));
  }
  return out;
}

/**
 * Would the engine accept every key in this profile?
 *
 * Fail-closed and deterministic: no model call, no network. A key Serva does not know
 * the engine accepts is BLOCKING, because the observed consequence of emitting one is
 * not "that key is ignored" — it is "the whole file is ignored", silently, leaving a
 * Producer running under default policy while Serva believes its profile is in force.
 */
export function validateSandboxProfile(
  profile: GeneratedSandboxProfile,
  engineVersion: string,
): SandboxValidation {
  const supported = new Map(SUPPORTED_SANDBOX_KEYS.map((k) => [k.path, k]));
  const rejected: string[] = [];

  for (const leaf of leafPaths(profile.settings, '')) {
    // Array and object members collapse to their declaring key: the schema governs
    // `filesystem.allowWrite`, not `filesystem.allowWrite.0`.
    const key = [...supported.keys()]
      .filter((k) => leaf === k || leaf.startsWith(k + '.'))
      .sort((a, b) => b.length - a.length)[0];
    if (key === undefined) {
      rejected.push(leaf);
      continue;
    }
    const spec = supported.get(key)!;
    if (spec.since !== undefined && !versionAtLeast(engineVersion, spec.since)) {
      rejected.push(leaf + ' (requires engine >= ' + spec.since + ', found ' + engineVersion + ')');
    }
  }

  if (rejected.length > 0) {
    return {
      ok: false,
      rejected,
      reason:
        'SANDBOX_PROFILE_REJECTED: the profile carries ' +
        String(rejected.length) +
        ' setting(s) this engine is not known to accept (' +
        rejected.slice(0, 6).join(', ') +
        '). A settings file that fails validation is silently ignored, so emitting one would leave the Producer running under default policy while Serva recorded a boundary that was never in force.',
    };
  }
  return { ok: true, rejected: [] };
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
