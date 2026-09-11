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
    /*
     * ANY LABEL, NOT A LIST OF THE ONES SOMEBODY THOUGHT OF.
     *
     * SPEC: finding SECRETS-REDACT-ENCRYPTED-KEY (MEDIUM), 1.0.1 security review.
     *
     * This enumerated `RSA | EC | DSA | OPENSSH | PGP` and so did not match
     * `-----BEGIN ENCRYPTED PRIVATE KEY-----`, which is one of the commonest labels there is.
     * An encrypted key block printed by a build was therefore neither detected nor redacted,
     * and its body went verbatim into immutable canon — the exact permanent-channel leak
     * SEC-EXEC-1 exists to close, left open for one word.
     *
     * `(?:[A-Z0-9]+ )*` matches whatever label a tool puts there, including none. The words
     * before "PRIVATE KEY" were never the thing worth enumerating; the block was.
     */
    pattern: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/,
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
    /*
     * SPEC: finding ENGINEERING-SECRETS-AND-EXECUTION-EVIDENCE/SEC-REV-1 (MEDIUM), 1.0.1.
     *
     * The quoted form is what a source file looks like. The unquoted form is what PROCESS
     * OUTPUT looks like — `TOKEN=abcdef…` in a build log — and that output is written into
     * immutable canon as execution excerpts, the one place an unredacted value cannot later be
     * withdrawn. A rule that matched only source shapes left the permanent channel unmatched.
     *
     * The unquoted branch demands twenty token characters rather than twelve: unquoted values
     * are bare words, and a shorter threshold would redact `secret: true` and ordinary
     * identifiers out of the evidence an owner reads.
     *
     * SPEC: finding SEC-REV-EXEC-A2 (MEDIUM), 1.0.1 security review — the second pass on this
     * rule. Widening the SHAPE left the KEYWORD set as it was, so the commonest forms in build
     * output, `TOKEN=` and `APIKEY=`, still went through. The length threshold is what makes a
     * word as ordinary as `token` safe to list: a parser printing `token=42` is untouched, and
     * twenty unbroken token characters after `token=` is not a lexer talking.
     */
    category: SecretCategory.GENERIC_ASSIGNMENT,
    pattern:
      /\b(?:password|passwd|passphrase|secret|credential|bearer|token|api[_-]?key|apikey|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key)\b\s*[:=]\s*(?:["'][^"'\s]{12,}["']|[A-Za-z0-9_\-./+=]{20,})/i,
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
  /**
   * Files in the change that were NOT looked at, and why.
   *
   * SPEC: finding SEC-REV-EXEC-A1 (MEDIUM), 1.0.1 security review.
   *
   * `filesSkipped` was a count, and a count cannot tell an owner whether the scan skipped a
   * PNG or a three-megabyte source file. The two are not the same: one is a policy exclusion,
   * the other is a place a credential could sit while the scan reports nothing.
   *
   * Only the second kind is listed here. A vendored or binary path is excluded by design and
   * saying so for each would bury the cases that matter.
   */
  readonly notScanned: readonly { readonly path: string; readonly reason: string }[];
  /**
   * Whether every file in the change was actually read.
   *
   * SPEC: findings SEC-SCAN-LARGEFILE-1 and SEC-SCAN-SKIP-SILENT-2 (both MEDIUM), 1.0.1 review.
   *
   * `blocking` answers "did we find a credential". This answers "were we in a position to
   * find one", and they are different questions. EC-SECRETS states that the change introduces
   * no committed credential and is BLOCKING; a scan that skipped a file cannot support that
   * sentence, whatever it found in the files it did read.
   */
  readonly complete: boolean;
  readonly blocking: boolean;
}

/**
 * Files a scan does not open, BY LOCATION.
 *
 * SPEC: finding SEC-SCAN-SKIP-SILENT-2 (MEDIUM), 1.0.1 security review.
 *
 * This list used to carry image and archive EXTENSIONS beside the three directories, and the
 * two are not the same kind of rule. A directory is where a file lives, which is a fact about
 * the repository; an extension is what a file is called, which is a claim by whoever named it.
 * `secrets.png` is one rename away from a credential the scan reports nothing about, and the
 * skip was silent, so there was no line in the report to notice.
 *
 * Content is now measured rather than guessed at, so the extension rules are gone instead of
 * being tightened: a file whose bytes are binary is still read, because a credential pasted
 * into a binary is a credential, and the rules are ASCII shapes that a byte scan finds.
 */
