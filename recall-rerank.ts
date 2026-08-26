/**
 * Reordering what the search found, once, by reading it.
 *
 * The vector search barely discriminates here. Measured on live memory: fifty
 * candidates for one ordinary question spanned scores from 0.521 down to 0.303
 * -- a fifth of the range across the whole corpus -- with the answer sitting
 * sixth and three irrelevant files above it. At that spread the order inside
 * the band is noise, and any threshold cuts through the middle of the noise
 * rather than between the good and the bad.
 *
 * The reason is visible in the question. Asked "ты еще не уснула? как там
 * Байт?", the top hit was a note containing "я не могу уснуть" -- the search
 * matched the conversational half and not the subject. One embedding cannot
 * hold both halves of a sentence and keep them apart.
 *
 * A cross-encoder can, because it reads the question and the document together
 * instead of comparing two smeared vectors. So: take a wide net of candidates,
 * reorder them once, keep the few at the top.
 *
 * Once, and here, rather than inside the search: the memory server calls its
 * reranker at every fork of the category tree, ten to fifteen times per recall,
 * and asks it whether a folder description matches the question -- which is not
 * a question a reranker can answer, and which cost several seconds and as many
 * provider requests each time.
 */

export type RerankCandidate = { uri: string; abstract?: string; overview?: string; score?: number };

export type RerankSettings = {
  enabled: boolean;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  /** How many of the reordered candidates to keep. */
  keep: number;
  /**
   * Below this, nothing is injected at all.
   *
   * Not a filter on the list -- a verdict on the whole answer. An unrelated
   * memory in the context is worse than no memory: it invites the model to
   * weave it in, and the reader cannot tell that it was never relevant. Better
   * to say nothing, the way the graph plugin already does.
   */
  floor: number;
};

export const DEFAULT_RERANK: RerankSettings = {
  enabled: false,
  baseUrl: "http://127.0.0.1:8790",
  model: "cohere/rerank-v3.5",
  timeoutMs: 30000,
  keep: 5,
  floor: 0.3,
};

/** What the reranker is shown of a memory: its own text, not its address. */
function documentOf(item: RerankCandidate): string {
  const text = (item.abstract ?? item.overview ?? "").trim();
  return text || item.uri;
}

export type RerankOutcome = {
  kept: RerankCandidate[];
  /** Why the result looks the way it does, for the log. */
  reason: "reranked" | "below-floor" | "disabled" | "nothing-to-do" | "unavailable";
  best?: number;
  ms?: number;
};

export async function rerankMemories(
  query: string,
  candidates: RerankCandidate[],
  settings: RerankSettings,
  fetchImpl: typeof fetch = fetch,
): Promise<RerankOutcome> {
  if (!settings.enabled) return { kept: candidates.slice(0, settings.keep), reason: "disabled" };
  if (!query.trim() || candidates.length === 0) return { kept: [], reason: "nothing-to-do" };

  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), settings.timeoutMs);
  let scored: Array<{ index: number; relevance_score: number }>;
  try {
    const answer = await fetchImpl(`${settings.baseUrl.replace(/\/+$/, "")}/v2/rerank`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: settings.model,
        query,
        documents: candidates.map(documentOf),
        top_n: candidates.length,
      }),
      signal: controller.signal,
    });
    if (!answer.ok) throw new Error(`rerank ${answer.status}`);
    const body = await answer.json() as { results?: Array<{ index: number; relevance_score: number }> };
    scored = body.results ?? [];
    if (!scored.length) throw new Error("rerank returned nothing");
  } catch {
    // Unreachable or unhappy: the search order is worse than a reranked one but
    // better than nothing, and a recall must not fail for want of a nicety.
    return { kept: candidates.slice(0, settings.keep), reason: "unavailable", ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }

  const ordered = scored
    .filter((row) => candidates[row.index])
    .sort((a, b) => b.relevance_score - a.relevance_score);
  const best = ordered.length ? ordered[0].relevance_score : 0;
  const ms = Date.now() - started;

  // Nothing here answers the question. Say nothing rather than fill the context
  // with the least irrelevant of the irrelevant.
  if (best < settings.floor) return { kept: [], reason: "below-floor", best, ms };

  return {
    kept: ordered.slice(0, settings.keep).map((row) => ({
      ...candidates[row.index],
      score: row.relevance_score,
    })),
    reason: "reranked",
    best,
    ms,
  };
}
