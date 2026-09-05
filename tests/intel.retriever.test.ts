import { describe, expect, it } from 'vitest';
import { htmlToText, httpRetriever } from '../src/intelligence/research/http.js';

/**
 * THE NETWORK EGRESS POINT.
 *
 * SPEC: §10, §42. This is the only code in Serva that opens a connection, so it is worth
 * testing the ways it can be talked into doing something nobody approved — offline, with
 * a stubbed fetch, because a test that reached the real network to prove it is careful
 * about reaching the network would be its own counterexample.
 */

function stub(
  response: Partial<{
    status: number;
    ok: boolean;
    body: string;
    headers: Record<string, string>;
  }> = {},
): typeof fetch {
  const headers = new Map(Object.entries(response.headers ?? { 'content-type': 'text/html' }));
  return (async () =>
    ({
      status: response.status ?? 200,
      ok: response.ok ?? (response.status ?? 200) < 400,
      headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
      text: async () => response.body ?? '<html><body>hello</body></html>',
    }) as unknown as Response) as unknown as typeof fetch;
}

describe('HTML becomes text without becoming instructions', () => {
  it('drops scripts and styles rather than reading them as prose', () => {
    const text = htmlToText(
      '<html><head><style>.a{color:red}</style><script>alert(1)</script></head>' +
        '<body><h1>Click and collect</h1><p>Order online, collect in store.</p></body></html>',
    );
    expect(text).toContain('Click and collect');
    expect(text).toContain('Order online');
    expect(text).not.toContain('alert');
    expect(text).not.toContain('color:red');
  });

  it('keeps paragraph structure, so a verifier can locate a passage again', () => {
    const text = htmlToText('<p>First claim.</p><p>Second claim.</p>');
    expect(text.split('\n').filter((l) => l.trim() !== '')).toEqual([
      'First claim.',
      'Second claim.',
    ]);
  });
});

describe('a page cannot send Serva somewhere nobody approved', () => {
  it('a redirect is refused rather than followed', async () => {
    const r = httpRetriever({
      fetchImpl: stub({ status: 302, headers: { location: 'https://elsewhere.example/' } }),
    });
    const page = await r.fetch('https://example.com/rival', 5_000);
    expect(page.ok).toBe(false);
    expect(page.error).toContain('elsewhere.example');
    expect(page.error).toContain('not the host the request declared');
    expect(page.text).toBe('');
  });

  it('an error status yields no text at all', async () => {
    const r = httpRetriever({ fetchImpl: stub({ status: 503 }) });
    const page = await r.fetch('https://example.com/rival', 5_000);
    expect(page.ok).toBe(false);
    expect(page.error).toBe('HTTP 503');
    expect(page.text).toBe('');
  });

  it('an oversized response is not retrieved, rather than truncated silently', async () => {
    const r = httpRetriever({ fetchImpl: stub({ body: 'x'.repeat(2_000_001) }) });
    const page = await r.fetch('https://example.com/huge', 5_000);
    expect(page.ok).toBe(false);
    expect(page.error).toContain('larger than');
  });

  it('an oversized response stops being read, rather than being read and then rejected', async () => {
    /*
     * SPEC: finding OLER-NET-1 (MEDIUM), 1.0.1 security review.
     *
     * The limit used to be applied to `await response.text()` — so a hostile page was fully in
     * memory before anything objected, while the constant's own comment claims it is "small
     * enough that one hostile page cannot exhaust memory".
     *
     * This stream would never end on its own. What is asserted is that reading STOPS: the
     * retriever cancels the body, and pulls only enough chunks to pass the limit rather than
     * however many the server cares to send.
     */
    const CHUNK = 100_000;
    let pulled = 0;
    let cancelled = false;

    const endless = {
      getReader() {
        return {
          read: async () => {
            pulled += 1;
            return { done: false, value: new TextEncoder().encode('x'.repeat(CHUNK)) };
          },
          cancel: async () => {
            cancelled = true;
          },
          releaseLock: () => undefined,
        };
      },
    };

    const streaming = (async () =>
      ({
        status: 200,
        ok: true,
        headers: { get: () => 'text/html' },
        body: endless,
        text: async () => {
          throw new Error('the body must be read as a stream, not buffered whole');
        },
      }) as unknown as Response) as unknown as typeof fetch;

    const r = httpRetriever({ fetchImpl: streaming });
    const page = await r.fetch('https://example.com/endless', 5_000);

    expect(page.ok).toBe(false);
    expect(page.error).toContain('larger than');
    expect(cancelled, 'the response must be cancelled, not left streaming').toBe(true);
    /* 2 MB limit over 100 KB chunks: it must stop within a chunk or two of the limit. */
    expect(pulled).toBeLessThanOrEqual(2_000_000 / CHUNK + 2);
  });

  it('a failure is reported once, and not retried', async () => {
    let calls = 0;
    const counting = (async () => {
      calls += 1;
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const page = await httpRetriever({ fetchImpl: counting }).fetch('https://example.com/x', 5_000);
    expect(calls).toBe(1);
    expect(page.ok).toBe(false);
    expect(page.error).toContain('ECONNREFUSED');
  });
});

describe('what a successful retrieval reports', () => {
  it('title and stated publication date come from the page, and text from the bytes', async () => {
    const r = httpRetriever({
      fetchImpl: stub({
        body:
          '<html><head><title>Click and collect</title>' +
          '<meta property="article:published_time" content="2023-04-01T00:00:00Z"></head>' +
          '<body><p>Order online, collect in store.</p></body></html>',
      }),
    });
    const page = await r.fetch('https://en.wikipedia.org/wiki/Click_and_collect', 5_000);
    expect(page.ok).toBe(true);
    expect(page.title).toBe('Click and collect');
    expect(page.sourceDate).toBe('2023-04-01T00:00:00Z');
    expect(page.text).toContain('Order online, collect in store.');
  });

  it('a non-HTML body is passed through rather than stripped', async () => {
    const r = httpRetriever({
      fetchImpl: stub({ body: '  plain evidence  ', headers: { 'content-type': 'text/plain' } }),
    });
    const page = await r.fetch('https://example.com/notes.txt', 5_000);
    expect(page.text).toBe('plain evidence');
  });
});
