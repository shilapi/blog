import { Client } from "@notionhq/client";

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

/** Notion API calls and hosted-media downloads share this concurrency limit. */
export const limitRemoteRequest = createRequestLimiter(3);

export const notion = notionToken
  ? new Client({
      auth: notionToken,
      notionVersion: "2026-03-11",
      timeoutMs: requestTimeoutMs,
      retry: { maxRetries, maxRetryDelayMs },
    })
  : null;

export function retryDelay(attempt: number): Promise<void> {
  const delay = Math.min(1_000 * 2 ** attempt, maxRetryDelayMs);
  return new Promise((resolve) => setTimeout(resolve, delay));
}

export async function requestNotion<T>(request: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await limitRemoteRequest(request);
    } catch (error) {
      lastError = error;
      if (attempt < maxRetries) await retryDelay(attempt);
    }
  }

  throw lastError;
}
