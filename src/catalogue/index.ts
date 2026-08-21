import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail } from '../core/errors.js';

/**
 * Canonical catalogue loading.
 *
 * SPEC: 30 CAT-1 — `30_CANONICAL_CATALOGUES.md` is the sole authoritative source
 * for the membership and cardinality of every catalogue. CAT-2 forbids any other
 * document (or module) from stating a count.
 *
 * This module holds NO hand-written enumeration. It loads the generated JSON that
 * `scripts/generate-catalogues.mjs` extracts from the specification. That script is
 * the single authorized migration path, so a catalogue can never drift from the
 * document that defines it.
 */

export interface DepartmentDef {
  readonly id: string;
  readonly name: string;
  readonly tier: number;
}
export interface AgentDef {
  readonly id: string;
  readonly name: string;
  readonly departmentId: string;
  readonly archetype: string;
  readonly authority: string;
  readonly magnitudeCeiling: string;
}
export interface RuntimeComponentDef {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
}
export interface StageDef {
  readonly id: string;
  readonly name: string;
  readonly phase: string;
  readonly ownerDepartmentId: string;
  readonly gate: string | null;
}
export interface GateDef {
  readonly id: string;
  readonly afterStage: string;
  readonly blocking: boolean;
}
export interface WorkflowDef {
  readonly id: string;
  readonly name: string;
}
export interface PolicyDef {
  readonly id: string;
  readonly name: string;
}

export interface CataloguesFile {
  readonly $generated: {
    readonly from: string;
    readonly specDigest: string;
    readonly note: string;
  };
  readonly departments: readonly DepartmentDef[];
  readonly agents: readonly AgentDef[];
  readonly runtimeComponents: readonly RuntimeComponentDef[];
  readonly stages: readonly StageDef[];
  readonly gates: readonly GateDef[];
  readonly workflows: readonly WorkflowDef[];
  readonly policies: readonly PolicyDef[];
  readonly counts: Readonly<Record<string, number>>;
}

export interface Catalogues extends CataloguesFile {
  readonly departmentIds: readonly string[];
  readonly agentIds: readonly string[];
  readonly stageIds: readonly string[];
  readonly gateIds: readonly string[];
  readonly workflowIds: readonly string[];
  readonly policyIds: readonly string[];
  readonly runtimeComponentIds: readonly string[];
  agent(id: string): AgentDef | undefined;
  department(id: string): DepartmentDef | undefined;
  stage(id: string): StageDef | undefined;
  gate(id: string): GateDef | undefined;
  /** 32 §8.2 R-TIER — tier is DERIVED from department, never stored on the agent. */
  tierOfAgent(agentId: string): number | undefined;
}

let cached: Catalogues | undefined;

function locate(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, 'generated', 'catalogues.json');
}

export function getCatalogues(): Catalogues {
  if (cached !== undefined) return cached;
  const path = locate();
  let raw: CataloguesFile;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8')) as CataloguesFile;
  } catch (cause) {
    return fail({
      code: 'E_CONFIG',
      message: 'Cannot load generated catalogues from ' + path,
      remedy: 'Run `npm run catalogues` to regenerate them from the R4 specification.',
      details: { path },
      cause,
      specRef: '30 CAT-1',
    });
  }

  const deptById = new Map(raw.departments.map((d) => [d.id, d]));
  const agentById = new Map(raw.agents.map((a) => [a.id, a]));
  const stageById = new Map(raw.stages.map((s) => [s.id, s]));
  const gateById = new Map(raw.gates.map((g) => [g.id, g]));

  cached = {
    ...raw,
    departmentIds: raw.departments.map((d) => d.id),
    agentIds: raw.agents.map((a) => a.id),
    stageIds: raw.stages.map((s) => s.id),
    gateIds: raw.gates.map((g) => g.id),
    workflowIds: raw.workflows.map((w) => w.id),
    policyIds: raw.policies.map((p) => p.id),
    runtimeComponentIds: raw.runtimeComponents.map((r) => r.id),
    agent: (id) => agentById.get(id),
    department: (id) => deptById.get(id),
    stage: (id) => stageById.get(id),
    gate: (id) => gateById.get(id),
    tierOfAgent: (agentId) => {
      const a = agentById.get(agentId);
      if (a === undefined) return undefined;
      return deptById.get(a.departmentId)?.tier;
    },
  };
  return cached;
}

/** Test seam. */
export function resetCatalogueCache(): void {
  cached = undefined;
}
