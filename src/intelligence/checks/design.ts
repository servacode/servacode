import { Severity } from '../../vocab/index.js';
import { REQUIRED_COMPONENT_STATES, REQUIRED_TOKEN_CATEGORIES } from '../artifacts/design.js';
import { missingStates } from '../artifacts/ux.js';
import type {
  AccessibilitySpec,
  ComponentSpec,
  DesignException,
  DesignTokenSet,
} from '../artifacts/design.js';
import type { StateCoverage } from '../artifacts/ux.js';
import type { TraceFinding } from './traceability.js';
import type { Clock } from '../../core/clock.js';

/**
 * DETERMINISTIC DESIGN CHECKS.
 *
 * SPEC: §26, 13, SC-RTC-017 (accessibility automated checker).
 *
 * These are the design rules a machine can actually decide. That set is smaller than
 * people expect and larger than most projects check: token completeness, semantic
 * references, component state coverage, RTL directional properties, contrast ratios,
 * target sizes, and whether an "exception" quietly became permanent.
 *
 * What is deliberately NOT here is any claim of accessibility conformance. An automated
 * checker finds a minority of real accessibility defects, and reporting its silence as
 * WCAG compliance is a false statement about a legal standard. `formalConformanceClaimed`
 * is a literal `false` in the schema for that reason, and this module never contradicts it.
 */

const finding = (
  code: string,
  severity: Severity,
  subject: string,
  statement: string,
): TraceFinding => ({ code, severity, subject, statement });

