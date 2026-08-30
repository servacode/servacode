import { GuestReach } from './transport.js';
import type { TransportAttempt } from './transport.js';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson, digestOf } from '../core/hash.js';
import { EnforcementClass } from '../vocab/index.js';
import {
  EnforcementState,
  ExecutionAvailability,
  IsolationMethod,
  NotRunReason,
  QualificationAttempt,
  deriveEnforcementClass,
  type ExecuteRequest,
  type ExecuteResult,
  type ExecutionSubstrate,
  type AnyPrerequisite,
  guestPrerequisite,
  localPrerequisite,
  unreachedPrerequisite,
  type QualificationResult,
  type SubstrateCapabilities,
  type SubstrateProbe,
  type SubstrateQualification,
} from './types.js';
import { QUALIFICATION_CASES } from './qualification.js';
import {
  GUEST_PATH,
  TransportKind,
  resolveGuestBinary,
  type GuestBinaryLookup,
  type ExecTransport,
  type TransportCommand,
} from './transport.js';
import { executionBoundary, type BoundaryPurpose, type ExecutionBoundary } from './boundary.js';
import type { SandboxLauncher, SandboxSpec } from './sandboxLauncher.js';
import type { Clock } from '../core/clock.js';

/**
 * A substrate that actually contains, actually qualifies, and actually executes.
 *
 * SPEC: Phase 4 closure blocker 1, ADR-003.
 *
 * The implementation this replaces could never become HARD. It reported prerequisites,
 * and then — even with every one of them satisfied — returned Q-A…Q-K as NOT_RUN with
 * "no qualified sandbox executor is wired for this platform", and refused every
 * `execute()`. Installing the listed packages would not have changed the outcome. A
 * refusal that no amount of work can lift is not a fail-closed boundary; it is an
 * unimplemented feature wearing one.
 *
 * The path is now real and complete:
 *
 *   prerequisites detected -> Q-A…Q-K RUN through execute() -> HARD derived from what
 *   they proved -> execute() runs Producer commands through the SAME boundary
 *
 * Three properties hold by construction:
 *
 *   - **Qualification uses the production path.** Every adversarial case goes through
 *     `this.execute()`, so the thing that was measured is the thing that later runs. A
 *     suite that exercised a separate code path would prove nothing about the one that
 *     matters.
 *   - **HARD is never configured.** There is no option, flag or constructor argument
 *     that sets the enforcement class. It comes from `deriveEnforcementClass` over
 *     observed outcomes, and a NOT_RUN blocking case counts exactly as a failure.
 *   - **A broken assumption fails closed.** The launcher's argv template, the
 *     transport's argument fidelity, the guest's toolchain: each is asserted by the
 *     suite rather than trusted, and each failure mode ends in "not HARD".
 */

export interface SandboxedSubstrateOptions {
  readonly transport: ExecTransport;
  readonly launcher: SandboxLauncher;
  readonly clock: Clock;
  readonly engineVersion: string;
  /** The owner's checkout. Never writable, and its store is masked. */
  readonly projectRoot: string;
  /** Absolute host paths masked on every run: credentials and other runs' prompts. */
  readonly alwaysDenyRead?: readonly string[];
  /** Minimum engine version this qualification was written against. */
  readonly minEngineVersion?: string;
  /**
   * What this boundary is FOR, and what it is called.
   *
   * A Producer boundary and a recipe boundary have different mechanisms and therefore
   * different prerequisites. Mixing the two lists was how `socat` and the syscall filter
   * came to be required by a launcher that never used them — a prerequisite counted
   * because it existed on disk rather than because it participated.
   */
  readonly purpose: BoundaryPurpose;
  readonly boundaryId: string;
  /** Binaries this boundary genuinely needs. Defaults to the recipe set. */
  readonly requiredBinaries?: readonly GuestBinary[];
  /** True when this boundary hosts the engine itself, which must then be present. */
  readonly requiresEngine?: boolean;
  /** Extra prerequisites established by the caller, e.g. guest auth. */
  readonly extraPrerequisites?: readonly AnyPrerequisite[];
  /** Digest of the sandbox settings profile this boundary is measured under. */
  readonly profileDigest?: string;
}

/** The guest did not answer. Distinct from a file that is genuinely not there. */
const UNREACHED = Symbol('guest not reached');

export interface GuestBinary {
  readonly bin: string;
  readonly why: string;
  readonly remedy: string;
}

/**
 * Binaries Serva's own DETERMINISTIC RECIPE boundary needs.
 *
 * Note what is absent: `socat` and the syscall filter. Neither is used by bubblewrap as
 * Serva invokes it, so requiring them here would be requiring something that does not
 * participate. They belong to the Producer boundary, where they do.
 */
export const RECIPE_REQUIRED_BINARIES: readonly GuestBinary[] = Object.freeze([
  {
    bin: 'node',
    why: 'The qualification programs and every Node recipe run inside the guest. A Node resolving under /mnt/ is the Windows binary reached through interop, which is not the same thing.',
    remedy: 'Install Node.js inside the distribution using its package manager.',
  },
  {
    bin: 'git',
    why: 'Serva computes every ChangeSet with git, inside the same environment the change was made in.',
    remedy: 'Install git inside the distribution.',
  },
  {
    bin: 'bwrap',
    why: 'bubblewrap is what enforces filesystem isolation; without it there is no boundary to measure.',
    remedy: 'sudo apt-get install bubblewrap',
  },
]);

/**
 * Binaries the PRODUCER boundary needs — the engine's own sandbox.
 *
 * `socat` is here rather than in the recipe list because this is where it is actually
 * used: the sandbox's network proxy relays through it, and without it the sandbox does
 * not start. That failure shows up as Q-A failing, so the requirement is measured
 * rather than merely declared.
 */
export const PRODUCER_REQUIRED_BINARIES: readonly GuestBinary[] = Object.freeze([
  ...RECIPE_REQUIRED_BINARIES,
  {
    bin: 'socat',
    why: 'The engine sandbox relays traffic through a proxy that needs socat; without it the sandbox does not start at all.',
    remedy: 'sudo apt-get install socat',
  },
]);

/** Kept for callers that want the recipe list under its old name. */
export const GUEST_REQUIRED_BINARIES = RECIPE_REQUIRED_BINARIES;

