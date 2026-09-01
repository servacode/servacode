import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { digestOf } from '../core/hash.js';
import type { ChangeSet } from './changeset.js';
import type { EngineeringWorkspace } from './workspace.js';

/**
 * SC-RTC-015 — Secrets Scanner.
 *
 * SPEC: Phase 4 §19, 17 (security governance).
 *
 * **The secret value never leaves this module.** A finding carries the path, the line,
 * the category and a digest — never the credential itself. Sending a discovered secret
 * to a model for assessment would be a disclosure caused by the check that was supposed
 * to prevent one.
 *
 * What this is: a deterministic check for obviously committed credentials, against a
 * documented rule set, run before a change can be accepted.
 *
 * What this is NOT, stated plainly because the difference matters: a security review.
 * It finds credential SHAPES. It cannot find a secret that does not look like one, it
 * has no notion of whether a key is live, and it replaces no part of the security
 * testing a later phase owns. A clean result here means "nothing matched these rules",
 * and that is all it means.
 */

export const SecretCategory = {
  PRIVATE_KEY: 'PRIVATE_KEY',
  ANTHROPIC_KEY: 'ANTHROPIC_KEY',
  AWS_ACCESS_KEY: 'AWS_ACCESS_KEY',
  GITHUB_TOKEN: 'GITHUB_TOKEN',
  SLACK_TOKEN: 'SLACK_TOKEN',
  GOOGLE_API_KEY: 'GOOGLE_API_KEY',
  STRIPE_KEY: 'STRIPE_KEY',
  JWT: 'JWT',
  GENERIC_ASSIGNMENT: 'GENERIC_ASSIGNMENT',
  CONNECTION_STRING: 'CONNECTION_STRING',
} as const;
export type SecretCategory = (typeof SecretCategory)[keyof typeof SecretCategory];

export interface SecretRule {
  readonly category: SecretCategory;
  readonly pattern: RegExp;
  /** HIGH findings block acceptance. MEDIUM is reported and does not block. */
  readonly severity: 'HIGH' | 'MEDIUM';
  readonly description: string;
}

/**
 * The documented rule set.
 *
 * High-confidence rules match a vendor-specific shape that is hard to produce by
 * accident. The generic assignment rule is MEDIUM on purpose: `password = "..."` is
 * the single most common false positive in every scanner ever written, and blocking a
 * change on it would teach the owner to ignore the scanner.
 */
export const SECRET_RULES: readonly SecretRule[] = Object.freeze([
  {
    category: SecretCategory.PRIVATE_KEY,
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/,
    severity: 'HIGH',
    description: 'A PEM private key block.',
  },
  {
    category: SecretCategory.ANTHROPIC_KEY,
    pattern: /sk-ant-[A-Za-z0-9_-]{16,}/,
    severity: 'HIGH',
    description: 'An Anthropic API key.',
  },
  {
    category: SecretCategory.AWS_ACCESS_KEY,
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
    severity: 'HIGH',
    description: 'An AWS access key id.',
  },
  {
    category: SecretCategory.GITHUB_TOKEN,
    pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
    severity: 'HIGH',
    description: 'A GitHub personal access or app token.',
  },
  {
    category: SecretCategory.SLACK_TOKEN,
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
    severity: 'HIGH',
    description: 'A Slack token.',
  },
  {
    category: SecretCategory.GOOGLE_API_KEY,
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/,
    severity: 'HIGH',
    description: 'A Google API key.',
  },
  {
    category: SecretCategory.STRIPE_KEY,
    pattern: /\b(?:sk|rk)_(?:live|test)_[0-9a-zA-Z]{16,}\b/,
    severity: 'HIGH',
    description: 'A Stripe secret key.',
  },
  {
    category: SecretCategory.CONNECTION_STRING,
    pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s:@/]{6,}@[^\s/]+/i,
    severity: 'HIGH',
    description: 'A URL carrying inline credentials.',
  },
  {
    category: SecretCategory.JWT,
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
    severity: 'MEDIUM',
    description: 'A JSON Web Token.',
  },
  {
    category: SecretCategory.GENERIC_ASSIGNMENT,
    pattern:
      /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)\b\s*[:=]\s*["'][^"'\s]{12,}["']/i,
    severity: 'MEDIUM',
    description: 'A credential-shaped assignment with a long literal value.',
  },
]);

/** A finding. Carries where and what, never the value. */
export interface SecretFinding {
  readonly path: string;
  readonly line: number;
  readonly category: SecretCategory;
  readonly severity: 'HIGH' | 'MEDIUM';
  readonly description: string;
  /** Digest of the matched text, so two findings can be compared without either value. */
  readonly matchDigest: string;
  /** Length only. Enough to distinguish a stub from a real key, and no more. */
  readonly matchLength: number;
}

