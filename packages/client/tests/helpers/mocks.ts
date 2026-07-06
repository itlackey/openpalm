/**
 * Test doubles for the P5b red tests: a recording fetch (captures URL,
 * method, headers, credentials, body of every call) and byte-stream builders
 * for SSE parsing tests. No production code — helpers only.
 */

export type RecordedRequest = {
  url: string;
  method: string;
  headers: Headers;
  /** undefined when the caller did not set an explicit credentials mode. */
  credentials: RequestCredentials | undefined;
  body: string | null;
};

export type Responder = (request: RecordedRequest) => Response | Promise<Response>;

export type RecordingFetch = {
  fetch: typeof globalThis.fetch;
  calls: RecordedRequest[];
};

/**
 * A fetch stand-in that records each request and answers via `respond`
 * (default: 200 `{}`). Handles both fetch(url, init) and fetch(Request)
 * call shapes, including relative-URL string inputs (which `new Request`
 * would reject outside a browser).
 */
export function recordingFetch(respond?: Responder): RecordingFetch {
  const calls: RecordedRequest[] = [];
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    let recorded: RecordedRequest;
    if (input instanceof Request) {
      recorded = {
        url: input.url,
        method: (init?.method ?? input.method).toUpperCase(),
        headers: new Headers(init?.headers ?? input.headers),
        credentials: init?.credentials ?? input.credentials,
        body: input.body === null ? null : await input.clone().text()
      };
    } else {
      const rawBody = init?.body;
      recorded = {
        url: String(input),
        method: (init?.method ?? 'GET').toUpperCase(),
        headers: new Headers(init?.headers),
        credentials: init?.credentials,
        body: typeof rawBody === 'string' ? rawBody : rawBody == null ? null : String(rawBody)
      };
    }
    calls.push(recorded);
    if (respond) return respond(recorded);
    return jsonResponse({});
  };
  return { fetch: impl as typeof globalThis.fetch, calls };
}

export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

/** A fetch that always rejects — proves a code path performs no network I/O. */
export function rejectingFetch(message = 'network disabled in this test'): typeof globalThis.fetch {
  const impl = async (): Promise<Response> => {
    throw new TypeError(message);
  };
  return impl as typeof globalThis.fetch;
}

/**
 * Build a ReadableStream<Uint8Array> from chunks. Strings are UTF-8 encoded;
 * Uint8Array chunks pass through raw (used to split multi-byte characters
 * across chunk boundaries).
 */
export function byteStream(chunks: Array<string | Uint8Array>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
      }
      controller.close();
    }
  });
}

export async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) items.push(item);
  return items;
}
