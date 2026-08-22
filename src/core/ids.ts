import { randomBytes } from 'node:crypto';
import type { Clock } from './clock.js';
import { fail } from './errors.js';

/**
 * Identifier schemes. 26 §1 — permanent, never reused.
 * Time-prefixed and lexicographically sortable, so trace streams order naturally.
 */

export type IdPrefix =
  | 'SC-PROJ'
  | 'SC-WI'
  | 'SC-TASK'
  | 'SC-REQ'
  | 'SC-DEC'
  | 'SC-RISK'
  | 'SC-ISSUE'
  | 'SC-PROP'
  | 'SC-ART'
  | 'SC-EV'
  | 'SC-CE'
  | 'SC-AVR'
  | 'SC-GR'
  | 'SC-SLE'
  | 'SC-AUD'
  | 'SC-RUN'
  | 'SC-RUNEV'
  | 'SC-WFR'
  | 'SC-TX'
  | 'SC-CTX'
  | 'SC-CTXE'
  | 'SC-REQST'
  | 'SC-CLS'
  | 'SC-PLAN'
  | 'SC-STEP'
  | 'SC-EXEC'
  | 'SC-CS'
  | 'SC-WS'
  | 'SC-EEV'
  /** A validated, persisted reviewer verdict. */
  | 'SC-REV'
  /*
   * Phase 5 — company intelligence. One prefix per artifact family, because an id that
   * says what it identifies is readable in a trace, in an error, and in an owner-facing
   * report, and a generic `SC-ART` for everything would make all three worse.
   */
  | 'SC-IDEA'
  | 'SC-CIN'
  | 'SC-GOAL'
  | 'SC-CON'
  | 'SC-ASSUM'
  | 'SC-OQ'
  | 'SC-SEG'
  | 'SC-JTBD'
  | 'SC-ALT'
  | 'SC-PAIN'
  | 'SC-DF'
  | 'SC-SCOPE'
  | 'SC-FEAT'
  | 'SC-ROAD'
  | 'SC-VREC'
  | 'SC-PDEC'
  | 'SC-RF'
  | 'SC-RUNAV'
  | 'SC-COMP'
  | 'SC-FCMP'
  | 'SC-TS'
  | 'SC-GAP'
  | 'SC-DIFF'
  | 'SC-CP'
  | 'SC-SRC'
  | 'SC-CV'
  | 'SC-RR'
  | 'SC-ACTOR'
  | 'SC-ROLE'
  | 'SC-BR'
  | 'SC-PROC'
  | 'SC-SM'
  | 'SC-GLOS'
  | 'SC-FIN'
  | 'SC-RCON'
  | 'SC-AC'
  | 'SC-NFR'
  | 'SC-RBL'
  | 'SC-TRACE'
  | 'SC-ARCH'
  | 'SC-MOD'
  | 'SC-SSOT'
  | 'SC-CJ'
  | 'SC-NMAP'
  | 'SC-TE'
  | 'SC-ADR'
  | 'SC-DM'
  | 'SC-DCLS'
  | 'SC-RET'
  | 'SC-CM'
  | 'SC-MIG'
  | 'SC-EOWN'
  | 'SC-TM'
  | 'SC-TB'
  | 'SC-ABUSE'
  | 'SC-AUTH'
  | 'SC-AZ'
  | 'SC-SEC'
  | 'SC-PRIV'
  | 'SC-SNFR'
  | 'SC-RRISK'
  | 'SC-ENV'
  | 'SC-DEPL'
  | 'SC-CFGD'
  | 'SC-OBS'
  | 'SC-BAK'
  | 'SC-ROLL'
  | 'SC-COST'
  | 'SC-CASS'
  | 'SC-LIC'
  | 'SC-LOCK'
  | 'SC-BUD'
  | 'SC-UJ'
  | 'SC-FLOW'
  | 'SC-IA'
  | 'SC-NAV'
  | 'SC-STC'
  | 'SC-CONT'
  | 'SC-USAB'
  | 'SC-DTS'
  | 'SC-CMP'
  | 'SC-LAY'
  | 'SC-RTL'
  | 'SC-ACCESS'
  | 'SC-MOT'
  | 'SC-DDEC'
  | 'SC-DEX'
  | 'SC-SCR'
  | 'SC-AOR'
  | 'SC-CFG'
  | 'SC-PR'
  | 'SC-AAR'
  | 'SC-AIA'
  | 'SC-OC'
  | 'SC-TSTR'
  | 'SC-TC'
  | 'SC-TDS'
  | 'SC-TCOV'
  | 'SC-IMPACT'
  | 'SC-CR'
  | 'SC-ODR'
  | 'SC-ERP'
  | 'SC-LL'
  | 'SC-RP'
  | 'SC-FA'
  | 'SC-APPL'
  | 'SC-CAND'
  /** The orchestrator's own persisted control state. */
  | 'SC-IORCH';

const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function encodeBase32(value: number, len: number): string {
  let out = '';
  let v = value;
  for (let i = len - 1; i >= 0; i--) {
    out = B32[v % 32] + out;
    v = Math.floor(v / 32);
  }
  return out;
}

function encodeRandom(len: number): string {
  const bytes = randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += B32[bytes[i]! % 32];
  return out;
}

export interface IdSource {
  next(prefix: IdPrefix): string;
}

/** Production source: time-ordered, collision-resistant within and across milliseconds. */
export class TimeOrderedIdSource implements IdSource {
  private lastMs = -1;
  private counter = 0;

  constructor(private readonly clock: Clock) {}

  next(prefix: IdPrefix): string {
    const ms = this.clock.epochMs();
    if (ms === this.lastMs) {
      this.counter += 1;
    } else {
      this.lastMs = ms;
      this.counter = 0;
    }
    return prefix + '-' + encodeBase32(ms, 10) + encodeBase32(this.counter, 3) + encodeRandom(8);
  }
}

/** Fully deterministic source for tests: no randomness, no clock. */
export class SequentialIdSource implements IdSource {
  private readonly counters = new Map<string, number>();

  next(prefix: IdPrefix): string {
    const n = (this.counters.get(prefix) ?? 0) + 1;
    this.counters.set(prefix, n);
    return prefix + '-' + String(n).padStart(6, '0');
  }
}

const ID_RE = /^(SC-[A-Z]+)-[0-9A-Z]+$/;

export function parseIdPrefix(id: string): string {
  const m = ID_RE.exec(id);
  if (m === null || m[1] === undefined) {
    return fail({
      code: 'E_VALIDATION',
      message: 'Malformed identifier: ' + JSON.stringify(id),
      remedy: 'Identifiers must match SC-<TYPE>-<SUFFIX>.',
      specRef: '26 §1',
    });
  }
  return m[1];
}

export function assertIdPrefix(id: string, expected: IdPrefix): void {
  const actual = parseIdPrefix(id);
  if (actual !== expected) {
    fail({
      code: 'E_VALIDATION',
      message: 'Identifier ' + id + ' has prefix ' + actual + ', expected ' + expected,
      remedy: 'Pass an ' + expected + '-* identifier.',
      details: { id, expected, actual },
      specRef: '26 §1',
    });
  }
}
