import { createHash } from 'node:crypto';

/**
 * Canonical JSON: keys sorted recursively, undefined dropped, no insignificant
 * whitespace. Digests must be reproducible across processes and platforms, so key
 * order cannot depend on insertion order.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const src = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(src).sort()) {
    const v = src[key];
    if (v === undefined) continue;
    out[key] = canonicalize(v);
  }
  return out;
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** Digest of a value under canonical serialization. */
export function digestOf(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

/**
 * Hash-chain link. 05 §4.2 — makes a retroactive edit to a trace segment
 * detectable rather than merely forbidden (08 KI-1).
 */
export function chainDigest(prevDigest: string, payload: unknown): string {
  return sha256Hex(prevDigest + '\n' + canonicalJson(payload));
}

export const GENESIS_DIGEST = '0'.repeat(64);
