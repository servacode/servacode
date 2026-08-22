import { z } from 'zod';
import { fail } from '../../core/errors.js';

/**
 * DERIVE THE PROVIDER'S JSON SCHEMA FROM SERVA'S OWN VALIDATOR.
 *
 * SPEC: 19 SO-2.
 *
 * `AgentRuntime` requires both forms — a JSON Schema to shape the provider's output, and
 * Serva's own validator to decide whether the result is acceptable. Keeping them as two
 * hand-written artifacts is a bug factory: they start identical and drift the moment
 * anyone edits one, and the drift is silent. The provider then shapes output to a contract
 * Serva no longer enforces, or Serva rejects payloads the provider was never told about.
 *
 * So the JSON Schema is DERIVED. There is one source of truth, and "the provider says it
 * is valid" and "Serva accepts it" remain two distinct checks of the same intent rather
 * than two independent guesses at it.
 *
 * Deliberately supports only the subset the department schemas use. An unsupported node
 * throws at build time rather than emitting something permissive — a schema that silently
 * degraded to `{}` would hand the provider no shape at all and look like it worked.
 */

type Json = Record<string, unknown>;

function unwrap(schema: z.ZodTypeAny): {
  inner: z.ZodTypeAny;
  optional: boolean;
  hasDefault: boolean;
} {
  let inner = schema;
  let optional = false;
  let hasDefault = false;
  for (;;) {
    const def = inner._def as { typeName?: string; innerType?: z.ZodTypeAny };
    if (def.typeName === 'ZodOptional') {
      optional = true;
      inner = def.innerType as z.ZodTypeAny;
      continue;
    }
    if (def.typeName === 'ZodDefault') {
      hasDefault = true;
      inner = def.innerType as z.ZodTypeAny;
      continue;
    }
    if (def.typeName === 'ZodNullable') {
      inner = def.innerType as z.ZodTypeAny;
      continue;
    }
    break;
  }
  return { inner, optional, hasDefault };
}

function minOf(
  checks: readonly { kind: string; value?: number }[] | undefined,
): number | undefined {
  return checks?.find((c) => c.kind === 'min')?.value;
}

function convert(schema: z.ZodTypeAny, path: string): Json {
  const def = schema._def as {
    typeName?: string;
    shape?: () => Record<string, z.ZodTypeAny>;
    type?: z.ZodTypeAny;
    values?: readonly string[];
    value?: unknown;
    checks?: readonly { kind: string; value?: number }[];
    minLength?: { value: number } | null;
    items?: readonly z.ZodTypeAny[];
    valueType?: z.ZodTypeAny;
  };

  switch (def.typeName) {
    case 'ZodString': {
      const min = minOf(def.checks);
      return min === undefined ? { type: 'string' } : { type: 'string', minLength: min };
    }
    case 'ZodNumber': {
      const isInt = def.checks?.some((c) => c.kind === 'int') === true;
      const min = minOf(def.checks);
      return {
        type: isInt ? 'integer' : 'number',
        ...(min === undefined ? {} : { minimum: min }),
      };
    }
    case 'ZodBoolean':
      return { type: 'boolean' };
    case 'ZodLiteral':
      return { const: def.value };
    case 'ZodEnum':
      return { enum: [...(def.values ?? [])] };
    case 'ZodArray': {
      const min = def.minLength?.value;
      return {
        type: 'array',
        items: convert(def.type as z.ZodTypeAny, path + '[]'),
        ...(min === undefined ? {} : { minItems: min }),
      };
    }
    case 'ZodTuple':
      return {
        type: 'array',
        items: (def.items ?? []).map((t, i) => convert(t, path + '[' + String(i) + ']')),
        minItems: (def.items ?? []).length,
        maxItems: (def.items ?? []).length,
      };
    case 'ZodRecord':
      return {
        type: 'object',
        additionalProperties: convert(def.valueType as z.ZodTypeAny, path + '.*'),
      };
    case 'ZodObject': {
      const shape = def.shape?.() ?? {};
      const properties: Json = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape)) {
        const { inner, optional, hasDefault } = unwrap(value);
        properties[key] = convert(inner, path + '.' + key);
        /*
         * A field with a default is NOT required of the provider — Zod will supply it —
         * but it is still described, so the provider can choose to set it. Marking it
         * required would make every optional list mandatory and produce noise.
         */
        if (!optional && !hasDefault) required.push(key);
      }
      return {
        type: 'object',
        additionalProperties: false,
        ...(required.length === 0 ? {} : { required }),
        properties,
      };
    }
    case 'ZodUnion':
    case 'ZodDiscriminatedUnion': {
      const options = (schema as unknown as { options: readonly z.ZodTypeAny[] }).options;
      return { anyOf: options.map((o, i) => convert(o, path + '|' + String(i))) };
    }
    default:
      return fail({
        code: 'E_VALIDATION',
        message:
          'Cannot derive a JSON Schema for ' + (def.typeName ?? 'an unknown node') + ' at ' + path,
        remedy:
          'Department output schemas use a deliberately small subset. Extend the converter rather than hand-writing a second schema that can drift from the validator.',
        details: { path, typeName: def.typeName },
        specRef: '19 SO-2',
      });
  }
}

/** The provider-facing schema for a department's output validator. */
export function jsonSchemaFor(schema: z.ZodTypeAny): Record<string, unknown> {
  const { inner } = unwrap(schema);
  return convert(inner, '$');
}
