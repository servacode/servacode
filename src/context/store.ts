import { z } from 'zod';
import { canonicalJson, digestOf } from '../core/hash.js';
import { fail } from '../core/errors.js';
import { TrustLevel } from '../vocab/index.js';
import type { ContextBundle } from '../engine/types.js';
import type { Store, Transaction } from '../store/store.js';

/**
 * ContextBundle persistence. SPEC: 19 CX-5, 08 Q12.
 *
 * > "The bundle is persisted and reconstructible. `08` Q12 (*what did this run see?*)
 * > must be answerable later."
 *
 * The previous implementation recorded only counts on the `CONTEXT_BOUND` event —
 * six elements, two untrusted, one exclusion. That answers "how much did the run see",
 * which is a different and much weaker question. A digest with nothing to verify it
 * against is a checksum of something nobody kept.
 *
 * **Tier: T-CANON.** A bundle is established truth about a run that already happened,
 * it must never change afterwards, and 08's canon tier already gives immutability,
 * versioning and digest verification on read. Putting it in T-WORKING would make it
 * mutable, and inventing a fourth tier to hold it would be inventing a history model
 * the specification already has.
 */

export const CONTEXT_CANON_TYPE = 'contextBundle';

const ContextElementSchema = z
  .object({
    id: z.string().min(1),
    source: z.string().min(1),
    kind: z.string().min(1),
    trust: z.nativeEnum(TrustLevel),
    version: z.string(),
    digest: z.string().length(64),
    content: z.string(),
    reasonIncluded: z.string().min(1),
    relevance: z.number(),
  })
  .strict();

const ContextExclusionSchema = z
  .object({
    subject: z.string().min(1),
    reason: z.string().min(1),
    kind: z.enum(['BUDGET', 'RELEVANCE', 'ROLE_RESTRICTION', 'POLICY']),
  })
  .strict();

/**
 * `.strict()` so a field added to ContextBundle without being persisted is a loud
 * failure rather than a silent gap in the record of what a run was shown.
 */
export const PersistedContextBundleSchema = z
  .object({
    id: z.string().min(1),
    agentId: z.string().min(1),
    taskId: z.string().min(1),
    workItemId: z.string().min(1),
    elements: z.array(ContextElementSchema),
    exclusions: z.array(ContextExclusionSchema),
    storeVersion: z.number().int().nonnegative(),
    budget: z.object({ maxChars: z.number().int(), usedChars: z.number().int() }).strict(),
    builtAt: z.string(),
    digest: z.string().length(64),
  })
  .strict();

export type PersistedContextBundle = z.output<typeof PersistedContextBundleSchema>;

/**
 * Recompute a bundle's digest from its contents.
 *
 * Must match `ContextBundleBuilder.build` exactly. It is defined once, here, and the
 * builder calls it — a second copy would drift and every reconstruction would then
 * report tampering.
 */
export function computeBundleDigest(bundle: {
  agentId: string;
  taskId: string;
  workItemId: string;
  elements: readonly { source: string; digest: string; trust: TrustLevel }[];
  exclusions: readonly { subject: string; reason: string; kind: string }[];
}): string {
  return digestOf(
    canonicalJson({
      agentId: bundle.agentId,
      taskId: bundle.taskId,
      workItemId: bundle.workItemId,
      elements: bundle.elements.map((e) => ({
        source: e.source,
        digest: e.digest,
        trust: e.trust,
      })),
      exclusions: bundle.exclusions,
    }),
  );
}

/**
 * Persist a bundle. Called BEFORE the engine is invoked, so a run that dies mid-flight
 * still leaves behind exactly what it was given.
 */
export function persistContextBundle(tx: Transaction, bundle: ContextBundle): void {
  const parsed = PersistedContextBundleSchema.safeParse(bundle);
  if (!parsed.success) {
    fail({
      code: 'E_VALIDATION',
      message: 'ContextBundle ' + bundle.id + ' cannot be persisted in full',
      remedy:
        'Every field of a bundle must be storable, or "what did this run see?" is unanswerable (19 CX-5).',
      details: { issues: parsed.error.issues.slice(0, 5) },
      specRef: '19 CX-5',
    });
  }
  tx.putCanon(CONTEXT_CANON_TYPE, bundle.id, bundle);
}

/**
 * Reconstruct a bundle exactly as the run received it.
 *
 * Three failures are distinguished, because they mean different things: the bundle was
 * never stored, the stored record is malformed, or the record is intact but its
 * contents no longer hash to the digest recorded at build time. The last is tampering
 * or corruption and is reported as such — T-CANON already verifies its own envelope
 * digest on read, and this verifies the bundle's own content digest on top of it.
 */
export function readContextBundle(store: Store, bundleId: string): PersistedContextBundle {
  const env = store.getCanon<unknown>(CONTEXT_CANON_TYPE, bundleId);
  if (env === undefined) {
    return fail({
      code: 'E_NOT_FOUND',
      message: 'Context bundle ' + bundleId + ' is not in this project',
      remedy:
        'A run references a bundle the store does not hold. Either the run belongs to another project, or the store is incomplete (19 CX-5).',
      details: { bundleId },
      specRef: '19 CX-5',
    });
  }

  const parsed = PersistedContextBundleSchema.safeParse(env.body);
  if (!parsed.success) {
    return fail({
      code: 'E_STORE_CORRUPT',
      message: 'Context bundle ' + bundleId + ' is malformed',
      remedy:
        'The record does not match the bundle schema. Restore from a verified backup (22 §5.1).',
      details: { bundleId, issues: parsed.error.issues.slice(0, 5) },
      specRef: '19 CX-5',
    });
  }
  const bundle = parsed.data;

  const recomputed = computeBundleDigest(bundle);
  if (recomputed !== bundle.digest) {
    return fail({
      code: 'E_STORE_CORRUPT',
      message: 'Context bundle ' + bundleId + ' does not match its recorded digest',
      remedy:
        'The stored bundle was modified after the run saw it. What the run was shown can no longer be established; quarantine and restore from a verified backup (22 §5.1).',
      details: { bundleId, recorded: bundle.digest, recomputed },
      specRef: '19 CX-5, 08 KI-1',
    });
  }

  // Each element also carries its own digest, so a single altered element is located
  // rather than merely detected somewhere in the bundle.
  for (const e of bundle.elements) {
    const expected = digestOf(
      canonicalJson({
        source: e.source,
        kind: e.kind,
        trust: e.trust,
        version: e.version,
        content: e.content,
        reasonIncluded: e.reasonIncluded,
        relevance: e.relevance,
      }),
    );
    if (expected !== e.digest) {
      return fail({
        code: 'E_STORE_CORRUPT',
        message:
          'Context element ' + e.id + ' (' + e.source + ') in bundle ' + bundleId + ' was altered',
        remedy: 'Quarantine and restore from a verified backup (22 §5.1).',
        details: { bundleId, elementId: e.id, source: e.source },
        specRef: '19 CX-5, 08 KI-1',
      });
    }
  }

  return bundle;
}

/** Non-throwing sweep for `serva doctor`. */
export function verifyContextBundles(store: Store): {
  checked: number;
  problems: { bundleId: string; problem: string }[];
} {
  const problems: { bundleId: string; problem: string }[] = [];
  let checked = 0;
  for (const id of store.listCanonIds(CONTEXT_CANON_TYPE)) {
    checked += 1;
    try {
      readContextBundle(store, id);
    } catch (e) {
      problems.push({ bundleId: id, problem: e instanceof Error ? e.message : String(e) });
    }
  }
  return { checked, problems };
}