/**
 * The seccomp filter package, for readers tracing where the sandbox comes from.
 *
 * Informational: detection happens against what the guest reports, not against this name, so
 * nothing here refuses anything. It says so plainly rather than implying a check it does not
 * perform.
 */
export const SECCOMP_PACKAGE = '@anthropic-ai/sandbox-runtime';

interface CaseProgram {
  readonly id: string;
  /** JavaScript run inside the sandbox. Exit 0 means THE ATTEMPT SUCCEEDED. */
  readonly source: string;
  /** True when a HARD substrate should let the attempt succeed. Only Q-A. */
  readonly expectSuccess: boolean;
  readonly network?: boolean;
}

/**
 * The qualification fixture, in BOTH conventions.
 *
 * `host` paths are what `execute()` takes — it is the single place translation happens,
 * and every caller hands it host paths, production and qualification alike. `guest`
 * paths are interpolated into the adversarial programs, which run inside and can only
 * name what the guest sees.
 *
 * Keeping one convention per boundary is not tidiness. When qualification passed guest
 * paths to `execute()` and production passed host paths, an existence check meant to
 * skip a missing mask silently skipped every real one, and both boundaries quietly
 * dropped from HARD to SOFT.
 */
interface FixturePaths {
  readonly root: string;
  readonly worktree: string;
  readonly checkout: string;
  readonly outside: string;
  readonly serva: string;
  readonly otherRun: string;
}

interface FixtureLayout {
  readonly host: FixturePaths;
  readonly guest: FixturePaths;
}

const q = (s: string): string => JSON.stringify(s);

/**
 * The adversarial programs.
 *
 * Written to files with their paths already interpolated, rather than passed as `node
 * -e` with arguments. `wsl.exe` re-parses a Windows command line, so every quoted
 * script and every argument containing a space is a fidelity risk on that boundary;
 * a file path is one token and a program that reads its own constants has none.
 */
function programs(f: FixturePaths, kind: TransportKind): CaseProgram[] {
  const fsHead = 'const fs = require("fs");\n';
  return [
    {
      id: 'Q-A',
      expectSuccess: true,
      source: fsHead + 'fs.writeFileSync(' + q(f.worktree + '/qa.txt') + ', "ok");\n',
    },
    {
      id: 'Q-B',
      expectSuccess: false,
      source: fsHead + 'fs.writeFileSync(' + q(f.checkout + '/qb.txt') + ', "escaped");\n',
    },
    {
      id: 'Q-C',
      expectSuccess: false,
      source: fsHead + 'fs.writeFileSync(' + q(f.outside + '/qc.txt') + ', "escaped");\n',
    },
    {
      id: 'Q-D',
      expectSuccess: false,
      source:
        fsHead +
        'const d = fs.readFileSync(' +
        q(f.serva + '/secret.txt') +
        ', "utf8");\n' +
        'if (d.length === 0) process.exit(3);\n',
    },
    {
      id: 'Q-E',
      expectSuccess: false,
      source:
        fsHead +
        'const d = fs.readFileSync(' +
        q(f.otherRun + '/prompt.txt') +
        ', "utf8");\n' +
        'if (d.length === 0) process.exit(3);\n',
    },
    {
      id: 'Q-F',
      expectSuccess: false,
      source:
        'const { execFileSync } = require("child_process");\n' +
        '// A CHILD process, which tool-level rules cannot reach at all.\n' +
        'execFileSync(process.execPath, ["-e",\n' +
        '  "require(\'fs\').writeFileSync(" + ' +
        q(JSON.stringify(f.outside + '/qf.txt')) +
        ' + ", \'escaped\')"\n' +
        '], { stdio: "ignore" });\n',
    },
    {
      id: 'Q-G',
      expectSuccess: false,
      source:
        fsHead +
        'const link = ' +
        q(f.worktree + '/escape-link') +
        ';\n' +
        'try { fs.symlinkSync(' +
        q(f.outside) +
        ', link); } catch (e) { process.exit(4); }\n' +
        'fs.writeFileSync(link + "/qg.txt", "escaped");\n',
    },
    {
      id: 'Q-H',
      expectSuccess: false,
      source: fsHead + 'fs.writeFileSync(' + q(f.worktree + '/../qh.txt') + ', "escaped");\n',
    },
    {
      id: 'Q-I',
      expectSuccess: false,
      source:
        'const net = require("net");\n' +
        'const s = net.connect({ host: "1.1.1.1", port: 443 });\n' +
        's.setTimeout(4000);\n' +
        's.on("connect", () => { s.destroy(); process.exit(0); });\n' +
        's.on("timeout", () => { s.destroy(); process.exit(5); });\n' +
        's.on("error", () => process.exit(6));\n',
    },
    {
      id: 'Q-J',
      expectSuccess: false,
      source:
        kind === TransportKind.WSL2
          ? 'const { execFileSync } = require("child_process");\n' +
            'const candidates = ["/mnt/c/Windows/System32/cmd.exe", "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"];\n' +
            'for (const c of candidates) {\n' +
            '  try { execFileSync(c, ["/c", "ver"], { stdio: "ignore", timeout: 8000 }); process.exit(0); } catch (e) { /* keep trying */ }\n' +
            '}\n' +
            'process.exit(7);\n'
          : 'const fs = require("fs");\n' +
            '// No interop channel should exist on a native POSIX transport. Measured,\n' +
            '// not assumed: if one is present the case must fail like any other escape.\n' +
            'const channels = ["/proc/sys/fs/binfmt_misc/WSLInterop", "/mnt/c/Windows/System32/cmd.exe"];\n' +
            'if (channels.some((p) => fs.existsSync(p))) process.exit(0);\n' +
            'process.exit(8);\n',
    },
  ];
}

export class SandboxedExecutionSubstrate implements ExecutionSubstrate {
  readonly id: string;
  /** Every transport invocation, so Q-K can prove there was no unsandboxed retry. */
  private transportCalls = 0;
  /** Filled by `probe`, so the boundary identity records what was actually found. */
  private engineLocation: string | undefined;
  private launcherVersion: string | undefined;

