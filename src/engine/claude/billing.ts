import { AuthenticationKind, BillingMode } from '../../vocab/index.js';

/**
 * Billing-route detection. SPEC: 33 §5, SC-POL-035, 19 §1.1.
 *
 * The rule this file exists to enforce: **Serva never silently changes which route
 * the owner is billed on.** Detection is therefore conservative in one specific
 * direction — an ambiguous signal resolves to `UNKNOWN`, never to "probably the safe
 * one". An undetected route reported as SUBSCRIPTION would be exactly the silent
 * fallback the policy forbids.
 *
 * Nothing here reads a credential VALUE. It reads whether variables are set and what
 * the provider's own read-only status command reports about its method. A key's
 * presence is a routing fact; a key's content is a secret, and this module never sees
 * one.
 */

/**
 * Environment variables whose presence would change the billing route.
 *
 * The Claude CLI honours OAuth by default, but an API key or auth token in the
 * environment can take precedence depending on invocation mode, and `--bare` uses the
 * key exclusively. Serva must therefore notice them even when the CLI happens not to
 * be using them right now.
 */
export const API_BILLING_ENV_VARS: readonly string[] = Object.freeze([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY_HELPER',
]);

/** Third-party cloud routes bill through that cloud, not through Anthropic. */
export const THIRD_PARTY_ENV_VARS: readonly string[] = Object.freeze([
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
]);

export interface AuthStatusFacts {
  readonly loggedIn: boolean;
  /** e.g. "claude.ai", "apiKey", "bedrock". Provider-defined; matched, never trusted. */
  readonly authMethod?: string;
  readonly apiProvider?: string;
  readonly subscriptionType?: string;
}

export interface BillingAssessment {
  readonly authenticationKind: AuthenticationKind;
  readonly billingMode: BillingMode;
  /** Environment variables that were SET. Names only — values are never read. */
  readonly conflictingEnvVars: readonly string[];
  /** True when the environment would route billing somewhere other than the login. */
  readonly routeConflict: boolean;
  readonly explanation: string;
}

function present(names: readonly string[], env: NodeJS.ProcessEnv): string[] {
  return names.filter((n) => {
    const v = env[n];
    return typeof v === 'string' && v.trim().length > 0;
  });
}

/**
 * Classify the effective route from the provider's status plus the environment.
 *
 * Order matters and is deliberate: a third-party cloud configuration overrides
 * everything, an API key overrides a subscription login, and only a clean
 * subscription login with no conflicting variable reports SUBSCRIPTION.
 */
export function assessBillingRoute(
  facts: AuthStatusFacts | undefined,
  env: NodeJS.ProcessEnv,
): BillingAssessment {
  const thirdParty = present(THIRD_PARTY_ENV_VARS, env);
  const apiVars = present(API_BILLING_ENV_VARS, env);

  if (thirdParty.length > 0) {
    return {
      authenticationKind: AuthenticationKind.THIRD_PARTY_CLOUD,
      billingMode: BillingMode.THIRD_PARTY_CLOUD,
      conflictingEnvVars: [...thirdParty, ...apiVars],
      routeConflict: true,
      explanation:
        'A third-party cloud route is configured (' +
        thirdParty.join(', ') +
        '), which bills through that cloud rather than through the signed-in account.',
    };
  }

  if (facts === undefined) {
    return {
      authenticationKind: AuthenticationKind.UNKNOWN,
      billingMode: BillingMode.UNKNOWN,
      conflictingEnvVars: apiVars,
      routeConflict: apiVars.length > 0,
      explanation:
        'The provider did not report an authentication status, so the billing route cannot be determined.',
    };
  }

  if (!facts.loggedIn && apiVars.length === 0) {
    return {
      authenticationKind: AuthenticationKind.NONE,
      billingMode: BillingMode.UNKNOWN,
      conflictingEnvVars: [],
      routeConflict: false,
      explanation: 'Not signed in and no API credential is configured.',
    };
  }

  const method = (facts.authMethod ?? '').toLowerCase();
  const subscriptionLogin = method.includes('claude.ai') || method.includes('oauth');

  if (apiVars.length > 0) {
    // A key is present. Even if the CLI is currently using the subscription login,
    // this is a route the owner did not ask Serva to use, so it is surfaced as a
    // conflict rather than quietly ignored.
    return {
      authenticationKind: subscriptionLogin
        ? AuthenticationKind.SUBSCRIPTION_OAUTH
        : AuthenticationKind.API_KEY,
      billingMode: subscriptionLogin ? BillingMode.UNKNOWN : BillingMode.API_KEY,
      conflictingEnvVars: apiVars,
      routeConflict: true,
      explanation:
        'A separately billed API credential is present in the environment (' +
        apiVars.join(', ') +
        '). Serva will not select it silently; resolve the ambiguity explicitly.',
    };
  }

  if (subscriptionLogin) {
    const plan = facts.subscriptionType;
    return {
      authenticationKind: AuthenticationKind.SUBSCRIPTION_OAUTH,
      billingMode: BillingMode.SUBSCRIPTION,
      conflictingEnvVars: [],
      routeConflict: false,
      explanation:
        'Signed in with the account login' +
        (plan === undefined ? '' : ' on a ' + plan + ' plan') +
        '; usage is covered by that subscription.',
    };
  }

  if (method.includes('key') || method.includes('token') || facts.apiProvider === 'console') {
    return {
      authenticationKind: AuthenticationKind.API_KEY,
      billingMode: BillingMode.API_KEY,
      conflictingEnvVars: apiVars,
      routeConflict: true,
      explanation:
        'The provider reports API-credential authentication, which is billed separately from a subscription.',
    };
  }

  return {
    authenticationKind: AuthenticationKind.UNKNOWN,
    billingMode: BillingMode.UNKNOWN,
    conflictingEnvVars: apiVars,
    routeConflict: false,
    explanation:
      'Signed in, but the authentication method "' +
      (facts.authMethod ?? '(absent)') +
      '" is not one Serva recognises, so the billing route is not determined.',
  };
}

/**
 * Is this route acceptable to dispatch on?
 *
 * `allowed` names the modes the project has explicitly accepted. Phase 3 ships with
 * SUBSCRIPTION only: the owner asked for their existing authenticated environment and
 * for no automatic path to anything else. Widening this list is an owner decision, and
 * it is a configuration change rather than a code change.
 */
export function billingRouteRefusal(
  assessment: BillingAssessment,
  allowed: readonly BillingMode[],
): string | undefined {
  if (assessment.routeConflict && assessment.conflictingEnvVars.length > 0) {
    return (
      'Refusing to dispatch: the environment sets ' +
      assessment.conflictingEnvVars.join(', ') +
      ', which could route usage to a separately billed account. ' +
      assessment.explanation
    );
  }
  if (!allowed.includes(assessment.billingMode)) {
    return (
      'Refusing to dispatch: the detected billing mode is ' +
      assessment.billingMode +
      ' but this project accepts only ' +
      allowed.join(', ') +
      '. ' +
      assessment.explanation
    );
  }
  return undefined;
}

/** The Phase 3 default. Deliberately a single value (ADR-002 §4). */
export const DEFAULT_ALLOWED_BILLING: readonly BillingMode[] = Object.freeze([
  BillingMode.SUBSCRIPTION,
]);
