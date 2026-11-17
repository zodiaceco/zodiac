/** JSON over HTTP for the explorer clients: a timeout, and rate-limit retries. */

const REQUEST_TIMEOUT_MS = 20_000;

const RATE_LIMIT_ATTEMPTS = 5;

/**
 * Doubling backoff (3s, 6s, 12s, 24s, 48s — 93s cumulative): public Blockscout
 * instances rate-limit on a rolling per-minute window, so the retries must be
 * able to outlast a full minute.
 */
const rateLimitDelay = (attempt: number) => 3_000 * 2 ** attempt;

/** A host asking for a longer wait than this is not worth waiting for. */
const MAX_RATE_LIMIT_WAIT_MS = 60_000;

export const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

export interface JsonResponse<T> {
  status: number;
  /** Undefined when the response isn't JSON. */
  body?: T;
}

interface Attempt<T> extends JsonResponse<T> {
  /** How long the host asks a rate-limited client to wait, when it says. */
  retryAfterMs?: number;
}

/**
 * Send a request and parse the JSON answer, retrying while the host is
 * rate-limiting. Any other status is returned as is, for the caller to judge.
 */
export async function requestJson<T>(
  url: URL,
  init: RequestInit = {},
  {
    beforeAttempt,
    isRateLimited,
  }: {
    /** Awaited before every attempt, retries included. */
    beforeAttempt?: () => Promise<void>;
    /** For hosts that report rate-limiting in a 200 body. */
    isRateLimited?: (body: T | undefined) => boolean;
  } = {}
): Promise<JsonResponse<T>> {
  for (let attempt = 0; ; attempt += 1) {
    await beforeAttempt?.();
    const { status, body, retryAfterMs = 0 } = await send<T>(url, init);

    if (status !== 429 && !isRateLimited?.(body)) return { status, body };

    // Retrying can't outlast a quota that resets minutes from now.
    if (retryAfterMs > MAX_RATE_LIMIT_WAIT_MS) {
      throw new Error(
        `${url.host} is rate-limiting requests ` +
          `(quota resets in ${Math.ceil(retryAfterMs / 60_000)} min)`
      );
    }
    if (attempt >= RATE_LIMIT_ATTEMPTS) {
      throw new Error(`${url.host} is rate-limiting requests`);
    }
    await sleep(Math.max(rateLimitDelay(attempt), retryAfterMs));
  }
}

async function send<T>(url: URL, init: RequestInit): Promise<Attempt<T>> {
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal });
    const body = (await response.json().catch(() => undefined)) as
      | T
      | undefined;
    // The body read swallows its own errors, an abort included.
    signal.throwIfAborted();
    return {
      status: response.status,
      body,
      retryAfterMs: retryAfterMs(response.headers),
    };
  } catch (error) {
    if (!signal.aborted) throw error;
    throw new Error(
      `${url.host} didn't answer within ${REQUEST_TIMEOUT_MS / 1_000}s`
    );
  }
}

function retryAfterMs(headers: Headers): number | undefined {
  // Standard: seconds, or an HTTP date.
  const retryAfter = headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return seconds * 1_000;
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }

  // Blockscout: milliseconds until the quota resets. Other hosts put an epoch
  // timestamp in this header, which is skipped as too large to be a duration.
  const reset = Number(headers.get("x-ratelimit-reset") ?? NaN);
  if (reset >= 0 && reset < 86_400_000) return reset;

  return undefined;
}
