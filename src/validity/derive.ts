import { ValidityState } from '../vocab/index.js';

/**
 * Derived validity. SPEC: 31 §3.2 (BASELINE R4).
 *
 * VD-1: ValidityState is NEVER stored as a mutable field on any record.
 * It is computed from immutable inputs:
 *   the source record, artifact versions, time, revocation/dispute records,
 *   and the dependency graph.
 *
 * This is the reason nothing in the store is ever "marked STALE".
 */

/** A record that can bear validity. Immutable in the store. */
export interface ValidityBearing {
  readonly id: string;
  /** Discriminates INADMISSIBLE applicability (31 §3.1, KI-2c). */
  readonly kind: 'EVIDENCE' | 'GATE_RESULT' | 'ARTIFACT_VERIFIER_RESULT' | 'CRITERION_EVALUATION';
  readonly artifactVersionsCovered: readonly {
    readonly artifactId: string;
    readonly version: number;
  }[];
  readonly dependsOn: readonly string[];
  readonly validUntil?: string;
  /** Evidence only: provenance completeness (16 PV-2). */
  readonly provenanceComplete?: boolean;
}

export interface ValidityContext {
  /** Current version of each artifact. Absent means the artifact no longer exists. */
  currentArtifactVersion(artifactId: string): number | undefined;
  hasRevocation(recordId: string): boolean;
  hasOpenDispute(recordId: string): boolean;
  /** Lookup for dependency propagation (VD-3). */
  getRecord(recordId: string): ValidityBearing | undefined;
  nowMs(): number;
}

/**
 * 31 §3.2 — the only definition.
 *
 * Cycle-safe: a record already on the resolution stack is treated as VALID for the
 * purpose of that inner lookup, so a dependency cycle cannot recurse forever. A
 * genuine cycle is a store-integrity defect detected separately (08 KI-6).
 */
export function deriveValidity(
  record: ValidityBearing,
  ctx: ValidityContext,
  seen: ReadonlySet<string> = new Set(),
): ValidityState {
  if (ctx.hasRevocation(record.id)) return ValidityState.REVOKED;
  if (ctx.hasOpenDispute(record.id)) return ValidityState.DISPUTED;

  if (record.kind === 'EVIDENCE' && record.provenanceComplete === false) {
    return ValidityState.INADMISSIBLE;
  }

  if (record.validUntil !== undefined) {
    const until = Date.parse(record.validUntil);
    if (!Number.isNaN(until) && ctx.nowMs() > until) return ValidityState.EXPIRED;
  }

  for (const covered of record.artifactVersionsCovered) {
    const current = ctx.currentArtifactVersion(covered.artifactId);
    if (current === undefined || current !== covered.version) return ValidityState.STALE;
  }

  // VD-3 — propagation. A record depending on a non-VALID record is itself STALE.
  const nextSeen = new Set(seen);
  nextSeen.add(record.id);
  for (const depId of record.dependsOn) {
    if (nextSeen.has(depId)) continue;
    const dep = ctx.getRecord(depId);
    if (dep === undefined) return ValidityState.STALE;
    if (deriveValidity(dep, ctx, nextSeen) !== ValidityState.VALID) return ValidityState.STALE;
  }

  return ValidityState.VALID;
}

/** Convenience: only VALID records may support a MET criterion result (TX-4). */
export function isUsable(state: ValidityState): boolean {
  return state === ValidityState.VALID;
}

/** In-memory context, used by the CLI and by tests. */
export class MapValidityContext implements ValidityContext {
  private readonly artifacts = new Map<string, number>();
  private readonly revocations = new Set<string>();
  private readonly disputes = new Set<string>();
  private readonly records = new Map<string, ValidityBearing>();
  private now: number;

  constructor(nowMs: number) {
    this.now = nowMs;
  }

  setArtifactVersion(artifactId: string, version: number): void {
    this.artifacts.set(artifactId, version);
  }
  removeArtifact(artifactId: string): void {
    this.artifacts.delete(artifactId);
  }
  revoke(recordId: string): void {
    this.revocations.add(recordId);
  }
  dispute(recordId: string): void {
    this.disputes.add(recordId);
  }
  put(record: ValidityBearing): void {
    this.records.set(record.id, record);
  }
  setNow(ms: number): void {
    this.now = ms;
  }

  currentArtifactVersion(artifactId: string): number | undefined {
    return this.artifacts.get(artifactId);
  }
  hasRevocation(recordId: string): boolean {
    return this.revocations.has(recordId);
  }
  hasOpenDispute(recordId: string): boolean {
    return this.disputes.has(recordId);
  }
  getRecord(recordId: string): ValidityBearing | undefined {
    return this.records.get(recordId);
  }
  nowMs(): number {
    return this.now;
  }
}