  constructor(private readonly opts: SandboxedSubstrateOptions) {
    this.id = 'sandboxed:' + opts.transport.id;
  }

  /* ------------------------------------------------------------------ probe */

  async probe(): Promise<SubstrateProbe> {
    const t = this.opts.transport;
    const observations: Record<string, string> = {
      hostPlatform: process.platform,
      hostArch: process.arch,
      transport: t.id,
      transportKind: t.kind,
      engineVersion: this.opts.engineVersion,
    };
    const prerequisites: AnyPrerequisite[] = [];

    for (const [k, v] of Object.entries(await t.fingerprint())) {
      observations['transport:' + k] = v;
    }

    // Binaries. A path under /mnt/ is the Windows executable reached through interop,
    // and counting it would qualify the substrate on the strength of the very escape
    // route the qualification exists to close.
    for (const req of this.opts.requiredBinaries ?? RECIPE_REQUIRED_BINARIES) {
      const found = await this.which(req.bin);
      const usable =
        found.reach === GuestReach.REACHED &&
        found.path !== undefined &&
        !found.path.startsWith('/mnt/');
      /*
       * UNREACHED IS NOT MISSING.
       *
       * SPEC: finding QUALIFICATION-TRANSPORT-SEMANTICS/QTS-A.
       *
       * `which` returned `string | undefined` and both "the guest says no" and "the guest
       * never answered" arrived as `undefined`. The observation read MISSING either way, and
       * the branch below turned that into a MEASURED qualification of a machine nothing had
       * measured. The two are now distinguishable in the record and in the decision.
       */
      observations['bin:' + req.bin] =
        found.reach === GuestReach.REACHED ? (found.path ?? 'MISSING') : 'NOT_REACHED';
      prerequisites.push(
        guestPrerequisite({
          id: 'GUEST_' + req.bin.toUpperCase(),
          what: req.bin + ' inside the execution environment',
          why: req.why,
          remedy: req.remedy,
          satisfied: usable,
          reach: found.reach,
        }),
      );
    }

    let engineBin: string | undefined;
    if (this.opts.requiresEngine === true) {
      const claude = await this.which('claude');
      engineBin = claude.reach === GuestReach.REACHED ? claude.path : undefined;
      observations['bin:claude'] =
        claude.reach === GuestReach.REACHED ? (claude.path ?? 'MISSING') : 'NOT_REACHED';
      prerequisites.push(
        guestPrerequisite({
          id: 'GUEST_ENGINE',
          what: 'Claude Code installed where the sandbox runs',
          why: 'The engine must run inside the boundary. An install on the other side of the transport cannot be contained by it.',
          remedy: 'Install Claude Code in the execution environment.',
          satisfied: engineBin !== undefined && !engineBin.startsWith('/mnt/'),
          reach: claude.reach,
        }),
      );
    }

    /*
     * There is deliberately no standalone "is the syscall filter installed?" checkbox
     * any more.
     *
     * It was detected and then never used by the launcher, so a machine could satisfy
     * it while the boundary it was supposed to strengthen did not involve it at all.
     * On the Producer boundary the filter IS the launcher, so its detection below is
     * the same fact — and Q-J measures whether the escape it exists to close is closed.
     * Presence has stopped standing in for enforcement.
     */

    const launcher = await this.opts.launcher.detect(t);
    observations['launcher'] = this.opts.launcher.id;
    observations['launcher:detail'] = launcher.detail;
    for (const [k, v] of Object.entries(launcher.observations)) observations[k] = v;
    for (const extra of this.opts.extraPrerequisites ?? []) prerequisites.push(extra);
    prerequisites.push(
      guestPrerequisite({
        id: 'SANDBOX_LAUNCHER',
        what: 'A working sandbox launcher (' + this.opts.launcher.id + ')',
        why: 'It is the mechanism that contains a process. Without it nothing above can be measured, let alone enforced.',
        remedy: launcher.remedy ?? 'Install the launcher in the execution environment.',
        satisfied: launcher.available,
        reach: launcher.reach,
      }),
    );

    // Unprivileged user namespaces: bubblewrap cannot create its namespaces without
    // them, and Ubuntu 24.04+ restricts them by AppArmor policy.
    const userns = await this.readGuestFile(
      '/proc/sys/kernel/apparmor_restrict_unprivileged_userns',
    );
    const usernsValue = userns === UNREACHED ? 'NOT_REACHED' : (userns?.trim() ?? 'unset');
    observations['kernel:apparmor_userns'] = usernsValue;
    prerequisites.push(
      guestPrerequisite({
        id: 'USER_NAMESPACES',
        what: 'Unprivileged user namespaces available to the launcher',
        why: 'bubblewrap builds its boundary out of them; a policy that restricts them stops the sandbox starting at all.',
        remedy: 'Add an AppArmor profile granting bwrap userns capability, or set the sysctl to 0.',
        satisfied: usernsValue === 'unset' || usernsValue === '0',
        reach: userns === UNREACHED ? GuestReach.NOT_REACHED : GuestReach.REACHED,
      }),
    );

    /*
     * The engine version is a PRODUCER prerequisite only.
     *
     * The recipe boundary is bubblewrap running `npm test`; no engine is involved, so
     * requiring a Claude version there is the same mistake as requiring socat for a
     * launcher that never uses it — a prerequisite that cannot affect the thing it
     * gates.
     */
    if (this.opts.minEngineVersion !== undefined && this.opts.requiresEngine === true) {
      /*
       * An unparseable version is NOT a pass.
       *
       * `compareVersions` returns 0 for anything it cannot read, so `'UNKNOWN' >= min`
       * was true and the prerequisite reported satisfied for an engine whose version
       * nobody had established. "We could not tell" and "it is new enough" are
       * different facts, and only one of them is a reason to proceed.
       */
      const parseable = /^\d+\.\d+/.test(this.opts.engineVersion);
      const ok =
        parseable && compareVersions(this.opts.engineVersion, this.opts.minEngineVersion) >= 0;
      prerequisites.push(
        localPrerequisite({
          id: 'ENGINE_VERSION',
          what: 'Claude Code >= ' + this.opts.minEngineVersion,
          why:
            'Sandbox behaviour is version-dependent, and a qualification measured against one version does not carry to another.' +
            (parseable
              ? ''
              : ' The reported version is "' +
                this.opts.engineVersion +
                '", which Serva could not read at all.'),
          remedy: parseable
            ? 'Update Claude Code.'
            : 'Make `claude --version` answer in the execution environment; an unreadable version is not a version.',
          satisfied: ok,
        }),
      );
    }

    const interop = await this.readGuestFile('/proc/sys/fs/binfmt_misc/WSLInterop');
    observations['guest:interop'] =
      interop === UNREACHED ? 'NOT_REACHED' : interop === undefined ? 'absent' : 'present';

    this.engineLocation = engineBin;
    this.launcherVersion = launcher.version;

    return {
      substrateId: this.id,
      hostPlatform: process.platform,
      hostArch: process.arch,
      ...(observations['transport:guestOs'] === undefined
        ? {}
        : { guestPlatform: observations['transport:guestOs'] }),
      isolationMethod:
        this.opts.launcher.id === 'bubblewrap' || this.opts.launcher.id === 'claude-sandbox-runtime'
          ? IsolationMethod.BUBBLEWRAP
          : IsolationMethod.NONE,
      engineVersion: this.opts.engineVersion,
      ...(launcher.version === undefined ? {} : { sandboxVersion: launcher.version }),
      prerequisites,
      observations,
      probedAt: this.opts.clock.now(),
    };
  }

