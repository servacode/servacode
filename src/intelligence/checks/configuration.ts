import { Severity } from '../../vocab/index.js';
import { ConfigClassification } from '../artifacts/admin.js';
import type {
  AdminAuditRequirement,
  AdminOperabilityReview,
  ConfigurationRegister,
  OperationalControl,
  ProtectedRule,
} from '../artifacts/admin.js';
import type { Feature } from '../artifacts/product.js';
import type { TraceFinding } from './traceability.js';

/**
 * SC-RTC-008 — CONFIGURATION CONSISTENCY CHECKER.
 *
 * SPEC: §28, 12, 30 §5.
 *
 * Its output is measured evidence. That distinction matters here more than almost
 * anywhere else, because every problem it finds is one an agent will confidently assure
 * you does not exist: "of course the commission rate is protected", "obviously deleting a
 * merchant is audited". Confidence is free; the cross-check is not.
 *
 * The contradiction it exists to catch: a rule declared PROTECTED in one artifact and
 * exposed as an ordinary operator setting in another. Both artifacts are individually
 * coherent. Only comparing them reveals that the company has written down two opposite
 * intentions and will ship whichever one the implementer reads first.
 */

export interface ConfigCheckInput {
  readonly features: readonly Feature[];
  readonly reviews: readonly AdminOperabilityReview[];
  readonly register?: ConfigurationRegister;
  readonly protectedRules: readonly ProtectedRule[];
  readonly auditRequirements: readonly AdminAuditRequirement[];
  readonly controls: readonly OperationalControl[];
}

const finding = (
  code: string,
  severity: Severity,
  subject: string,
  statement: string,
): TraceFinding => ({ code, severity, subject, statement });

/** Loose containment, so "commission rate" matches "merchant commission rate (%)". */
function mentions(haystack: string, needle: string): boolean {
  const a = haystack.toLowerCase();
  const b = needle.toLowerCase().trim();
  if (b.length < 4) return false;
  return a.includes(b) || b.includes(a);
}

