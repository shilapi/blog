import { Client, isHTTPResponseError } from "@notionhq/client";

export const notionToken = import.meta.env.NOTION_TOKEN;
export const dataSourceId = import.meta.env.NOTION_DATA_SOURCE_ID;
export const requestTimeoutMs = 15_000;
export const maxRetries = 3;
export const maxRetryDelayMs = 5_000;

function createRequestLimiter(maxConcurrent: number) {
  let activeRequests = 0;
  const waitingRequests: Array<() => void> = [];

  return function limitRequest<T>(request: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const run = () => {
        activeRequests += 1;
        void request()
          .then(resolve, reject)
          .finally(() => {
            activeRequests -= 1;
            waitingRequests.shift()?.();
          });
      };

      if (activeRequests < maxConcurrent) run();
      else waitingRequests.push(run);
    });
  };
}

/** Hosted-media downloads have a separate concurrency limit from the API. */
export const limitRemoteRequest = createRequestLimiter(3);
const limitNotionRequest = createRequestLimiter(1);
const requestIntervalMs = 400;
let nextNotionRequestAt = 0;

export const notion = notionToken
  ? new Client({
      auth: notionToken,
      notionVersion: "2026-03-11",
      timeoutMs: requestTimeoutMs,
      // All attempts must pass through the shared API queue below.
      retry: false,
    })
  : null;

export function retryDelay(attempt: number): Promise<void> {
  const delay = Math.min(1_000 * 2 ** attempt, maxRetryDelayMs);
  return new Promise((resolve) => setTimeout(resolve, delay));
}

function retryAfterMs(error: unknown): number {
  if (!isHTTPResponseError(error)) return 0;

  const headers = error.headers;
  const value =
    headers instanceof Headers
      ? headers.get("retry-after")
      : headers && typeof headers === "object"
        ? Object.entries(headers).find(
            ([name]) => name.toLowerCase() === "retry-after",
          )?.[1]
        : undefined;
  const raw = value ?? error.additional_data?.retry_after;
  if (raw === undefined || raw === null) return 0;

  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;

  const date = Date.parse(String(raw));
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0;
}

/** Only use for reads: serialize API calls, including retries and cooldowns. */
export function requestNotion<T>(request: () => Promise<T>): Promise<T> {
  return limitNotionRequest(async () => {
    for (let attempt = 0; ; attempt += 1) {
      const waitMs = nextNotionRequestAt - Date.now();
      if (waitMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }

      try {
        const result = await request();
        nextNotionRequestAt = Date.now() + requestIntervalMs;
        return result;
      } catch (error) {
        const blocked =
          isHTTPResponseError(error) &&
          error.additional_data?.rate_limit_reason ===
            "public_api_request_blocked";
        const retryable =
          !blocked &&
          (!isHTTPResponseError(error) ||
            [429, 500, 502, 503, 504, 529].includes(error.status));
        const delay = retryable
          ? Math.max(
              retryAfterMs(error),
              Math.min(1_000 * 2 ** attempt, 30_000),
            ) +
            Math.random() * 250
          : requestIntervalMs;

        // Preserve the server's full cooldown, even on the final attempt,
        // so queued requests cannot immediately hit the same rate limit.
        nextNotionRequestAt = Date.now() + delay;
        if (!retryable || attempt >= maxRetries) throw error;
      }
    }
  });
}