  private async which(bin: string): Promise<GuestBinaryLookup> {
    return resolveGuestBinary(this.opts.transport, bin);
  }

  private async readGuestFile(path: string): Promise<string | undefined | typeof UNREACHED> {
    const r = await this.opts.transport.run({
      executable: '/bin/cat',
      args: [path],
      cwd: '/',
      env: { PATH: GUEST_PATH },
      timeoutMs: 15_000,
      maxOutputBytes: 20_000,
    });
    /*
     * UNREACHED IS NOT ABSENT — the same distinction as `resolveGuestBinary`.
     *
     * SPEC: finding QUALIFICATION-TRANSPORT-SEMANTICS/QTS-A, sibling path.
     *
     * These reads feed the machine FINGERPRINT rather than the enforcement decision, so a
     * transport blip here grants no authority — but it would record `absent` where the truth
     * is `present`, and a fingerprint that moves because the transport hiccuped reads as "the
     * machine changed". Unreached is now its own value, so the digest can treat it as
     * unmeasured rather than as a fact about the guest.
     */
    if (r.spawnFailed || r.reach !== GuestReach.REACHED) return UNREACHED;
    if (r.exitCode !== 0) return undefined;
    return r.stdout.replace(/\0/g, '');
  }

  /* -------------------------------------------------------------- execute */

  /**
   * Run one command inside the boundary.
   *
   * Refuses rather than falling back. There is no branch here that runs the command
   * unwrapped: if the launcher is unavailable the answer is a refusal, which is what
   * `failIfUnavailable` means when it is a property of the code rather than a setting.
   */
  async execute(request: ExecuteRequest): Promise<ExecuteResult> {
    const startedAt = this.opts.clock.now();
    const began = Date.now();
    const refuse = (reason: string): ExecuteResult => ({
      exitCode: null,
      stdout: '',
      stderr: '',
      timedOut: false,
      truncated: { stdout: false, stderr: false },
      startedAt,
      endedAt: this.opts.clock.now(),
      durationMs: Date.now() - began,
      refusedBySubstrate: true,
      refusalReason: reason,
      /*
       * Serva refused before anything left this machine. Nothing reached the guest, and the
       * reason is Serva's own policy rather than a transport failure — so this must not be
       * retried and must not be reported as "could not measure".
       */
      reach: GuestReach.NOT_REACHED,
    });

    const detection = await this.opts.launcher.detect(this.opts.transport);
    if (!detection.available) {
      return refuse(
        'The sandbox launcher is not available, and Serva does not run a Producer command outside a boundary: ' +
          detection.detail,
      );
    }

    if (request.writeScope.length === 0) {
      return refuse(
        'No write scope was granted. A command with nothing to write is a configuration error, not a boundary.',
      );
    }

    const t = this.opts.transport;

    /*
     * Resolve the executable to an absolute path in the execution environment, and
     * refuse anything that resolves under /mnt/.
     *
     * Two reasons, and the second is a containment property rather than a convenience.
     * First, a scrubbed environment cannot resolve a bare name — the same trap that
     * made every binary probe report MISSING. Second, a `node` that resolves to
     * `/mnt/c/Program Files/nodejs/node` is the WINDOWS binary reached through interop:
     * running it would leave the guest entirely, which is precisely the escape the
     * qualification exists to close. It is refused here as well as measured by Q-J,
     * because a boundary with one check is a boundary with one bug.
     */
    const resolved = await resolveGuestBinary(t, request.executable);
    if (resolved === undefined) {
      return refuse(
        'The executable `' +
          request.executable +
          '` could not be resolved in the execution environment, so nothing was run.',
      );
    }
    const resolvedPath = resolved.path;
    if (resolvedPath === undefined) {
      return refuse(
        'The executable `' +
          request.executable +
          '` could not be resolved in the execution environment, so nothing was run.',
      );
    }
    if (resolvedPath.startsWith('/mnt/')) {
      return refuse(
        '`' +
          request.executable +
          '` resolves to ' +
          resolved +
          ', which is a host binary reached through interop rather than a program inside the boundary.',
      );
    }

    const guestCwd = t.toGuestPath(request.cwd);
    const spec: SandboxSpec = {
      allowWrite: request.writeScope.map((p) => t.toGuestPath(p)),
      allowRead: [
        ...(request.readScope ?? []).map((p) => t.toGuestPath(p)),
        ...request.writeScope.map((p) => t.toGuestPath(p)),
      ],
      /*
       * Only mask paths that EXIST.
       *
       * bubblewrap has to create a mount point before it can put a tmpfs there, and
       * everything is read-only by default, so `--tmpfs` on a path that is not there
       * fails the whole sandbox: `Can't mkdir …: Read-only file system`. The command
       * then dies for a reason that has nothing to do with what it tried to do.
       *
       * Skipping them costs nothing. A directory that does not exist has no contents
       * to leak, and if a command creates one it lands inside the write scope, which is
       * the only place it is allowed to create anything.
       */
      denyRead: [...(request.denyRead ?? []), ...(this.opts.alwaysDenyRead ?? [])]
        .filter((p) => existsSync(p))
        .map((p) => t.toGuestPath(p)),
      networkAllowed: request.networkAllowed,
    };

    const command: TransportCommand = {
      executable: resolvedPath,
      args: [...request.args],
      cwd: guestCwd,
      // Translated for the execution environment, exactly as the paths are. A recipe's
      // environment policy scrubs the HOST environment; handing those values to a guest
      // process is how `PATH` became a Windows path inside Linux.
      env: t.environmentFor(request.env),
      timeoutMs: request.timeoutMs,
      maxOutputBytes: request.maxOutputBytes,
    };

    /*
     * ONE logical invocation, whatever the transport does internally.
     *
     * `WslTransport.run` retries an attempt that never reached the guest, and that retry is
     * deliberately invisible here: Q-K counts invocations to prove Serva does not re-run a
     * REFUSED command outside its boundary, and a transport reconnecting before the command
     * ever ran is a different thing entirely. The distinction is exactly `reach`.
     */
    this.transportCalls += 1;
    const r = await t.run(this.opts.launcher.wrap(command, spec));

    /*
     * A command that violated the boundary is NOT retried. There is deliberately no
     * code below this line: the result is returned exactly as observed, whatever it
     * was. Q-K asserts the absence by counting transport invocations, because a rule
     * that only exists in a comment is not a rule.
     */
    return {
      exitCode: r.exitCode,
      stdout: r.stdout,
      stderr: r.stderr,
      timedOut: r.timedOut,
      truncated: r.truncated,
      startedAt,
      endedAt: this.opts.clock.now(),
      durationMs: Date.now() - began,
      refusedBySubstrate: false,
      reach: r.reach,
      transportAttempts: r.attempts,
    };
  }

