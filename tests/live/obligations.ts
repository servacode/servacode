/**
 * PROOF OBLIGATIONS, CLASSIFIED.
 *
 * A live test cannot always reach the thing it exists to prove. The engine may be absent,
 * the network may be down, the model may legitimately stop and ask a question. Failing the
 * suite for any of those would train somebody to ignore a red suite, which is worse than
 * having no suite at all.
 *
 * What is NOT acceptable is the shape these tests previously used:
 *
 *     if (captures.length === 0) return;   // and the case reports PASS
 *
 * That is a test claiming to have proved something it never looked at. A run where the
 * network was down and a run where retrieval silently returned nothing produce the same
 * green tick, and the second one is a defect.
 *
 * So every live obligation records an explicit outcome — PROVEN, BLOCKED or NOT_RUN — and
 * the suite prints the ledger at the end. A suite may legitimately finish BLOCKED. It may
 * not finish PASS for an assertion it never exercised.
 */

export const ProofOutcome = {
  /** The obligation was exercised and holds. */
  PROVEN: 'PROVEN',
  /** Something outside the system stopped it: no engine, no network, a stalled chain. */
  BLOCKED: 'BLOCKED',
  /** It never started, because a prerequisite obligation did not complete. */
  NOT_RUN: 'NOT_RUN',
} as const;
export type ProofOutcome = (typeof ProofOutcome)[keyof typeof ProofOutcome];

export interface ProofRecord {
  readonly id: string;
  readonly claim: string;
  readonly outcome: ProofOutcome;
  readonly detail: string;
}

/** The ledger for one suite run. Printed at the end, whatever happened. */
export class ProofLedger {
  private readonly records: ProofRecord[] = [];

  proven(id: string, claim: string, detail = ''): void {
    this.records.push({ id, claim, outcome: ProofOutcome.PROVEN, detail });
  }

  blocked(id: string, claim: string, detail: string): void {
    this.records.push({ id, claim, outcome: ProofOutcome.BLOCKED, detail });
  }

  notRun(id: string, claim: string, detail: string): void {
    this.records.push({ id, claim, outcome: ProofOutcome.NOT_RUN, detail });
  }

  outcomeOf(id: string): ProofOutcome | undefined {
    return this.records.find((r) => r.id === id)?.outcome;
  }

  all(): readonly ProofRecord[] {
    return this.records;
  }

  /**
   * The summary a reader actually needs: which obligations were met, and which were not
   * even attempted. Printed rather than asserted, because the suite's job is to report
   * honestly rather than to be green.
   */
  report(title: string): string {
    const width = Math.max(...this.records.map((r) => r.id.length), 4);
    const lines = [
      '',
      '='.repeat(72),
      title,
      '='.repeat(72),
      ...this.records.map(
        (r) =>
          '  ' +
          r.outcome.padEnd(9) +
          r.id.padEnd(width + 2) +
          r.claim +
          (r.detail === '' ? '' : '\n' + ' '.repeat(13 + width) + r.detail),
      ),
      '',
      '  ' +
        [ProofOutcome.PROVEN, ProofOutcome.BLOCKED, ProofOutcome.NOT_RUN]
          .map((o) => o + ': ' + String(this.records.filter((r) => r.outcome === o).length))
          .join('   '),
      '='.repeat(72),
    ];
    return lines.join('\n');
  }
}
