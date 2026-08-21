import { z } from 'zod';
import { EngineHealthState, type EngineCapabilities, type EngineStatus } from '../types.js';
import { assessBillingRoute, type AuthStatusFacts, type BillingAssessment } from './billing.js';
import { CLAUDE_BIN } from './argv.js';

/**
 * Claude local capability probe. SPEC: 19 §7 (last row), 33 §5, SC-POL-035.
 *
 * Read-only by construction. The probe runs `--version` and `auth status --json`, and
 * nothing else. It never runs `auth login`, never runs `setup-token`, never prompts,
 * and never invokes the model — so a probe costs nothing and cannot change the
 * owner's authentication state.
 *
 * Credential hygiene: `auth status` returns the account email, organisation id and
 * organisation name. None of them are needed to decide whether Serva may dispatch, so
 * `toStatus` discards them. What is persisted is listed explicitly in the return type,
 * and the omission is deliberate rather than incidental.
 */

/** Runs a command and returns its result. Injected so the probe is testable offline. */
export interface CommandRunner {
  (
    bin: string,
    args: readonly string[],
    timeoutMs: number,
  ): Promise<{
    code: number | null;
    stdout: string;
    stderr: string;
    spawnFailed?: boolean;
  }>;
}

/**
 * The subset of `claude auth status --json` Serva reads.
 *
 * `.passthrough()` on purpose: the provider adds fields, and a strict schema would
 * turn a harmless addition into an outage. Fields not named here are never read.
 *
 * `.nullish()` rather than `.optional()` matters more than it looks. The command
 * returns an explicit `null` for a value it does not have — `"subscriptionType": null`
 * — and `.optional()` accepts only `undefined`. Treating that null as a parse failure
 * made the whole record unreadable, which the probe then reported as UNAUTHENTICATED:
 * a correctly signed-in owner told they were not signed in, and refused dispatch. A
 * schema that is strict in the wrong direction fails closed against the user.
 */
const AuthStatusSchema = z
  .object({
    loggedIn: z.boolean(),
    authMethod: z.string().nullish(),
    apiProvider: z.string().nullish(),
    subscriptionType: z.string().nullish(),
  })
  .passthrough();

/** Collapse the provider's `null` into "absent", which is what it means here. */
function present(v: string | null | undefined): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

export const PROVIDER = 'anthropic-claude';
export const TRANSPORT = 'claude-cli';

/** Version at which each capability Serva depends on became available. */
const MIN_VERSIONS: Readonly<Record<string, string>> = Object.freeze({
  jsonSchema: '2.1.205',
  initCapabilities: '2.1.205',
  safeMode: '2.1.0',
});

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

export function parseVersion(stdout: string): string | undefined {
  const m = stdout.match(/(\d+\.\d+\.\d+)/);
  return m?.[1];
}

export function parseAuthStatus(stdout: string): AuthStatusFacts | undefined {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return undefined;
  // The command may emit a warning line before the JSON body.
  const start = trimmed.indexOf('{');
  if (start < 0) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed.slice(start));
  } catch {
    return undefined;
  }
  const parsed = AuthStatusSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const authMethod = present(parsed.data.authMethod);
  const apiProvider = present(parsed.data.apiProvider);
  const subscriptionType = present(parsed.data.subscriptionType);
  return {
    loggedIn: parsed.data.loggedIn,
    ...(authMethod === undefined ? {} : { authMethod }),
    ...(apiProvider === undefined ? {} : { apiProvider }),
    ...(subscriptionType === undefined ? {} : { subscriptionType }),
  };
}

export function capabilitiesFor(version: string): EngineCapabilities {
  const at = (key: string): boolean => compareVersions(version, MIN_VERSIONS[key] ?? '0.0.0') >= 0;
  return {
    provider: PROVIDER,
    transport: TRANSPORT,
    version,
    supportsTools: true,
    supportsStructuredOutput: at('jsonSchema'),
    supportsSessionContinuation: true,
    supportsToolRestriction: true,
    supportsNonInteractivePermissions: true,
    supportsStreaming: true,
    supportsAmbientConfigIsolation: at('safeMode'),
    supportsTurnLimit: true,
    models: [],
    declared: [],
  };
}

export interface ProbeResult {
  readonly status: EngineStatus;
  readonly assessment: BillingAssessment;
}

export interface ProbeOptions {
  readonly run: CommandRunner;
  readonly now: () => string;
  readonly env: NodeJS.ProcessEnv;
  readonly bin?: string;
  readonly timeoutMs?: number;
}

/**
 * Detect what this machine's Claude installation is and how it would be billed.
 *
 * Returns a status rather than throwing: "not installed" and "not authenticated" are
 * states the owner needs reported (19 §7 — halt and notify), not exceptions to be
 * caught somewhere far from the cause.
 */
export async function probeClaude(opts: ProbeOptions): Promise<ProbeResult> {
  const bin = opts.bin ?? CLAUDE_BIN;
  const timeout = opts.timeoutMs ?? 15_000;
  const checkedAt = opts.now();

  const unknownCaps = capabilitiesFor('0.0.0');
  const versionRes = await opts.run(bin, ['--version'], timeout);

  if (versionRes.spawnFailed === true || versionRes.code !== 0) {
    const assessment = assessBillingRoute(undefined, opts.env);
    return {
      assessment,
      status: {
        state: EngineHealthState.UNAVAILABLE,
        provider: PROVIDER,
        transport: TRANSPORT,
        version: 'UNKNOWN',
        authenticated: false,
        authenticationKind: assessment.authenticationKind,
        billingMode: assessment.billingMode,
        capabilities: unknownCaps,
        checkedAt,
        detail: 'The `' + bin + '` executable could not be run.',
        remedy:
          'Install Claude Code and make sure `' +
          bin +
          '` is on PATH. Serva will not install or configure it for you.',
      },
    };
  }

  const version = parseVersion(versionRes.stdout) ?? 'UNKNOWN';
  const capabilities = capabilitiesFor(version === 'UNKNOWN' ? '0.0.0' : version);

  const authRes = await opts.run(bin, ['auth', 'status', '--json'], timeout);
  const facts = authRes.spawnFailed === true ? undefined : parseAuthStatus(authRes.stdout);
  const assessment = assessBillingRoute(facts, opts.env);

  const authenticated = facts?.loggedIn === true;
  const base = {
    provider: PROVIDER,
    transport: TRANSPORT,
    version,
    authenticated,
    authenticationKind: assessment.authenticationKind,
    billingMode: assessment.billingMode,
    capabilities,
    checkedAt,
  };

  if (!authenticated) {
    return {
      assessment,
      status: {
        ...base,
        state: EngineHealthState.UNAUTHENTICATED,
        detail: assessment.explanation,
        remedy:
          'Sign in to Claude Code yourself (`' +
          bin +
          ' auth login`). Serva deliberately does not run a login flow, request a key, or create an account on your behalf.',
      },
    };
  }

  if (!capabilities.supportsStructuredOutput) {
    return {
      assessment,
      status: {
        ...base,
        state: EngineHealthState.DEGRADED,
        detail:
          'Claude Code ' +
          version +
          ' predates reliable --json-schema handling (requires ' +
          MIN_VERSIONS['jsonSchema'] +
          '), and 19 SO-1 requires contractual structured output.',
        remedy: 'Update Claude Code to ' + MIN_VERSIONS['jsonSchema'] + ' or later.',
      },
    };
  }

  return { assessment, status: { ...base, state: EngineHealthState.READY } };
}