  /* ------------------------------------------------------------- qualify */

  async qualify(fixtureDir: string): Promise<SubstrateQualification> {
    const probe = await this.probe();
    const at = this.opts.clock.now();
    const identity = await this.fingerprintOf(probe);
    const fingerprint = identity.digest;
    const missing = probe.prerequisites.filter((p) => !p.satisfied);

    /*
     * A PREREQUISITE NOBODY COULD ASK ABOUT IS NOT A MISSING PREREQUISITE.
     *
     * SPEC: finding QUALIFICATION-TRANSPORT-SEMANTICS/QTS-A.
     *
     * This branch hard-coded `attempt: MEASURED` with a comment saying Serva had looked and
     * the prerequisite was genuinely absent. That is true only when the guest ANSWERED. On an
     * intermittent transport failure the probe reported MISSING, this branch recorded a
     * measured NONE, and `recordQualification` overwrote a preserved HARD with it — the exact
     * regression the qualification record documents itself as preventing.
     */
    const unreached = missing.filter(unreachedPrerequisite);

    if (unreached.length > 0) {
      const reason =
        'TRANSPORT_FAILURE: the guest could not be reached to check ' +
        unreached.map((p) => p.id).join(', ');
      return {
        probe,
        capabilities: unenforced(),
        tests: QUALIFICATION_CASES.map((c) => ({
          id: c.id,
          title: c.title,
          expectation: c.expectation,
          outcome: 'NOT_RUN' as const,
          detail: 'Not attempted: ' + reason,
          blocking: c.blocking,
          at,
          reachedGuest: GuestReach.NOT_REACHED,
          notRunReason: NotRunReason.TRANSPORT_FAILURE,
        })),
        enforcementClass: EnforcementClass.NONE,
        /* NOT_MEASURED, so nothing here may overwrite a stored qualification. */
        attempt: QualificationAttempt.NOT_MEASURED,
        availability: ExecutionAvailability.UNREACHABLE,
        blockedBy: reason,
        qualifiedAt: at,
        fingerprint,
        fingerprintComplete: identity.complete,
        fingerprintUnmeasured: identity.unmeasured,
        engineVersion: this.opts.engineVersion,
        boundary: this.boundaryOf(probe),
      };
    }

    if (missing.length > 0) {
      const reason =
        'PLATFORM_PREREQUISITE_REQUIRED: ' +
        missing.map((p) => p.id + ' (' + p.what + ')').join(', ');
      return {
        probe,
        capabilities: unenforced(),
        tests: QUALIFICATION_CASES.map((c) => ({
          id: c.id,
          title: c.title,
          expectation: c.expectation,
          outcome: 'NOT_RUN' as const,
          detail: 'Not attempted: ' + reason,
          blocking: c.blocking,
          at,
          reachedGuest: GuestReach.NOT_REACHED,
          /*
           * A MEASURED reason, not a transport one. Serva looked, and a prerequisite this
           * machine needs is genuinely absent — so this is a fact about the machine and must
           * not be retried or reported as "could not measure".
           */
          notRunReason: NotRunReason.PREREQUISITE_MISSING,
        })),
        enforcementClass: EnforcementClass.NONE,
        attempt: QualificationAttempt.MEASURED,
        availability: ExecutionAvailability.UNKNOWN,
        blockedBy: reason,
        qualifiedAt: at,
        engineVersion: this.opts.engineVersion,
        fingerprint,
        fingerprintComplete: identity.complete,
        fingerprintUnmeasured: identity.unmeasured,
        boundary: this.boundaryOf(probe),
      };
    }

    const layout = this.materialiseFixture(fixtureDir);
    const results = new Map<string, QualificationResult>();
    const record = (
      id: string,
      outcome: QualificationResult['outcome'],
      detail: string,
      evidence: {
        readonly reachedGuest?: GuestReach;
        readonly notRunReason?: NotRunReason;
        readonly transportAttempts?: readonly TransportAttempt[];
      } = {},
    ): void => {
      const c = QUALIFICATION_CASES.find((x) => x.id === id)!;
      results.set(id, {
        id,
        title: c.title,
        expectation: c.expectation,
        outcome,
        detail,
        blocking: c.blocking,
        at: this.opts.clock.now(),
        /*
         * Defaults to UNKNOWN rather than REACHED. A caller that forgets to say gets the
         * answer that grants nothing, which is the only safe direction for this field: an
         * unproved REACHED is exactly the assumption that made a WSL outage look like a
         * containment failure.
         */
        reachedGuest: evidence.reachedGuest ?? GuestReach.UNKNOWN,
        ...(evidence.notRunReason === undefined ? {} : { notRunReason: evidence.notRunReason }),
        ...(evidence.transportAttempts === undefined
          ? {}
          : { transportAttempts: evidence.transportAttempts }),
      });
    };

    for (const program of programs(layout.guest, this.opts.transport.kind)) {
      /*
       * `.cjs`, NOT `.js`.
       *
       * SPEC: Phase 6 final acceptance sequence §2.
       *
       * These probes are CommonJS and they are written INSIDE the project being qualified. A
       * project whose `package.json` declares `"type": "module"` makes Node read every `.js`
       * as an ES module, so `require` is undefined, Q-A dies on its first line, and the
       * substrate reports NONE — telling an owner their machine has no boundary when the
       * machine is fine and their project merely uses ESM.
       *
       * Serva's own repository is such a project, which is how the live acceptance found it.
       * The extension pins the module system regardless of what the host package says.
       */
      const scriptHost = join(fixtureDir, 'programs', program.id + '.cjs');
      writeFileSync(scriptHost, program.source, 'utf8');
      const scriptGuest = this.opts.transport.toGuestPath(scriptHost);

      const result = await this.execute({
        executable: 'node',
        args: [scriptGuest],
        // Host paths: `execute` is the one place translation happens.
        cwd: layout.host.worktree,
        env: { PATH: GUEST_PATH },
        timeoutMs: 60_000,
        maxOutputBytes: 200_000,
        writeScope: [layout.host.worktree],
        // The fixture root must be readable or the program cannot be loaded; the
        // masked subtrees below are re-masked after the grant, so deny still wins.
        readScope: [layout.host.root],
        denyRead: [layout.host.serva, layout.host.otherRun],
        networkAllowed: program.network === true,
      });

      if (result.refusedBySubstrate) {
        // A refusal is not a proof of containment for the negative cases: nothing ran,
        // so nothing was demonstrated.
        record(program.id, 'NOT_RUN', 'Substrate refused to execute: ' + result.refusalReason, {
          reachedGuest: GuestReach.NOT_REACHED,
          notRunReason: NotRunReason.SUBSTRATE_REFUSED,
          ...(result.transportAttempts === undefined
            ? {}
            : { transportAttempts: result.transportAttempts }),
        });
        continue;
      }

      /*
       * THE COMMAND NEVER REACHED THE GUEST.
       *
       * This is the case that made qualification nondeterministic. `wsl.exe` returns exit
       * 4294967295 with no output when the transport fails, and without `reach` the line
       * below read that as `Q-A FAILED: the permitted write was REFUSED` — a measured
       * containment finding, from a command that never ran. The same machine then reported
       * HARD, SOFT and NONE on three consecutive runs.
       *
       * The transport has already retried; arriving here means it failed every time.
       */
      if (result.reach !== GuestReach.REACHED) {
        record(
          program.id,
          'NOT_RUN',
          'The command never reached the execution environment after ' +
            String(result.transportAttempts?.length ?? 0) +
            ' attempt(s), so nothing about this machine was measured: ' +
            (result.transportAttempts?.[result.transportAttempts.length - 1]?.detail ??
              'no attempt was recorded'),
          {
            reachedGuest: result.reach,
            notRunReason: NotRunReason.TRANSPORT_FAILURE,
            ...(result.transportAttempts === undefined
              ? {}
              : { transportAttempts: result.transportAttempts }),
          },
        );
        continue;
      }

      const attemptSucceeded = result.exitCode === 0 && !result.timedOut;
      const passed = program.expectSuccess ? attemptSucceeded : !attemptSucceeded;
      const observed =
        'exit ' +
        String(result.exitCode) +
        (result.timedOut ? ' (timed out)' : '') +
        (result.stderr.trim().length > 0 ? ': ' + result.stderr.trim().slice(0, 240) : '');
      record(
        program.id,
        passed ? 'PASSED' : 'FAILED',
        (program.expectSuccess
          ? passed
            ? 'The permitted write succeeded, so the boundary is not simply refusing everything. '
            : 'The permitted write was REFUSED, so this boundary would stop a Producer working. '
          : passed
            ? 'The attempt was refused, as required. '
            : 'THE ATTEMPT SUCCEEDED — the boundary did not hold. ') + observed,
      );
    }

    await this.qualifyNoUnsandboxedRetry(layout, record);

    const tests = QUALIFICATION_CASES.map(
      (c) =>
        results.get(c.id) ?? {
          id: c.id,
          title: c.title,
          expectation: c.expectation,
          outcome: 'NOT_RUN' as const,
          detail: 'No program is defined for this case, so nothing was proved.',
          blocking: c.blocking,
          at,
          reachedGuest: GuestReach.NOT_REACHED,
          /* Serva's own gap. Retrying it would never help, so it is not a transport failure. */
          notRunReason: NotRunReason.PREREQUISITE_MISSING,
        },
    );

    const capabilities = capabilitiesFrom(tests);
    const derived = deriveEnforcementClass(tests, capabilities);
    return {
      probe,
      capabilities,
      tests,
      ...derived,
      qualifiedAt: at,
      engineVersion: this.opts.engineVersion,
      fingerprint,
      fingerprintComplete: identity.complete,
      fingerprintUnmeasured: identity.unmeasured,
      boundary: this.boundaryOf(probe),
    };
  }

