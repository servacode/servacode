import { readFileSync } from 'node:fs';
import { appendLineDurable, fileExists } from './fsutil.js';
import { GENESIS_DIGEST, canonicalJson, chainDigest } from '../core/hash.js';
import { fail } from '../core/errors.js';

/**
 * Append-only, hash-chained trace log. SPEC: 08 §2 (T-TRACE), SC-POL-022, 05 §4.2.
 *
 * This module exposes NO update and NO delete. That is the enforcement: the only
 * mutating operation the type system offers is append. The hash chain makes a
 * retroactive edit made outside this API detectable rather than merely forbidden
 * (08 KI-1).
 *
 * Each record carries an `opId` -- the stable identity of the transaction
 * operation that produced it. Recovery uses it to make replay idempotent
 * (see `appendIdempotent`).
 */

export interface TraceRecord {
  readonly seq: number;
  readonly at: string;
  /** Runtime-written only. No agent may author trace records (SC-POL-029). */
  readonly actor: string;
  readonly type: string;
  readonly payload: unknown;
  readonly prevDigest: string;
  readonly digest: string;
  /** Stable transaction-operation identity: `<txId>#<index>`. */
  readonly opId?: string;
  readonly correlationId?: string;
  readonly causationId?: string;
}

export interface AppendInput {
  readonly at: string;
  readonly actor: string;
  readonly type: string;
  readonly payload: unknown;
  readonly opId?: string;
  readonly correlationId?: string;
  readonly causationId?: string;
}

/** The fields that define what an operation *asked* for, independent of chaining. */
function logicalIdentity(r: {
  at: string;
  actor: string;
  type: string;
  payload: unknown;
  correlationId?: string;
  causationId?: string;
}): string {
  return canonicalJson({
    at: r.at,
    actor: r.actor,
    type: r.type,
    payload: r.payload,
    correlationId: r.correlationId,
    causationId: r.causationId,
  });
}

export class TraceLog {
  constructor(private readonly path: string) {}

  /** Read every record in the stream, in append order. */
  readAll(): TraceRecord[] {
    if (!fileExists(this.path)) return [];
    const text = readFileSync(this.path, 'utf8');
    const out: TraceRecord[] = [];
    let lineNo = 0;
    for (const raw of text.split('\n')) {
      lineNo += 1;
      const line = raw.trim();
      if (line.length === 0) continue;
      try {
        out.push(JSON.parse(line) as TraceRecord);
      } catch (cause) {
        fail({
          code: 'E_STORE_CORRUPT',
          message: 'Unparseable trace record at ' + this.path + ':' + String(lineNo),
          remedy:
            'The trace stream is damaged. Run `serva doctor` and restore from a verified backup (21 §7).',
          details: { path: this.path, line: lineNo },
          cause,
          specRef: '08 KI-1',
        });
      }
    }
    return out;
  }

  head(): { seq: number; digest: string } {
    const all = this.readAll();
    const last = all[all.length - 1];
    if (last === undefined) return { seq: 0, digest: GENESIS_DIGEST };
    return { seq: last.seq, digest: last.digest };
  }

  findByOpId(opId: string): TraceRecord | undefined {
    return this.readAll().find((r) => r.opId === opId);
  }

  /** The only mutating operation. Returns the record actually written. */
  append(input: AppendInput): TraceRecord {
    const { seq, digest: prevDigest } = this.head();
    const nextSeq = seq + 1;
    const body = {
      seq: nextSeq,
      at: input.at,
      actor: input.actor,
      type: input.type,
      payload: input.payload,
      prevDigest,
      ...(input.opId === undefined ? {} : { opId: input.opId }),
      ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }),
      ...(input.causationId === undefined ? {} : { causationId: input.causationId }),
    };
    const record: TraceRecord = { ...body, digest: chainDigest(prevDigest, body) };
    appendLineDurable(this.path, JSON.stringify(record));
    return record;
  }

  /**
   * Append exactly once for a given operation identity.
   *
   * A committed transaction may be replayed any number of times by crash recovery
   * (22 §4.2). Without identity, a crash between "trace appended" and "journal
   * removed" would duplicate an authoritative event on restart.
   *
   * Semantics:
   *  - no record with this opId  -> append, return { applied: true }
   *  - record exists, identical  -> no-op,  return { applied: false }
   *  - record exists, different  -> E_STORE_CORRUPT (never silently skipped)
   *
   * The hash chain is unaffected: digests are still computed against the live head
   * at the moment of the single real append.
   */
  appendIdempotent(input: AppendInput & { opId: string }): {
    applied: boolean;
    record: TraceRecord;
  } {
    const existing = this.findByOpId(input.opId);
    if (existing === undefined) {
      return { applied: true, record: this.append(input) };
    }
    if (logicalIdentity(existing) !== logicalIdentity(input)) {
      return fail({
        code: 'E_STORE_CORRUPT',
        message:
          'Trace operation ' +
          input.opId +
          ' already exists with different content in ' +
          this.path,
        remedy:
          'The journal and the trace stream disagree about an applied operation. Quarantine the store and restore from a verified backup (22 §5.1).',
        details: { opId: input.opId, path: this.path, existingSeq: existing.seq },
        specRef: '08 KI-1, 22 §4.2',
      });
    }
    return { applied: false, record: existing };
  }

  /**
   * Verify the chain. Returns the index of the first broken link, or ok.
   * 08 KI-1 -- this is what makes immutability checkable rather than assumed.
   */
  verify(): { ok: true } | { ok: false; brokenAt: number; detail: string } {
    const all = this.readAll();
    let prev = GENESIS_DIGEST;
    const seenOpIds = new Set<string>();
    for (let i = 0; i < all.length; i++) {
      const r = all[i]!;
      if (r.prevDigest !== prev) {
        return {
          ok: false,
          brokenAt: i,
          detail: 'prevDigest mismatch at seq ' + String(r.seq),
        };
      }
      if (r.seq !== i + 1) {
        return { ok: false, brokenAt: i, detail: 'sequence gap at index ' + String(i) };
      }
      if (r.opId !== undefined) {
        if (seenOpIds.has(r.opId)) {
          return {
            ok: false,
            brokenAt: i,
            detail: 'duplicate opId ' + r.opId + ' at seq ' + String(r.seq),
          };
        }
        seenOpIds.add(r.opId);
      }
      const { digest, ...body } = r;
      const expected = chainDigest(prev, body);
      if (digest !== expected) {
        return {
          ok: false,
          brokenAt: i,
          detail: 'digest mismatch at seq ' + String(r.seq) + ' (record was modified)',
        };
      }
      prev = digest;
    }
    return { ok: true };
  }
}