export interface SecretsScanResult {
  readonly findings: readonly SecretFinding[];
  readonly filesScanned: number;
  readonly filesSkipped: number;
  readonly blocking: boolean;
}

/** Files a scan does not open: generated, vendored, or not text. */
const SKIP_PATTERNS: readonly RegExp[] = Object.freeze([
  /(^|\/)node_modules\//,
  /(^|\/)dist\//,
  /(^|\/)\.git\//,
  /\.(png|jpe?g|gif|ico|pdf|zip|gz|tar|woff2?|ttf|eot|mp4|mp3|wasm)$/i,
]);

const MAX_SCAN_BYTES = 2_000_000;

/**
 * Scan the files a ChangeSet touched.
 *
 * Only the change is scanned, not the whole repository: the question is whether THIS
 * change introduces a credential, and a pre-existing one is a separate finding for a
 * separate process to raise.
 */
export function scanChangeSetForSecrets(
  workspace: EngineeringWorkspace,
  changeSet: ChangeSet,
): SecretsScanResult {
  const findings: SecretFinding[] = [];
  let scanned = 0;
  let skipped = 0;

  for (const entry of changeSet.entries) {
    if (entry.status === 'D') continue;
    if (entry.isBinary || entry.isSymlink) {
      skipped += 1;
      continue;
    }
    if (SKIP_PATTERNS.some((re) => re.test(entry.path))) {
      skipped += 1;
      continue;
    }
    const abs = join(workspace.path, entry.path);
    if (!existsSync(abs)) {
      skipped += 1;
      continue;
    }
    let text: string;
    try {
      const buf = readFileSync(abs);
      if (buf.length > MAX_SCAN_BYTES) {
        skipped += 1;
        continue;
      }
      text = buf.toString('utf8');
    } catch {
      skipped += 1;
      continue;
    }
    scanned += 1;
    findings.push(...scanText(entry.path, text));
  }

  return {
    findings,
    filesScanned: scanned,
    filesSkipped: skipped,
    // A high-confidence finding blocks acceptance. A medium one is reported.
    blocking: findings.some((f) => f.severity === 'HIGH'),
  };
}

/**
 * WHAT A CREDENTIAL IS REPLACED BY WHEN IT MUST NOT BE KEPT.
 *
 * SPEC: finding ENGINEERING-SECRETS-AND-EXECUTION-EVIDENCE/SEC-1 (MEDIUM), 1.0.1 review.
 *
 * Named rather than blank, because a reader who cannot tell that something was removed will
 * eventually conclude nothing was there. The category is safe to state: it describes the shape
 * that matched, never the value.
 */
export interface Redaction {
  /** The text with every matched credential replaced. */
  readonly text: string;
  /** How many were replaced. Zero means the text is unchanged, not that it was unchecked. */
  readonly count: number;
  /** Which shapes were found, so a reader knows what kind of thing was removed. */
  readonly categories: readonly SecretCategory[];
}

/**
 * Remove credentials from text that is about to be stored.
 *
 * SPEC: finding SEC-1.
 *
 * `execution.ts` wrote 2000 bytes of raw stdout and stderr straight into T-CANON, which is
 * immutable and travels in every backup and export. The module's own header says that output
 * "routinely carries paths, tokens and environment fragments", and the secrets scanner only
 * ever ran over ChangeSet FILES — so a credential printed by a build was persisted verbatim,
 * permanently, having bypassed the boundary meant to catch exactly that.
 *
 * This uses SECRET_RULES, the same rules `scanText` uses. A second detector would drift from
 * the first, and the day they disagreed would be the day one of them was wrong about a secret.
 *
 * Redaction happens BEFORE persistence and is never a repair afterwards: canon is immutable,
 * so "write it now and clean it later" is not a thing that can be done.
 */
/**
 * SECRETS WHOSE EXTENT IS LARGER THAN THE THING THAT DETECTS THEM.
 *
 * SPEC: finding ENGINEERING-SECRETS-AND-EXECUTION-EVIDENCE/SEC-EXEC-1 (HIGH), 1.0.1 review.
 *
 * `SECRET_RULES` exists to DETECT, and a detector only needs an anchor distinctive enough to
 * flag the line. The PRIVATE_KEY rule matches `-----BEGIN … PRIVATE KEY-----` and stops, which
 * is everything a scanner needs and nowhere near enough to redact.
 *
 * Reusing those patterns to redact produced the worst possible outcome: the header was replaced
 * with `[REDACTED:PRIVATE_KEY]`, the base64 body and END marker were written to canon verbatim,
 * and the marker LABELLED the key that followed it. Worse than no redaction, because it tells a
 * reader where to look.
 *
 * Detection and redaction are different questions about the same rule set, and one pattern
 * cannot answer both. These cover the whole block. The unterminated form is deliberate: build
 * output is truncated all the time, and a key whose END marker never arrived is still a key.
 */