  /**
   * Q-K — a violating command is not re-run without the sandbox.
   *
   * Measured on Serva's own code rather than on the guest's: run a command that the
   * boundary must refuse, and count how many times the transport was invoked. Exactly
   * one invocation means there was no second, unsandboxed attempt. A test that only
   * checked the exit code could not tell a single refusal from a refusal followed by a
   * successful retry.
   */
  private async qualifyNoUnsandboxedRetry(
    layout: FixtureLayout,
    record: (
      id: string,
      outcome: QualificationResult['outcome'],
      detail: string,
      evidence?: {
        readonly reachedGuest?: GuestReach;
        readonly notRunReason?: NotRunReason;
        readonly transportAttempts?: readonly TransportAttempt[];
      },
    ) => void,
  ): Promise<void> {
    const before = this.transportCalls;
    const result = await this.execute({
      executable: 'node',
      args: ['-e', 'require("fs").writeFileSync(' + q(layout.guest.outside + '/qk.txt') + ', "x")'],
      cwd: layout.host.worktree,
      env: { PATH: GUEST_PATH },
      timeoutMs: 30_000,
      maxOutputBytes: 50_000,
      writeScope: [layout.host.worktree],
      readScope: [layout.host.root],
      denyRead: [layout.host.serva, layout.host.otherRun],
      networkAllowed: false,
    });
    const attempts = this.transportCalls - before;

    /*
     * A COMMAND THAT NEVER RAN MEASURED NOTHING — Q-K INCLUDED.
     *
     * SPEC: Phase 6 qualification transport invariant §1; finding QTS-1.
     *
     * Every other adversarial case opens with this guard. Q-K did not, because it counts
     * transport invocations rather than reading an exit code — and counting is exactly what
     * made the gap invisible. On a WSL transport failure (exit 4294967295, no output, nothing
     * reached the guest) the refused branch does not fire, the exit-0 branch does not fire,
     * and `attempts === 1` holds because the substrate counter increments once however many
     * times the transport retried internally. Q-K was then recorded PASSED, with a detail line
     * claiming there had been no unsandboxed retry of a command that was never sent.
     *
     * It failed OPEN, which is what makes it the serious one: `deriveEnforcementClass` counts
     * only NOT_RUN/TRANSPORT_FAILURE toward its unreached guard, so a PASSED Q-K sails past it
     * and `capabilitiesFrom` credits it toward host-escape enforcement — granting HARD, and
     * with it Producer dispatch authority, on a boundary nobody exercised.
     */
    if (result.reach !== GuestReach.REACHED) {
      record(
        'Q-K',
        'NOT_RUN',
        'The command never reached the execution environment after ' +
          String(result.transportAttempts?.length ?? 0) +
          ' attempt(s), so no unsandboxed retry was measured either way: ' +
          (result.transportAttempts?.[result.transportAttempts.length - 1]?.detail ??
            'no attempt was recorded'),
        {
          reachedGuest: result.reach,
          notRunReason: NotRunReason.TRANSPORT_FAILURE,
          ...(result.transportAttempts === undefined
            ? {}
            : { transportAttempts: result.transportAttempts }),
        },
      );
      return;
    }

    if (result.refusedBySubstrate) {
      record('Q-K', 'PASSED', 'The substrate refused outright and made no attempt to run it.');
      return;
    }
    if (result.exitCode === 0) {
      record(
        'Q-K',
        'FAILED',
        'The violating command SUCCEEDED, so there is no refusal for a fallback to be measured against.',
      );
      return;
    }
    record(
      'Q-K',
      attempts === 1 ? 'PASSED' : 'FAILED',
      attempts === 1
        ? 'The command was refused and the transport was invoked exactly once: no unsandboxed retry.'
        : 'The transport was invoked ' + String(attempts) + ' times for one command.',
    );
  }