export function checkConfiguration(input: ConfigCheckInput): readonly TraceFinding[] {
  const out: TraceFinding[] = [];
  const entries = input.register?.entries ?? [];

  /* --- 1. every feature must have been reviewed for operability --- */
  const reviewed = new Set(input.reviews.map((r) => r.featureRef.id));
  for (const f of input.features) {
    if (reviewed.has(f.id)) continue;
    out.push(
      finding(
        'NO_OPERABILITY_REVIEW',
        Severity.BLOCKING,
        f.id,
        'Feature "' + f.name + '" has no AdminOperabilityReview',
      ),
    );
  }

  /* --- 2. a review that never concluded is an unanswered question, not an answer --- */
  for (const r of input.reviews) {
    if (!r.concluded) {
      out.push(
        finding(
          'REVIEW_INCONCLUSIVE',
          Severity.MAJOR,
          r.id,
          'AdminOperabilityReview for ' + r.featureRef.id + ' was never concluded',
        ),
      );
    }
  }

  /* --- 3. anything a review calls configurable must be classified in the register --- */
  for (const r of input.reviews) {
    for (const element of r.whatIsConfigurable) {
      const classified = entries.some((e) => mentions(e.element, element));
      if (!classified) {
        out.push(
          finding(
            'CONFIG_UNCLASSIFIED',
            Severity.BLOCKING,
            r.id,
            '"' +
              element +
              '" is described as configurable but appears in no ConfigurationRegister entry, so nobody has decided who may change it',
          ),
        );
      }
    }
  }

  /* --- 4. THE CONTRADICTION: a protected rule exposed as an ordinary setting --- */
  for (const rule of input.protectedRules) {
    for (const e of entries) {
      if (!mentions(e.element, rule.rule)) continue;
      if (e.classification === ConfigClassification.OPERATOR_CONFIGURABLE) {
        out.push(
          finding(
            'PROTECTED_RULE_EXPOSED',
            Severity.BLOCKING,
            e.element,
            '"' +
              e.element +
              '" is OPERATOR_CONFIGURABLE, but "' +
              rule.rule +
              '" is a ProtectedRule (' +
              rule.protectionReason +
              '): the company has written down two opposite intentions',
          ),
        );
      }
    }
    // ...and a rule declared protected that the register never mentions at all.
    const knownToRegister = entries.some((e) => mentions(e.element, rule.rule));
    if (!knownToRegister) {
      out.push(
        finding(
          'PROTECTED_RULE_UNREGISTERED',
          Severity.ADVISORY,
          rule.id,
          'ProtectedRule "' +
            rule.rule +
            '" does not appear in the ConfigurationRegister, so nothing stops it being added as a setting later',
        ),
      );
    }
  }

  /* --- 5. an action requiring audit with no audit requirement --- */
  for (const e of entries) {
    if (!e.requiresAudit) continue;
    const covered = input.auditRequirements.some((a) => mentions(a.action, e.element));
    if (!covered) {
      out.push(
        finding(
          'AUDIT_REQUIREMENT_MISSING',
          Severity.BLOCKING,
          e.element,
          '"' +
            e.element +
            '" is marked as requiring audit, but no AdminAuditRequirement describes what to capture',
        ),
      );
    }
  }

  /* --- 6. historically significant values that would rewrite the past --- */
  for (const e of entries) {
    if (e.historicallySignificant && !e.effectiveDated) {
      out.push(
        finding(
          'HISTORY_NOT_EFFECTIVE_DATED',
          Severity.BLOCKING,
          e.element,
          '"' +
            e.element +
            '" is historically significant but not effective-dated: changing it would retroactively rewrite what past records mean',
        ),
      );
    }
  }

  /* --- 7. controls: destructive without a guardrail, and irreversible without an audit --- */
  for (const c of input.controls) {
    /*
     * TWO DIFFERENT PROPERTIES, TWO DIFFERENT QUESTIONS.
     *
     * SPEC: sibling of HIGH finding ORGANIZATIONAL-LEARNING-GATES-CHECKS-AND-VIEWS/OL-1,
     * found by auditing every consumer and every emission of this checker.
     *
     * The irreversibility check sat inside `if (!c.destructive) continue`, so it only ever
     * ran for DESTRUCTIVE controls — while its own finding says nothing about destruction:
     * "irreversible and unaudited, so an incident would have no record of who did it". A
     * control that merely cannot be undone, like sending every customer an invoice, was never
     * asked the question at all.
     *
     * Same class as OL-1 in the other direction: there the finding was produced and nobody
     * read it; here nobody could produce it for the case it names.
     */
    const hasGuardrail = (c.guardrail ?? '').trim() !== '';
    if (c.destructive && !hasGuardrail) {
      out.push(
        finding(
          'DESTRUCTIVE_WITHOUT_GUARDRAIL',
          Severity.BLOCKING,
          c.id,
          'OperationalControl "' +
            c.name +
            '" is destructive with no guardrail: no confirmation, no reversal, one mis-click',
        ),
      );
    }
    /*
     * IRREVERSIBLE AND UNAUDITED BLOCKS, WHETHER OR NOT IT DESTROYS ANYTHING.
     *
     * OWNER DECISION, 1.0.1 acceptance. This was MAJOR — reported, not blocking — and the
     * owner raised it: a control that cannot be undone and leaves no record of who used it
     * breaches a basic security and operability condition on its own. Being destructive as
     * well makes it worse; it is not what makes it serious.
     *
     * Recorded as a decision rather than a preference because it changes what the DESIGN gate
     * refuses, and the next person to read this is entitled to know it was chosen and why.
     * The condition is deliberately not conjoined with `destructive`: irreversible with no
     * audit requirement is the whole rule.
     */
    if (!c.reversible && c.auditRequirementRef === undefined) {
      out.push(
        finding(
          'IRREVERSIBLE_WITHOUT_AUDIT',
          Severity.BLOCKING,
          c.id,
          'OperationalControl "' +
            c.name +
            '" is irreversible and unaudited, so an incident would have no record of who did it',
        ),
      );
    }
  }

  return out;
}
