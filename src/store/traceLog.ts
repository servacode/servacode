import { readFileSync } from 'node:fs';
import { appendLineDurable, fileExists } from './fsutil.js';
import { GENESIS_DIGEST, chainDigest } from '../core/hash.js';
import { fail } from '../core/errors.js';

/**
 * Append-only, hash-chained trace log. SPEC: 08 §2 (T-TRACE), SC-POL-022, 05 §4.2.
 *
 * This module exposes NO update and NO delete. That is the enforcement: the only
 * mutating operation the type system offers is append. The hash chain makes a
 * retroactive edit made outside this API detectable rather than merely forbidden
 * (08 KI-1).
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
  readonly correlationId?: string;
  readonly causationId?: string;
}

export interface AppendInput {
  readonly at: string;
  readonly actor: string;
  readonly type: string;
  readonly payload: unknown;
  readonly correlationId?: string;
  readonly causationId?: string;
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
      ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }),
      ...(input.causationId === undefined ? {} : { causationId: input.causationId }),
    };
    const record: TraceRecord = { ...body, digest: chainDigest(prevDigest, body) };
    appendLineDurable(this.path, JSON.stringify(record));
    return record;
  }

  /**
   * Verify the chain. Returns the index of the first broken link, or -1 if intact.
   * 08 KI-1 — this is what makes immutability checkable rather than assumed.
   */
  verify(): { ok: true } | { ok: false; brokenAt: number; detail: string } {
    const all = this.readAll();
    let prev = GENESIS_DIGEST;
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
