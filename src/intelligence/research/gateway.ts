import { fail } from '../../core/errors.js';
import { AuditAction, audit } from '../../events/audit.js';
import { parseToolSurface } from '../../agents/toolPolicy.js';
import { SourceMarking, TrustLevel } from '../../vocab/index.js';
import { ARTIFACT_TYPES, repository } from '../repository.js';
import { SourceCaptureSchema, captureDigest, disclosureRefusal } from './capture.js';
import { validUntilFrom, DEFAULT_VALIDITY_DAYS } from './freshness.js';
import type { ResearchRequest, SourceCapture } from './capture.js';
import type { AgentContract } from '../../agents/schema.js';
import type { Store, Transaction } from '../../store/store.js';
import type { Clock } from '../../core/clock.js';
import type { IdSource } from '../../core/ids.js';

/**
 * THE RESEARCH GATEWAY — Serva retrieves; the agent never holds a network tool.
 *
 * SPEC: §10, §11, §42, §48, 19 §5, 33 PC-5.
 *
 * Phase 3 put `WebFetch` and `WebSearch` in `NEVER_AVAILABLE` and gave a reason that is
 * still correct: a run that can reach the network is an ungoverned run inside a governed
 * one. Phase 5 needs external research and must not weaken that.
 *
 * The resolution is to move retrieval OUT of the agent. Serva performs the fetch itself,
 * under a declared request, and hands the agent captured evidence. The Market Researcher
 * then does what it is actually for — reading sources and forming findings — with no
 * network capability of its own.
 *
 * This is strictly stronger than granting the tool, and it is what makes several §48
 * properties structural rather than behavioural:
 *
 *   a researcher cannot download and execute anything, because it cannot fetch;
 *   it cannot authenticate, submit a form, or buy anything, for the same reason;
 *   the Source Verifier cannot fetch a replacement source, because nobody can;
 *   the Competitive Analyst has no network because network is not a department capability
 *     at all — it is a separate governed service.
 *
 * The canonical contract still decides WHO may cause retrieval. `net(declared research
 * hosts)` on SC-AGENT-060 is honoured as "this agent's work may be informed by retrieval
 * from declared hosts", and `assertResearchAuthority` refuses the request otherwise —
 * so a department config cannot obtain research merely by asking for it.
 */

/**
 * What a retriever must provide. Injected, so tests never touch the network.
 *
 * `discover` is optional and separate from `fetch` on purpose: finding candidate sources
 * and reading them are different acts with different risks, and a deployment may permit
 * one without the other. With no `discover`, only explicitly seeded URLs are ever read.
 */
export interface Retriever {
  fetch(url: string, timeoutMs: number): Promise<RetrievedPage>;
  discover?(query: string, allowedHosts: readonly string[]): Promise<readonly string[]>;
}

export interface RetrievedPage {
  readonly url: string;
  readonly title: string;
  readonly text: string;
  /** Publication or last-modified date, where the page states one. */
  readonly sourceDate?: string;
  readonly ok: boolean;
  readonly error?: string;
}

export interface GatewayDeps {
  readonly store: Store;
  readonly clock: Clock;
  readonly ids: IdSource;
  readonly retriever?: Retriever;
}

export const RetrievalOutcome = {
  CAPTURED: 'CAPTURED',
  /** No retriever is configured. Honest, and never a reason to invent a landscape. */
  UNAVAILABLE: 'UNAVAILABLE',
  REFUSED: 'REFUSED',
} as const;
export type RetrievalOutcome = (typeof RetrievalOutcome)[keyof typeof RetrievalOutcome];

export interface RetrievalResult {
  readonly outcome: RetrievalOutcome;
  readonly captures: readonly SourceCapture[];
  /** Why nothing was captured, in terms a gate can record and a person can act on. */
  readonly reason?: string;
  readonly refusals: readonly string[];
}

/**
 * May this agent cause retrieval at all?
 *
 * Read from the CANONICAL CONTRACT, never from the caller's intent. This is the single
 * check that stops network becoming a generic department capability: a config for the UX
 * designer can ask for research all it likes, and the contract will refuse it.
 */
export function assertResearchAuthority(contract: AgentContract): void {
  const surface = parseToolSurface(contract);
  if (!surface.net) {
    fail({
      code: 'E_CAPABILITY_NOT_ENABLED',
      message:
        'Agent ' +
        contract.id +
        ' (' +
        contract.name +
        ') requested external research, and its canonical contract declares no network scope',
      remedy:
        'Research capability comes from the AgentContract, not from the department configuration. Granting it here would make network generic.',
      details: { agentId: contract.id, networkScope: contract.networkScope },
      specRef: '19 §5, 33 PC-5',
    });
  }
}

/** A host is allowed only if the request declared it. Subdomains count; suffixes do not. */
function hostAllowed(url: string, allowed: readonly string[]): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return allowed.some((a) => {
    const want = a.toLowerCase().replace(/^\*\./, '');
    return host === want || host.endsWith('.' + want);
  });
}