/** A raw value where a semantic token should be. */
const RAW_VALUE = /^(#[0-9a-f]{3,8}|rgba?\(|hsla?\(|\d+(\.\d+)?(px|rem|em|%)$)/i;

/** Physical properties that break under RTL; the logical equivalent is required. */
const PHYSICAL_PROPERTIES: readonly string[] = Object.freeze([
  'margin-left',
  'margin-right',
  'padding-left',
  'padding-right',
  'border-left',
  'border-right',
  'left',
  'right',
  'text-align: left',
  'text-align: right',
]);

export interface DesignCheckInput {
  readonly tokens?: DesignTokenSet;
  readonly components: readonly ComponentSpec[];
  readonly coverage: readonly StateCoverage[];
  readonly exceptions: readonly DesignException[];
  readonly accessibility?: AccessibilitySpec;
  readonly clock: Clock;
}

export function checkDesign(input: DesignCheckInput): readonly TraceFinding[] {
  const out: TraceFinding[] = [];

  /* --- 1. token completeness --- */
  if (input.tokens === undefined) {
    out.push(
      finding(
        'TOKENS_MISSING',
        Severity.BLOCKING,
        'design-system',
        'No DesignTokenSet exists, so every downstream value would be an arbitrary one',
      ),
    );
  } else {
    const categories = new Set(input.tokens.semantic.map((t) => t.category.toLowerCase()));
    for (const required of REQUIRED_TOKEN_CATEGORIES) {
      if (!categories.has(required.toLowerCase())) {
        out.push(
          finding(
            'TOKEN_CATEGORY_MISSING',
            Severity.MAJOR,
            required,
            'The token set defines no semantic tokens for "' + required + '"',
          ),
        );
      }
    }

    /* --- 2. semantic tokens must reference a primitive that exists --- */
    const primitiveNames = new Set(input.tokens.primitives.map((p) => p.name));
    for (const t of input.tokens.semantic) {
      if (RAW_VALUE.test(t.references)) {
        out.push(
          finding(
            'SEMANTIC_TOKEN_RAW_VALUE',
            Severity.MAJOR,
            t.name,
            'Semantic token "' +
              t.name +
              '" resolves to the raw value "' +
              t.references +
              '" instead of a primitive, which defeats the indirection it exists for',
          ),
        );
        continue;
      }
      if (primitiveNames.size > 0 && !primitiveNames.has(t.references)) {
        out.push(
          finding(
            'SEMANTIC_TOKEN_DANGLING',
            Severity.MAJOR,
            t.name,
            'Semantic token "' +
              t.name +
              '" references "' +
              t.references +
              '", which is not a defined primitive',
          ),
        );
      }
    }
  }

  /* --- 3. component state completeness, and no raw values in components --- */
  for (const c of input.components) {
    const defined = new Set(c.states.map((s) => s.state.toLowerCase()));
    for (const required of REQUIRED_COMPONENT_STATES) {
      if (!defined.has(required)) {
        out.push(
          finding(
            'COMPONENT_STATE_MISSING',
            Severity.BLOCKING,
            c.name,
            'Component "' + c.name + '" does not define its "' + required + '" state',
          ),
        );
      }
    }
    for (const s of c.states) {
      for (const token of s.tokens) {
        if (RAW_VALUE.test(token)) {
          out.push(
            finding(
              'COMPONENT_RAW_VALUE',
              Severity.MAJOR,
              c.name,
              'Component "' +
                c.name +
                '" state "' +
                s.state +
                '" uses the raw value "' +
                token +
                '" instead of a semantic token',
            ),
          );
        }
      }
    }

    /* --- 4. RTL: physical properties must be classified --- */
    if (c.rtl.mirrors) {
      for (const prop of c.rtl.directionalProperties) {
        if (PHYSICAL_PROPERTIES.some((p) => prop.toLowerCase().includes(p))) {
          out.push(
            finding(
              'RTL_PHYSICAL_PROPERTY',
              Severity.MAJOR,
              c.name,
              'Component "' +
                c.name +
                '" mirrors under RTL but uses the physical property "' +
                prop +
                '"; the logical equivalent is required',
            ),
          );
        }
      }
    }

    /* --- 5. target size, where the component states one --- */
    const min = input.accessibility?.minTargetPx;
    const declared = c.a11y.minTargetPx;
    if (min !== undefined && declared !== undefined && declared < min) {
      out.push(
        finding(
          'TARGET_TOO_SMALL',
          Severity.MAJOR,
          c.name,
          'Component "' +
            c.name +
            '" declares a ' +
            String(declared) +
            'px target, below the ' +
            String(min) +
            'px minimum',
        ),
      );
    }
  }

  /* --- 6. UX state coverage --- */
  for (const cov of input.coverage) {
    const missing = missingStates(cov);
    for (const m of missing) {
      out.push(
        finding(
          'UI_STATE_UNCOVERED',
          Severity.BLOCKING,
          cov.screen,
          '"' +
            cov.screen +
            '" does not say what happens in the ' +
            m +
            ' state, and does not say why it cannot occur',
        ),
      );
    }
  }

  /* --- 7. expired exceptions --- */
  const now = Date.parse(input.clock.now());
  for (const e of input.exceptions) {
    if (Date.parse(e.expiresAt) <= now) {
      out.push(
        finding(
          'DESIGN_EXCEPTION_EXPIRED',
          Severity.MAJOR,
          e.id,
          'Design exception for "' +
            e.scope +
            '" expired on ' +
            e.expiresAt +
            '; a permanent exception is an undocumented second design system',
        ),
      );
    }
  }

  return out;
}

/**
 * WCAG relative luminance, per the published formula.
 *
 * Implemented rather than approximated because contrast is one of the few accessibility
 * properties that IS mechanically decidable, and getting it approximately right would be
 * worse than not checking — it would produce confident, wrong assurances.
 */
export function relativeLuminance(hex: string): number | undefined {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (m === null) return undefined;
  const n = Number.parseInt(m[1] as string, 16);
  const channel = (v: number): number => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const r = channel((n >> 16) & 0xff);
  const g = channel((n >> 8) & 0xff);
  const b = channel(n & 0xff);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Contrast ratio between two hex colours, or undefined if either cannot be parsed. */
export function contrastRatio(a: string, b: string): number | undefined {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  if (la === undefined || lb === undefined) return undefined;
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Check one pair against a required ratio. Returns a finding, or undefined. */
export function checkContrast(
  foreground: string,
  background: string,
  required: number,
  context: string,
): TraceFinding | undefined {
  const ratio = contrastRatio(foreground, background);
  if (ratio === undefined) {
    return finding(
      'CONTRAST_UNCHECKABLE',
      Severity.ADVISORY,
      context,
      'Could not compute contrast for ' + foreground + ' on ' + background,
    );
  }
  if (ratio < required) {
    return finding(
      'CONTRAST_INSUFFICIENT',
      Severity.MAJOR,
      context,
      foreground +
        ' on ' +
        background +
        ' has a contrast ratio of ' +
        ratio.toFixed(2) +
        ':1, below the required ' +
        required.toFixed(1) +
        ':1',
    );
  }
  return undefined;
}
