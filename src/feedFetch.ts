/** Uncached fetch — used for cron and deploy-trigger. */
export async function defaultFetchFeedText(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} while fetching ${url}`);
  }
  return response.text();
}

const MEMORY_TTL_MS = 15 * 60 * 1000;
const MAX_MEMORY_ENTRIES = 64;

const memoryCache = new Map<string, { text: string; expires: number }>();

/** Drop all in-memory preview entries (e.g. after “Refresh feed sources”). */
export function clearPreviewFeedMemoryCache(): void {
  memoryCache.clear();
}

/**
 * Cached fetch for admin preview only: warm-isolate memory + Cloudflare cache on subrequests.
 * Avoids re-downloading source podcasts on every keystroke while editing metadata.
 */
export async function getPreviewFeedText(url: string): Promise<string> {
  const now = Date.now();
  const hit = memoryCache.get(url);
  if (hit && hit.expires > now) {
    return hit.text;
  }
  if (hit) {
    memoryCache.delete(url);
  }

  let response: Response;
  try {
    response = await fetch(url, {
      cf: {
        cacheTtl: 900,
        cacheEverything: true,
      },
    } as Parameters<typeof fetch>[1]);
  } catch {
    // e.g. local dev / non-Workers runtimes that reject unknown `cf` options
    response = await fetch(url);
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} while fetching ${url}`);
  }

  const text = await response.text();

  while (memoryCache.size >= MAX_MEMORY_ENTRIES) {
    const first = memoryCache.keys().next().value;
    if (first === undefined) break;
    memoryCache.delete(first);
  }

  memoryCache.set(url, { text, expires: now + MEMORY_TTL_MS });
  return text;
}