const EXCLUDED_LOCATIONS: readonly RegExp[] = Object.freeze([
  /(^|\/)node_modules\//,
  /(^|\/)dist\//,
  /(^|\/)\.git\//,
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
  /* Files a credential could be hiding in that this scan did not read. */
  const notScanned: { path: string; reason: string }[] = [];

  for (const entry of changeSet.entries) {
    if (entry.status === 'D') continue;
    if (EXCLUDED_LOCATIONS.some((re) => re.test(entry.path))) {
      skipped += 1;
      continue;
    }
    /*
     * A symlink has no content of its own here: what it points at is either already in the
     * change under its own path, or outside the change entirely. It is still disclosed,
     * because "there was nothing of mine to read" is not the same as "I read it".
     */
    if (entry.isSymlink) {
      skipped += 1;
      notScanned.push({
        path: entry.path,
        reason: 'is a symlink, so no content of its own was read',
      });
      continue;
    }
    const abs = join(workspace.path, entry.path);
    if (!existsSync(abs)) {
      skipped += 1;
      notScanned.push({
        path: entry.path,
        reason: 'is named by the change but is not on disk, so it was not read',
      });
      continue;
    }
    let text: string;
    try {
      const buf = readFileSync(abs);
      if (buf.length > MAX_SCAN_BYTES) {
        skipped += 1;
        notScanned.push({
          path: entry.path,
          reason: 'larger than ' + String(MAX_SCAN_BYTES) + ' bytes, so it was not read or scanned',
        });
        continue;
      }
      /*
       * latin1 for bytes that are not valid UTF-8: utf8 decoding replaces them, and a
       * replacement character landing inside a key is a credential the rules no longer match.
       * Every rule here is an ASCII shape, so one byte to one character is what they want.
       */
      text = entry.isBinary ? buf.toString('latin1') : buf.toString('utf8');
    } catch {
      skipped += 1;
      notScanned.push({ path: entry.path, reason: 'could not be read' });
      continue;
    }
    scanned += 1;
    findings.push(...scanText(entry.path, text));
  }

  return {
    findings,
    filesScanned: scanned,
    filesSkipped: skipped,
    notScanned,
    complete: notScanned.length === 0,
    /*
     * A high-confidence finding blocks acceptance. A medium one is reported.
     *
     * A file the scan never read blocks too, and for a different reason: not because a
     * credential was found in it, but because the gate's sentence cannot be said about it.
     * Leaving that to `notScanned` as an advisory made the >2MB file the place to put a key.
     */
    blocking: findings.some((f) => f.severity === 'HIGH') || notScanned.length > 0,
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
      /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----/g,
  },
  {
    /* Truncated output: a BEGIN with no END takes everything after it. */
    category: SecretCategory.PRIVATE_KEY,
    pattern: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*/g,
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

  /*
   * A REPEAT MUST DOMINATE THE VALUE, NOT MERELY OCCUR IN IT.
   *
   * SPEC: finding ENGINEERING-SECRETS-AND-EXECUTION-EVIDENCE/SEC-PLACEHOLDER-1 (MEDIUM),
   * 1.0.1 security review.
   *
   * This was `/(.)\1{3,}/` — four identical characters ANYWHERE. A masked value is mostly one
   * character repeated; a genuine forty-character token contains a four-character run by
   * coincidence often enough to matter, and every such token was silently downgraded out of
   * the blocking set. The downgrade is what decides enforcement, since `blocking` requires a
   * HIGH, so a coincidence disarmed the scan on a real credential.
   *
   * The distinguishing property was never "contains a repeat" but "is degenerate". A masked
   * value's longest run covers most of it and its alphabet is tiny; a real credential's does
   * neither, whatever unlucky substring it happens to contain.
   */
  const run = longestRun(alnum);
  if (alnum.length > 0 && run >= Math.max(4, Math.ceil(alnum.length / 2))) return true;

  /* `XXXXXXXXXXXX`, `000000000000`, `abababababab` — a handful of characters, endlessly. */
  const distinct = new Set(alnum.toLowerCase()).size;
  if (alnum.length >= 8 && distinct <= 3) return true;

  return /^[x0*]+$/i.test(alnum);
}

/** The longest run of one repeated character. */
function longestRun(s: string): number {
  let best = 0;
  let run = 0;
  let prev = '';
  for (const ch of s) {
    run = ch === prev ? run + 1 : 1;
    prev = ch;
    if (run > best) best = run;
  }
  return best;
}

/** A report safe to show a model or write to a trace: no values, ever. */
export function redactedReport(result: SecretsScanResult): string {
  /*
   * WHAT WAS NOT READ BELONGS IN THE REPORT, NOT ONLY IN THE FIELD.
   *
   * SPEC: findings SEC-SCAN-LARGEFILE-1 and SEC-SCAN-SKIP-SILENT-2 (both MEDIUM), 1.0.1 review.
   *
   * This is the detail an owner actually reads, and with no findings it returned a single
   * sentence about the files that WERE scanned - so a change whose only unscanned file was the
   * one holding a key was described as 'nothing matched'. The sentence was true and the
   * impression it left was not.
   */
  const gaps =
    result.notScanned.length === 0
      ? []
      : [
          String(result.notScanned.length) + ' file(s) in this change were NOT read:',
          ...result.notScanned.map((n) => '  ' + n.path + '  (' + n.reason + ')'),
          'Nothing is claimed about those files.',
        ];
  if (result.findings.length === 0) {
    return [
      'No credential-shaped content matched the rule set across ' +
        String(result.filesScanned) +
        ' scanned file(s). This means nothing matched these rules; it is not a security review.',
      ...gaps,
    ].join('\n');
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
  lines.push(...gaps);
  return lines.join('\n');
}
