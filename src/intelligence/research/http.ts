import type { RetrievedPage, Retriever } from './gateway.js';

/**
 * THE ONE PLACE SERVA REACHES THE NETWORK.
 *
 * SPEC: §10, §42.
 *
 * Every agent in this system has `network: NONE` in its granted policy, including the
 * Market Researcher whose contract declares network scope. The research gateway is what
 * turns that contract into an actual retrieval, and this is what the gateway calls.
 *
 * Putting egress here rather than in a tool the model can invoke is the whole design. A
 * model with a fetch tool decides what to fetch, when, and how often, mid-reasoning and
 * unlogged. Serva fetching on its behalf means the URL was declared before anything left
 * the machine, the response is captured with a content hash, and the agent receives it as
 * fenced untrusted data it cannot act on.
 *
 * What this deliberately does NOT do:
 *
 *   it does not follow redirects to a different host — the allowlist would be pointless
 *   if a redirect could leave it, and a host that redirects elsewhere is a host that was
 *   not the one anybody approved;
 *
 *   it does not execute scripts, or render anything. The text is what the bytes say;
 *
 *   it does not retry. A source that failed to load is evidence that did not arrive, and
 *   the correct outcome of that is a recorded UNAVAILABLE rather than a slower one.
 */

/** Enough for an article; small enough that one hostile page cannot exhaust memory. */
const MAX_BYTES = 2_000_000;

const BLOCK_ELEMENTS =
  /<\/?(p|div|br|li|tr|h[1-6]|section|article|header|footer|nav|table|blockquote)\b[^>]*>/gi;

/**
 * HTML to text, conservatively.
 *
 * Not a parser and not trying to be. Script and style contents are dropped because they
 * are not prose; block elements become newlines so paragraphs survive; everything else is
 * stripped. A verifier later checks a claim against this text, so what matters is that the
 * text is a faithful, stable rendering of what was retrieved — not that it is pretty.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(BLOCK_ELEMENTS, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

function titleOf(html: string, url: string): string {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const raw = m?.[1];
  if (raw === undefined) return url;
  const text = htmlToText(raw);
  return text === '' ? url : text.slice(0, 200);
}

/** The date the page states about itself, where it states one in a machine-readable way. */
function sourceDateOf(html: string): string | undefined {
  const patterns = [
    /<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+name=["']date["'][^>]+content=["']([^"']+)["']/i,
    /<time[^>]+datetime=["']([^"']+)["']/i,
  ];
  for (const re of patterns) {
    const value = re.exec(html)?.[1];
    if (value !== undefined && value.trim() !== '') return value.trim();
  }
  return undefined;
}

export interface HttpRetrieverOptions {
  /** Sent so an operator reading their own logs can tell what this was. */
  readonly userAgent?: string;
  /** Injectable for tests. Defaults to the platform `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

/**
 * A retriever over plain HTTP.
 *
 * Host allowlisting is NOT done here. It is done by the gateway, against the hosts the
 * research request declared before anything was fetched — one check, in the place that
 * knows what was approved, rather than a second one here that could drift out of step
 * with it.
 */
export function httpRetriever(options: HttpRetrieverOptions = {}): Retriever {
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  const userAgent = options.userAgent ?? 'SERVA-CODE/1.0 (company intelligence; research)';

  return {
    async fetch(url: string, timeoutMs: number): Promise<RetrievedPage> {
      if (typeof doFetch !== 'function') {
        return {
          url,
          title: url,
          text: '',
          ok: false,
          error: 'no fetch implementation is available in this runtime',
        };
      }

      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort();
      }, timeoutMs);

      try {
        const response = await doFetch(url, {
          redirect: 'manual',
          signal: controller.signal,
          headers: { 'user-agent': userAgent, accept: 'text/html,text/plain;q=0.9,*/*;q=0.5' },
        });

        if (response.status >= 300 && response.status < 400) {
          /*
           * Refused rather than followed. The allowlist named a host; a redirect is that
           * host telling us to ask a different one, and nobody approved the different one.
           */
          return {
            url,
            title: url,
            text: '',
            ok: false,
            error:
              'the source redirected to ' +
              (response.headers.get('location') ?? 'an unstated location') +
              ', which is not the host the request declared',
          };
        }

        if (!response.ok) {
          return { url, title: url, text: '', ok: false, error: 'HTTP ' + String(response.status) };
        }

        const body = await response.text();
        if (body.length > MAX_BYTES) {
          return {
            url,
            title: url,
            text: '',
            ok: false,
            error:
              'the source is larger than ' + String(MAX_BYTES) + ' bytes and was not retrieved',
          };
        }

        const contentType = response.headers.get('content-type') ?? '';
        const text = contentType.includes('text/html') ? htmlToText(body) : body.trim();
        const sourceDate = sourceDateOf(body);

        return {
          url,
          title: titleOf(body, url),
          text,
          ok: true,
          ...(sourceDate === undefined ? {} : { sourceDate }),
        };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return {
          url,
          title: url,
          text: '',
          ok: false,
          error: controller.signal.aborted
            ? 'the source did not respond within ' + String(timeoutMs) + 'ms'
            : message,
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