  /** The disposable world the adversarial programs attack. */
  private materialiseFixture(fixtureDir: string): FixtureLayout {
    const t = this.opts.transport;
    const dirs = {
      programs: join(fixtureDir, 'programs'),
      worktree: join(fixtureDir, 'worktree'),
      checkout: join(fixtureDir, 'checkout'),
      outside: join(fixtureDir, 'outside'),
      serva: join(fixtureDir, 'serva'),
      otherRun: join(fixtureDir, 'other-run'),
    };
    for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
    writeFileSync(join(dirs.checkout, 'owner-work.txt'), 'uncommitted owner work\n', 'utf8');
    writeFileSync(join(dirs.serva, 'secret.txt'), 'audit trail and other runs\n', 'utf8');
    writeFileSync(join(dirs.otherRun, 'prompt.txt'), "another run's instructions\n", 'utf8');

    const host: FixturePaths = {
      root: fixtureDir,
      worktree: dirs.worktree,
      checkout: dirs.checkout,
      outside: dirs.outside,
      serva: dirs.serva,
      otherRun: dirs.otherRun,
    };
    return {
      host,
      guest: {
        root: t.toGuestPath(host.root),
        worktree: t.toGuestPath(host.worktree),
        checkout: t.toGuestPath(host.checkout),
        outside: t.toGuestPath(host.outside),
        serva: t.toGuestPath(host.serva),
        otherRun: t.toGuestPath(host.otherRun),
      },
    };
  }

  async capabilities(): Promise<SubstrateCapabilities> {
    // Capability is a RESULT of qualification, so an un-qualified answer claims nothing.
    return unenforced();
  }

  /**
   * The identity of the boundary this substrate is. Compared before every dispatch.
   *
   * `guest` is the ADDRESSABLE name of the execution environment — the WSL distribution
   * Serva will target — and not the guest's OS release. Both were called "guest" and
   * populated from different sources: qualification read `/etc/os-release` and got
   * "Ubuntu 26.04 LTS", while dispatch read the launcher and got "Ubuntu". They could
   * never match, so a Producer could never be dispatched however well the machine was
   * qualified. The comparison was working; the field meant two things.
   *
   * The OS release has not stopped mattering — an in-place distro upgrade must still
   * invalidate a measurement. It travels in `SubstrateQualification.fingerprint`
   * alongside the kernel and the launcher version, which `qualificationIsStale` checks.
   * The two identities answer different questions and both are asked:
   *
   *   boundary.fingerprint      am I about to run in the environment that was qualified?
   *   qualification.fingerprint is that qualification still describing this machine?
   */
  boundaryOf(probe: SubstrateProbe): ExecutionBoundary {
    void probe;
    const guest = this.opts.transport.id.startsWith('wsl:')
      ? this.opts.transport.id.slice('wsl:'.length)
      : undefined;
    return executionBoundary({
      boundaryId: this.opts.boundaryId,
      purpose: this.opts.purpose,
      transport: this.opts.transport.id,
      ...(guest === undefined ? {} : { guest }),
      ...(this.engineLocation === undefined ? {} : { engineLocation: this.engineLocation }),
      engineVersion: this.opts.engineVersion,
      sandboxMechanism: this.opts.launcher.id,
      ...(this.launcherVersion === undefined ? {} : { sandboxVersion: this.launcherVersion }),
      ...(this.opts.profileDigest === undefined ? {} : { profileDigest: this.opts.profileDigest }),
      simulated: false,
    });
  }

