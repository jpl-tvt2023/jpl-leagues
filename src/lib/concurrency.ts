/**
 * Run an async mapper over a list with a ceiling on how many run at once.
 *
 * Exists because the FPL League page touches 64 manager entries. An unbounded
 * Promise.all would fire all 64 at the FPL API simultaneously, which is
 * exactly the shape of request that gets an IP rate-limited.
 *
 * Results are returned in input order. The mapper is expected to handle its
 * own failures — a rejection here rejects the whole batch.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const capped = Math.max(1, Math.min(limit, items.length));
  const results = new Array<R>(items.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }

  await Promise.all(Array.from({ length: capped }, worker));
  return results;
}
