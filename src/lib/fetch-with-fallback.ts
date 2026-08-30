// Shared data fetcher with automatic fallback chain.
// Pattern: try source A → if fails, try source B → if fails, try source C → return null.
// Each source is a function that returns T | null.
// Also supports retry with delay for transient failures.

export interface FallbackSource<T> {
  name: string;
  fetch: () => Promise<T | null>;
}

/**
 * Try sources in order. Return first successful result.
 * Each source is tried only if the previous one returned null or threw.
 */
export async function fetchWithFallback<T>(sources: FallbackSource<T>[]): Promise<{ data: T | null; source: string }> {
  for (const source of sources) {
    try {
      const result = await source.fetch();
      if (result !== null && result !== undefined) {
        return { data: result, source: source.name };
      }
    } catch (err: any) {
      console.error(`[Fallback] ${source.name} failed:`, err.message || err);
    }
  }
  return { data: null, source: "none" };
}

/**
 * Try a single source with retry. Returns T | null after all retries exhausted.
 */
export async function fetchWithRetry<T>(
  fn: () => Promise<T | null>,
  retries: number = 2,
  delayMs: number = 1000,
): Promise<T | null> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const result = await fn();
      if (result !== null && result !== undefined) return result;
    } catch (err: any) {
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, delayMs * (attempt + 1)));
      }
    }
  }
  return null;
}

/**
 * Fetch with both retry AND fallback chain.
 * Each source gets its own retry count before moving to the next source.
 */
export async function fetchWithRetryAndFallback<T>(
  sources: (FallbackSource<T> & { retries?: number; retryDelay?: number })[],
): Promise<{ data: T | null; source: string }> {
  for (const source of sources) {
    try {
      const result = await fetchWithRetry(
        source.fetch,
        source.retries ?? 1,
        source.retryDelay ?? 1000,
      );
      if (result !== null && result !== undefined) {
        return { data: result, source: source.name };
      }
    } catch (err: any) {
      console.error(`[Fallback] ${source.name} failed after retries:`, err.message || err);
    }
  }
  return { data: null, source: "none" };
}
