import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail } from '../core/errors.js';
import { getCatalogues } from '../catalogue/index.js';
import {
  AgentContractSchema,
  ContractRegistryFileSchema,
  SCHEMA_FIELD_COUNT,
  type AgentContract,
  type ContractRegistryFile,
} from './schema.js';

/**
 * AgentContract registry.
 *
 * SPEC: 32 (catalogue), 30 §4 (membership), 05 §2 (schema).
 *
 * Loads the generated artifact, validates it against the schema, and cross-checks it
 * against the canonical catalogue. The generator already refuses to emit an
 * unresolved contract; this repeats the membership checks at load because the two
 * artifacts are regenerated independently and a stale one is exactly the failure this
 * catches (30 CAT-2).
 */

const here = dirname(fileURLToPath(import.meta.url));

function locate(): string {
  return join(here, 'generated', 'contracts.json');
}

let cached: ContractRegistry | undefined;

export interface ContractProblem {
  readonly agentId: string;
  readonly problem: string;
}

export class ContractRegistry {
  private readonly byId: ReadonlyMap<string, AgentContract>;

  private constructor(readonly file: ContractRegistryFile) {
    this.byId = new Map(file.contracts.map((c) => [c.id, c]));
  }

  static load(path = locate()): ContractRegistry {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, 'utf8'));
    } catch (cause) {
      return fail({
        code: 'E_CONFIG',
        message: 'Cannot read the generated AgentContract registry at ' + path,
        remedy: 'Run `npm run contracts` to regenerate it from 32_AGENT_CONTRACT_CATALOG.md.',
        details: { path },
        cause,
      });
    }
    const parsed = ContractRegistryFileSchema.safeParse(raw);
    if (!parsed.success) {
      return fail({
        code: 'E_VALIDATION',
        message: 'The AgentContract registry does not satisfy the contract schema',
        remedy:
          'The generator and the schema disagree. Regenerate with `npm run contracts`; if it still fails, the schema in src/agents/schema.ts and 05 §2 have drifted apart.',
        details: { path, issues: parsed.error.issues.slice(0, 10) },
        specRef: '05 §2, 32 §8',
      });
    }
    const reg = new ContractRegistry(parsed.data);
    const problems = reg.validateAgainstCatalogue();
    if (problems.length > 0) {
      return fail({
        code: 'E_VALIDATION',
        message: 'AgentContract registry disagrees with the canonical catalogue (30 §4)',
        remedy:
          'One of the two generated artifacts is stale. Run `npm run catalogues && npm run contracts`.',
        details: { problems: problems.slice(0, 10), problemCount: problems.length },
        specRef: '30 CAT-2',
      });
    }
    return reg;
  }

  /** Cached singleton for the common case. */
  static shared(): ContractRegistry {
    cached ??= ContractRegistry.load();
    return cached;
  }

  /** Test seam: drop the cache so a test can load a fixture registry. */
  static resetShared(): void {
    cached = undefined;
  }

  all(): readonly AgentContract[] {
    return this.file.contracts;
  }

  has(agentId: string): boolean {
    return this.byId.has(agentId);
  }

  get(agentId: string): AgentContract {
    const c = this.byId.get(agentId);
    if (c === undefined) {
      return fail({
        code: 'E_NOT_FOUND',
        message: 'Unknown agent: ' + agentId,
        remedy: 'Agent identifiers come from 30 §4. Run `serva agents` to list them.',
        details: { agentId },
        specRef: '30 §4',
      });
    }
    return c;
  }

  byDepartment(departmentId: string): readonly AgentContract[] {
    return this.file.contracts.filter((c) => c.department === departmentId);
  }

  /**
   * Cross-check the registry against 30 §4 and against the resolution invariants.
   * Returns problems rather than throwing so `serva doctor` can report them all.
   */
  validateAgainstCatalogue(): readonly ContractProblem[] {
    const problems: ContractProblem[] = [];
    const cat = getCatalogues();
    const canonical = new Map(cat.agents.map((a) => [a.id, a]));
    const deptIds = new Set(cat.departments.map((d) => d.id));
    const contractIds = new Set(this.file.contracts.map((c) => c.id));

    for (const a of cat.agents) {
      if (!contractIds.has(a.id)) {
        problems.push({ agentId: a.id, problem: 'canonical agent has no contract (32 §5)' });
      }
    }

    for (const c of this.file.contracts) {
      const known = canonical.get(c.id);
      if (known === undefined) {
        problems.push({ agentId: c.id, problem: 'contract references an agent absent from 30 §4' });
        continue;
      }
      if (known.departmentId !== c.department) {
        problems.push({
          agentId: c.id,
          problem:
            'department ' + c.department + ' disagrees with 30 §4 (' + known.departmentId + ')',
        });
      }
      if (!deptIds.has(c.department)) {
        problems.push({
          agentId: c.id,
          problem: 'department ' + c.department + ' is not in 30 §3',
        });
      }
      if (known.archetype !== c.archetype) {
        problems.push({
          agentId: c.id,
          problem: 'archetype ' + c.archetype + ' disagrees with 30 §4 (' + known.archetype + ')',
        });
      }
      if (known.authority !== c.authorityLevel) {
        problems.push({
          agentId: c.id,
          problem:
            'authority ' + c.authorityLevel + ' disagrees with 30 §4 (' + known.authority + ')',
        });
      }
      // CR-R8: the resolved field set is exactly the field set in 05 §2.
      const resolved = Object.keys(c.resolution).length;
      if (resolved !== SCHEMA_FIELD_COUNT) {
        problems.push({
          agentId: c.id,
          problem:
            'resolves ' + String(resolved) + ' fields, expected ' + String(SCHEMA_FIELD_COUNT),
        });
      }
      // CR-R2: every inherited block named in a resolution appears in `inherits`.
      for (const [field, kind] of Object.entries(c.resolution)) {
        for (const m of kind.matchAll(/INHERITED\(([^)]*)\)/g)) {
          for (const block of (m[1] ?? '').split(',').map((b) => b.trim())) {
            if (block.length === 0 || block === 'undefined') {
              problems.push({ agentId: c.id, problem: field + ' names an empty inherited block' });
              continue;
            }
            if (!c.inherits.includes(block)) {
              problems.push({
                agentId: c.id,
                problem:
                  field + ' inherits ' + block + ' which is not in its inherits list (CR-R2)',
              });
            }
          }
        }
      }
      // R-COI relations must name agents that exist.
      for (const rel of c.conflictOfInterest.derived) {
        for (const other of rel.with) {
          if (/^SC-AGENT-\d{3}$/.test(other) && !canonical.has(other)) {
            problems.push({
              agentId: c.id,
              problem: 'conflict-of-interest relation names unknown agent ' + other,
            });
          }
        }
      }
    }
    return problems;
  }

  /**
   * 32 §6 (R-COI) plus the universal rule: may two agents share an actor within one
   * work item? Used by plan validation before dispatch, not after.
   */
  conflicts(agentA: string, agentB: string): string | undefined {
    if (agentA === agentB) return undefined;
    const a = this.byId.get(agentA);
    if (a === undefined) return undefined;
    for (const rel of a.conflictOfInterest.derived) {
      if (rel.with.includes(agentB)) return rel.basis;
    }
    const b = this.byId.get(agentB);
    if (b !== undefined) {
      for (const rel of b.conflictOfInterest.derived) {
        if (rel.with.includes(agentA)) return rel.basis;
      }
    }
    // "Any Tier 4 producer" / "Any producer" pairs are stated in prose in 32 §6.
    // They are expanded here rather than in the generator because they quantify over
    // archetype and tier, which the generator cannot resolve into a fixed id list
    // without freezing the catalogue into the artifact twice.
    if (b !== undefined) {
      for (const [producer, verifier] of [
        [a, b],
        [b, a],
      ] as const) {
        if (producer.archetype === 'PRODUCER' && verifier.id === 'SC-AGENT-200') {
          return 'Implemented vs. reviewed (32 §6)';
        }
        if (producer.archetype === 'PRODUCER' && verifier.id === 'SC-AGENT-240') {
          return 'Produced vs. accepted (32 §6)';
        }
      }
    }
    return undefined;
  }
}

export function parseAgentContract(value: unknown): AgentContract {
  const parsed = AgentContractSchema.safeParse(value);
  if (!parsed.success) {
    return fail({
      code: 'E_VALIDATION',
      message: 'Value is not a valid AgentContract',
      remedy: 'Contracts are generated from 32; do not construct them by hand.',
      details: { issues: parsed.error.issues.slice(0, 5) },
      specRef: '05 §2',
    });
  }
  return parsed.data;
}