  /**
   * What this qualification is a measurement OF.
   *
   * Engine version, transport, guest kernel and distribution, launcher and its version.
   * Change any of them and the earlier measurement describes a machine that no longer
   * exists, which is why `qualificationIsStale` compares this rather than a timestamp.
   */
  async fingerprint(probe?: SubstrateProbe): Promise<string> {
    return (await this.fingerprintOf(probe)).digest;
  }

  /**
   * The fingerprint, AND whether every part of it was actually measured.
   *
   * SPEC: Phase 6 qualification transport invariant §6.
   *
   * The live evidence caught this one run after the transport fix landed. Six consecutive
   * qualifications agreed, and then two reported `fingerprint DIFFERS` on a machine nobody
   * had touched — because `engineVersion` reads `UNKNOWN` when its probe does not answer and
   * a real version when it does, and an UNKNOWN was going into the digest as though it were
   * a measurement. The digest changed, and Serva told the owner their machine had changed.
   *
   * Which is the same defect as the transport one, one level down: a value nobody measured
   * being treated as a value somebody measured. So the unmeasured parts are NAMED, and a
   * comparison involving any of them is UNKNOWN rather than DIFFERS.
   */
  async fingerprintOf(
    probe?: SubstrateProbe,
  ): Promise<{ digest: string; complete: boolean; unmeasured: readonly string[] }> {
    const p = probe ?? (await this.probe());
    const parts = {
      substrateId: this.id,
      engineVersion: this.opts.engineVersion,
      launcher: this.opts.launcher.id,
      sandboxVersion: p.sandboxVersion ?? 'none',
      transport: p.observations['transport'] ?? this.opts.transport.id,
      kernel: p.observations['transport:kernel'] ?? 'unknown',
      guestOs: p.observations['transport:guestOs'] ?? 'unknown',
      boundaryId: this.opts.boundaryId,
      purpose: this.opts.purpose,
      engineLocation: this.engineLocation ?? 'none',
      profileDigest: this.opts.profileDigest ?? 'none',
    };

    /*
     * Only the parts that describe the MACHINE, and only the sentinel values that mean "the
     * probe did not answer". `'none'` is excluded deliberately: a substrate with no sandbox
     * version genuinely has none, and that is a measurement.
     */
    const unmeasured = (['engineVersion', 'kernel', 'guestOs'] as const).filter((k) =>
      /^unknown$/i.test(String(parts[k])),
    );

    return {
      digest: digestOf(canonicalJson(parts)),
      complete: unmeasured.length === 0,
      unmeasured,
    };
  }

  async explain(): Promise<string> {
    const probe = await this.probe();
    const lines = [
      'Execution substrate: ' + this.id,
      '  transport: ' + this.opts.transport.id + ' (' + this.opts.transport.kind + ')',
      '  launcher:  ' + this.opts.launcher.id,
      '  guest:     ' + (probe.guestPlatform ?? '(same machine)'),
      '  isolation: ' + probe.isolationMethod,
      '  engine:    ' + probe.engineVersion,
      '',
      'Prerequisites:',
    ];
    for (const p of probe.prerequisites) {
      lines.push('  [' + (p.satisfied ? ' ok ' : 'MISS') + '] ' + p.id + '  ' + p.what);
      if (!p.satisfied) {
        lines.push('         why:    ' + p.why);
        lines.push('         remedy: ' + p.remedy);
      }
    }
    lines.push(
      '',
      this.opts.launcher.explain(),
      '',
      'Qualification runs these through execute() — the same method a Producer command',
      'uses — against a disposable fixture:',
      ...QUALIFICATION_CASES.map((c) => '  ' + c.id + '  ' + c.title + ' — ' + c.expectation),
      '',
      'What it does NOT test: escapes nobody thought of. A qualification is a',
      'measurement on one machine at one moment, not a proof of containment.',
    );
    return lines.join('\n');
  }
}

function unenforced(): SubstrateCapabilities {
  return {
    filesystemEnforcement: EnforcementState.NOT_ENFORCED,
    processEnforcement: EnforcementState.NOT_ENFORCED,
    networkEnforcement: EnforcementState.NOT_ENFORCED,
    credentialProtection: EnforcementState.NOT_ENFORCED,
    hostEscapeProtection: EnforcementState.NOT_ENFORCED,
    canWrite: false,
    canExecute: false,
  };
}

/**
 * Capabilities derived from what the suite proved, dimension by dimension.
 *
 * They are separate because they FAIL separately: on WSL2 the filesystem isolation can
 * be perfect while host escape is wide open, because that escape does not go through
 * the filesystem at all.
 */
export function capabilitiesFrom(tests: readonly QualificationResult[]): SubstrateCapabilities {
  const passed = (id: string): boolean => tests.find((t) => t.id === id)?.outcome === 'PASSED';
  const state = (ids: readonly string[]): EnforcementState =>
    ids.every((id) => passed(id)) ? EnforcementState.ENFORCED : EnforcementState.NOT_ENFORCED;

  const filesystem = state(['Q-A', 'Q-B', 'Q-C', 'Q-G', 'Q-H']);
  const process_ = state(['Q-F']);
  const network = state(['Q-I']);
  const credential = state(['Q-D', 'Q-E']);
  const host = state(['Q-J', 'Q-K']);

  return {
    filesystemEnforcement: filesystem,
    processEnforcement: process_,
    networkEnforcement: network,
    credentialProtection: credential,
    hostEscapeProtection: host,
    canWrite: filesystem === EnforcementState.ENFORCED,
    canExecute: filesystem === EnforcementState.ENFORCED && process_ === EnforcementState.ENFORCED,
  };
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10));
  const pb = b.split('.').map((n) => Number.parseInt(n, 10));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (Number.isNaN(x) || Number.isNaN(y)) return 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}