const REDACTION_EXTENTS: readonly {
  readonly category: SecretCategory;
  readonly pattern: RegExp;
}[] = Object.freeze([
  {
    category: SecretCategory.PRIVATE_KEY,
    pattern:
      /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g,
  },
  {
    /* Truncated output: a BEGIN with no END takes everything after it. */
    category: SecretCategory.PRIVATE_KEY,
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]*/g,
  },
]);

export function redactSecrets(text: string): Redaction {
  const categories = new Set<SecretCategory>();
  let count = 0;
  let out = text;

  /*
   * Extents first. A per-rule pattern would otherwise consume the header this needs as its
   * opening anchor, and the body would survive with a label in front of it.
   */
  for (const extent of REDACTION_EXTENTS) {
    out = out.replace(extent.pattern, () => {
      count += 1;
      categories.add(extent.category);
      return '[REDACTED:' + extent.category + ']';
    });
  }

  for (const rule of SECRET_RULES) {
    /* A fresh global regex per call: the shared rule patterns are not global and carry no
       lastIndex, and mutating them here would leak state into `scanText`. */
    const all = new RegExp(
      rule.pattern.source,
      rule.pattern.flags.includes('g') ? rule.pattern.flags : rule.pattern.flags + 'g',
    );
    out = out.replace(all, () => {
      count += 1;
      categories.add(rule.category);
      return '[REDACTED:' + rule.category + ']';
    });
  }

  return { text: out, count, categories: [...categories] };
}

export function scanText(path: string, text: string): SecretFinding[] {
  const out: SecretFinding[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    // A line that says it is an example is still reported, just not as HIGH: the
    // scanner does not get to decide that a comment is telling the truth.
    for (const rule of SECRET_RULES) {
      const m = rule.pattern.exec(line);
      if (m === null) continue;
      const matched = m[0];
      out.push({
        path,
        line: i + 1,
        category: rule.category,
        severity: looksLikePlaceholder(matched) ? 'MEDIUM' : rule.severity,
        description: rule.description,
        matchDigest: digestOf(matched),
        matchLength: matched.length,
      });
    }
  }
  return out;
}

/**
 * Does this look like documentation rather than a live credential?
 *
 * Downgrades severity, never suppresses the finding. A placeholder that turns out to
 * be real would otherwise disappear entirely, and the cost of being wrong in that
 * direction is much higher than the cost of a reported MEDIUM.
 *
 * THE VALUE DECIDES, NOT THE SENTENCE AROUND IT.
 *
 * SPEC: finding ENGINEERING-SECRETS-AND-EXECUTION-EVIDENCE/SEC-2 (MEDIUM), 1.0.1 review.
 *
 * This took the whole LINE. `blocking` is `findings.some(f => f.severity === 'HIGH')`, so
 * writing `// example` beside a live credential downgraded it and the scan stopped blocking
 * acceptance. The text on a line is written by whoever wrote the line — letting it decide
 * enforcement hands control to the party the check exists to constrain.
 *
 * Everything below is intrinsic to the matched value:
 *
 *   a placeholder word INSIDE the credential itself — AWS's own documented example key is
 *   `AKIAIOSFODNN7EXAMPLE`, and nobody is issued a real key containing EXAMPLE;
 *
 *   a long run of one character, which is how a masked value is written;
 *
 *   a value made only of x, 0 or *.
 *
 * None of these can be arranged around a real credential by adding a comment.
 */
function looksLikePlaceholder(matched: string): boolean {
  const value = matched.toLowerCase();
  const alnum = matched.replace(/[^A-Za-z0-9]/g, '');

  if (
    /(example|sample|placeholder|dummy|fake|redacted|your[_-]?key|changeme|test[_-]?only)/.test(
      value,
    )
  ) {
    return true;
  }

  /* A masked value: `AKIAXXXXXXXXXXXXXXXX`, `sk-ant-0000000000000000`. */
  if (/(.)\1{3,}/.test(alnum)) return true;

  return /^[x0*]+$/i.test(alnum);
}

/** A report safe to show a model or write to a trace: no values, ever. */
export function redactedReport(result: SecretsScanResult): string {
  if (result.findings.length === 0) {
    return (
      'No credential-shaped content matched the rule set across ' +
      String(result.filesScanned) +
      ' scanned file(s). This means nothing matched these rules; it is not a security review.'
    );
  }
  const lines = [String(result.findings.length) + ' finding(s). Values are withheld by design:'];
  for (const f of result.findings) {
    lines.push(
      '  [' +
        f.severity +
        '] ' +
        f.category +
        '  ' +
        f.path +
        ':' +
        String(f.line) +
        '  (' +
        String(f.matchLength) +
        ' chars, digest ' +
        f.matchDigest.slice(0, 12) +
        ')  ' +
        f.description,
    );
  }
  return lines.join('\n');
}
