import { SourceMarking } from '../../vocab/index.js';
import { ARTIFACT_TYPES, repository } from '../repository.js';
import type { z } from 'zod';
import type { ContextElement, DepartmentContext } from '../execution/types.js';
import type { IntelligenceMeta, Provenance } from '../provenance.js';
import type { Store } from '../../store/store.js';

/**
 * Shared helpers for department configurations.
 *
 * Everything here is convenience, not semantics. Nothing in this file may decide whether
 * a run is permitted, what it may read, or whether its output is acceptable — those live
 * in the runner, once, so that a department cannot get them subtly wrong.
 */

/** Build the provenance envelope for something a department derived from canon. */
export function derived(
  ctx: DepartmentContext,
  agentId: string,
  from: readonly string[],
  rationale: string,
  runId?: string,
): IntelligenceMeta {
  const provenance: Provenance = {
    marking: SourceMarking.DERIVED,
    from: from.length > 0 ? [...from] : ['owner intake'],
    rationale,
  };
  return {
    provenance,
    attribution: {
      ...(runId === undefined ? {} : { runId }),
      agentId,
      at: ctx.clock.now(),
    },
    stageId: ctx.stage.stageId,
    workItemId: ctx.workItemId,
  };
}

/** The owner said it. Kept verbatim where the words themselves matter. */
export function ownerStated(ctx: DepartmentContext, verbatim?: string): IntelligenceMeta {
  return {
    provenance: {
      marking: SourceMarking.OWNER_STATED,
      statedAt: ctx.clock.now(),
      ...(verbatim === undefined ? {} : { verbatim }),
    },
    attribution: { at: ctx.clock.now() },
    stageId: ctx.stage.stageId,
    workItemId: ctx.workItemId,
  };
}

/**
 * An inference, with its promotion rule already applied.
 *
 * A department that wants to state something load-bearing must supply the Assumption id;
 * the repository refuses it otherwise. Making that explicit here means the department
 * author meets the rule while writing the code rather than while debugging a refusal.
 */
export function inferred(
  ctx: DepartmentContext,
  agentId: string,
  basis: string,
  confidence: 'LOW' | 'MEDIUM' | 'HIGH',
  loadBearing: boolean,
  assumptionId?: string,
): IntelligenceMeta {
  return {
    provenance: {
      marking: SourceMarking.INFERRED,
      basis,
      confidence,
      loadBearing,
      ...(assumptionId === undefined ? {} : { assumptionId }),
    },
    attribution: { agentId, at: ctx.clock.now() },
    stageId: ctx.stage.stageId,
    workItemId: ctx.workItemId,
  };
}

/** Render a set of artifacts into one context element. */
export function contextFrom<T extends { id: string }>(
  source: string,
  kind: string,
  items: readonly T[],
  render: (item: T) => string,
  relevance: number,
): ContextElement | undefined {
  if (items.length === 0) return undefined;
  return {
    source,
    kind,
    version: '1',
    content: items.map((i) => '- [' + i.id + '] ' + render(i)).join('\n'),
    relevance,
  };
}

/** Convenience: read a whole family. Departments select; the runner records exclusions. */
export function readAll<S extends z.ZodTypeAny>(
  store: Store,
  type: (typeof ARTIFACT_TYPES)[keyof typeof ARTIFACT_TYPES],
  schema: S,
): readonly z.output<S>[] {
  return repository(store, type, schema).list();
}
