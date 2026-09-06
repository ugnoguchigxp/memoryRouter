/** Binary relevance metrics. Unlabelled queries are not zero-quality queries. */
export function rankedRetrievalMetrics(
  expected: readonly string[],
  retrieved: readonly string[],
  limit = retrieved.length,
) {
  const relevant = new Set(expected);
  if (!relevant.size) return { reciprocalRank: null, ndcg: null };
  const unique = [...new Set(retrieved)].slice(0, limit);
  const first = unique.findIndex((id) => relevant.has(id));
  const dcg = unique.reduce(
    (sum, id, index) => sum + (relevant.has(id) ? 1 / Math.log2(index + 2) : 0),
    0,
  );
  const ideal = Array.from({ length: Math.min(relevant.size, limit) }).reduce<number>(
    (sum, _, index) => sum + 1 / Math.log2(index + 2),
    0,
  );
  return { reciprocalRank: first < 0 ? 0 : 1 / (first + 1), ndcg: ideal ? dcg / ideal : 0 };
}

export function meanMeasured(values: readonly (number | null | undefined)[]): number | null {
  const measured = values.filter((value): value is number => value != null);
  return measured.length ? measured.reduce((sum, value) => sum + value, 0) / measured.length : null;
}
