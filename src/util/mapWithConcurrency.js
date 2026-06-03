/**
 * Map over items with a bounded number of in-flight async workers.
 * Result order matches input order.
 */
export async function mapWithConcurrency(items, limit, worker) {
  if (!Array.isArray(items) || items.length === 0) return [];
  const concurrency = Math.max(1, Math.min(limit, items.length));
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runWorker() {
    while (true) {
      const i = nextIndex;
      nextIndex += 1;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, runWorker));
  return results;
}