/**
 * Retrieve, capture and persist.
 *
 * Every refusal path returns rather than throws, because "we could not find out" is a
 * legitimate research result that a gate must be able to record as NOT_VERIFIED. Throwing
 * would push the caller toward a catch block, and the thing waiting in that catch block
 * is the temptation to write a plausible competitor landscape instead.
 */
export async function retrieveForResearch(
  deps: GatewayDeps,
  o: {
    readonly contract: AgentContract;
    readonly request: ResearchRequest;
    readonly urls: readonly string[];
    readonly runId: string;
    /** Project material that must not appear in an outbound question. */
    readonly projectSecrets?: readonly string[];
    readonly validityDays?: number;
    readonly timeoutMs?: number;
  },
): Promise<RetrievalResult> {
  assertResearchAuthority(o.contract);

  /* --- would the question itself disclose something? --- */
  const disclosure = disclosureRefusal(o.request, o.projectSecrets ?? []);
  if (disclosure.length > 0) {
    return { outcome: RetrievalOutcome.REFUSED, captures: [], refusals: disclosure };
  }

  /* --- hosts must have been declared BEFORE the fetch --- */
  const refusals: string[] = [];
  const permitted = o.urls.filter((u) => {
    if (hostAllowed(u, o.request.allowedHosts)) return true;
    refusals.push('host not declared in the research request: ' + u);
    return false;
  });

  if (deps.retriever === undefined) {
    return {
      outcome: RetrievalOutcome.UNAVAILABLE,
      captures: [],
      reason:
        'no retriever is configured, so no external source could be consulted; the correct result is NOT_VERIFIED rather than an assumed market',
      refusals,
    };
  }

  const capped = permitted.slice(0, o.request.maxSources);
  if (capped.length < permitted.length) {
    refusals.push(
      'retrieval stopped at the declared maximum of ' +
        String(o.request.maxSources) +
        ' sources; ' +
        String(permitted.length - capped.length) +
        ' candidate(s) were not fetched',
    );
  }

  const repo = repository(deps.store, ARTIFACT_TYPES.SOURCE_CAPTURE, SourceCaptureSchema);
  const captures: SourceCapture[] = [];
  const days = o.validityDays ?? DEFAULT_VALIDITY_DAYS['MARKET_LANDSCAPE'] ?? 180;

  for (const url of capped) {
    let page: RetrievedPage;
    try {
      page = await deps.retriever.fetch(url, o.timeoutMs ?? 20_000);
    } catch (e) {
      refusals.push(
        'retrieval failed for ' + url + ': ' + String(e instanceof Error ? e.message : e),
      );
      continue;
    }
    if (!page.ok) {
      refusals.push('retrieval failed for ' + url + ': ' + (page.error ?? 'unknown error'));
      continue;
    }

    const retrievedAt = deps.clock.now();
    const excerpt = page.text.slice(0, 20_000);
    const tx = deps.store.begin();
    let stored: SourceCapture;
    try {
      stored = repo.put(tx, {
        id: deps.ids.next('SC-SRC'),
        createdAt: retrievedAt,
        url: page.url,
        title: page.title,
        kind: 'WEB_PAGE',
        retrievedAt,
        researchQuestion: o.request.question,
        retrievedByRunId: o.runId,
        retrievedByAgentId: o.contract.id,
        excerpt,
        contentDigest: captureDigest(excerpt),
        trust: TrustLevel.UNTRUSTED,
        validUntil: validUntilFrom(retrievedAt, days),
        ...(page.sourceDate === undefined ? {} : { sourceDate: page.sourceDate }),
        meta: {
          provenance: {
            marking: SourceMarking.SYSTEM,
            component: 'research-gateway',
          },
          attribution: { runId: o.runId, agentId: o.contract.id, at: retrievedAt },
        },
      }) as SourceCapture;
      audit(tx, {
        action: AuditAction.SOURCE_CAPTURED,
        subject: stored.id,
        outcome: 'OK',
        detail: { url: page.url, question: o.request.question, trust: TrustLevel.UNTRUSTED },
      });
      tx.commit();
    } catch (e) {
      tx.rollback();
      refusals.push(
        'could not store capture for ' + url + ': ' + String(e instanceof Error ? e.message : e),
      );
      continue;
    }
    captures.push(stored);
  }

  if (captures.length === 0) {
    return {
      outcome: RetrievalOutcome.UNAVAILABLE,
      captures: [],
      reason:
        refusals.length > 0
          ? 'no source could be captured: ' + refusals[0]
          : 'no source was captured for this question',
      refusals,
    };
  }
  return { outcome: RetrievalOutcome.CAPTURED, captures, refusals };
}

/** A retriever that refuses. The default, so nothing reaches the network by accident. */
export const OFFLINE_RETRIEVER: Retriever = {
  fetch: async (url: string): Promise<RetrievedPage> => ({
    url,
    title: '',
    text: '',
    ok: false,
    error: 'no network retriever is configured for this Serva installation',
  }),
};

export type { Transaction };
