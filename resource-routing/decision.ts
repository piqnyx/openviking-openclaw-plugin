import type { ParsedResourceRoutingConfig } from "./config.js";
import type { ResourceEmbeddingClient, ResourceRerankerClient } from "./ml-client.js";
import type { ResourceTaxonomy, ResourceTaxonomyCategory } from "./taxonomy.js";
import { assertResourceRoutingFallbackCategory, listRouteableResourceCategories } from "./taxonomy.js";

export type ResourceRoutingCandidate = {
  key: string;
  uri: string;
  score: number;
};

export type ResourceRoutingDecision = {
  categoryKey: string;
  categoryUri: string;
  fallback: boolean;
  fallbackReason?: "below-min-score";
  embeddingTop: ResourceRoutingCandidate[];
  rerankerUsed: boolean;
  rerankerScores?: Array<{ key: string; score: number }>;
  timingMs: {
    embedding: number;
    reranker?: number;
    total: number;
  };
};

export type ResourceRoutingPreparedState = {
  taxonomy: ResourceTaxonomy;
  embeddings: ReadonlyMap<string, readonly number[]>;
};

function vectorNorm(vector: readonly number[], label: string): number {
  let squared = 0;
  for (const value of vector) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`${label} contains a non-finite value`);
    }
    squared += value * value;
  }
  const norm = Math.sqrt(squared);
  if (!Number.isFinite(norm) || norm === 0) {
    throw new Error(`${label} has zero or invalid norm`);
  }
  return norm;
}

export function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  if (left.length === 0 || left.length !== right.length) {
    throw new Error(`cosine similarity dimension mismatch: ${left.length} vs ${right.length}`);
  }
  const leftNorm = vectorNorm(left, "cosine left vector");
  const rightNorm = vectorNorm(right, "cosine right vector");
  let dot = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index]! * right[index]!;
  }
  const score = dot / (leftNorm * rightNorm);
  if (!Number.isFinite(score)) {
    throw new Error("cosine similarity produced a non-finite score");
  }
  return Math.max(-1, Math.min(1, score));
}

function compareStableKeys(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function rankEmbeddingCandidates(
  queryEmbedding: readonly number[],
  categories: readonly ResourceTaxonomyCategory[],
  embeddings: ReadonlyMap<string, readonly number[]>,
  topK: number,
): ResourceRoutingCandidate[] {
  const candidates = categories.map((category) => {
    const embedding = embeddings.get(category.key);
    if (!embedding) {
      throw new Error(`resource routing state is missing cached embedding for category ${category.key}`);
    }
    return {
      key: category.key,
      uri: category.uri,
      score: cosineSimilarity(queryEmbedding, embedding),
    };
  });
  candidates.sort((left, right) => right.score - left.score || compareStableKeys(left.key, right.key));
  return candidates.slice(0, Math.min(topK, candidates.length));
}

function fallbackDecision(
  taxonomy: ResourceTaxonomy,
  fallbackCategory: string,
  embeddingTop: ResourceRoutingCandidate[],
  reason: ResourceRoutingDecision["fallbackReason"],
  timingMs: ResourceRoutingDecision["timingMs"],
): ResourceRoutingDecision {
  assertResourceRoutingFallbackCategory(taxonomy, fallbackCategory);
  const category = taxonomy.byKey.get(fallbackCategory)!;
  return {
    categoryKey: category.key,
    categoryUri: category.uri,
    fallback: true,
    fallbackReason: reason,
    embeddingTop,
    rerankerUsed: false,
    timingMs,
  };
}

export async function decideAutomaticResourceRoute(options: {
  semanticInput: string;
  config: ParsedResourceRoutingConfig;
  state: ResourceRoutingPreparedState;
  embedder: ResourceEmbeddingClient;
  reranker: ResourceRerankerClient;
}): Promise<ResourceRoutingDecision> {
  const startedAt = Date.now();
  const semanticInput = options.semanticInput.trim();
  if (!semanticInput) {
    throw new Error("resource routing semantic input must not be empty");
  }

  assertResourceRoutingFallbackCategory(options.state.taxonomy, options.config.fallbackCategory);
  const categories = listRouteableResourceCategories(options.state.taxonomy);
  if (categories.length === 0) {
    throw new Error("resource routing taxonomy has no routeable categories");
  }

  const embeddingStartedAt = Date.now();
  const [queryEmbedding] = await options.embedder.embed([semanticInput]);
  const embeddingMs = Date.now() - embeddingStartedAt;
  if (!queryEmbedding) {
    throw new Error("resource routing embedder returned no query embedding");
  }

  const embeddingTop = rankEmbeddingCandidates(
    queryEmbedding,
    categories,
    options.state.embeddings,
    options.config.retrieval.topK,
  );
  const first = embeddingTop[0];
  if (!first) {
    throw new Error("resource routing produced no embedding candidates");
  }

  if (first.score < options.config.retrieval.minScore) {
    return fallbackDecision(
      options.state.taxonomy,
      options.config.fallbackCategory,
      embeddingTop,
      "below-min-score",
      { embedding: embeddingMs, total: Date.now() - startedAt },
    );
  }

  const second = embeddingTop[1];
  const shouldRerank =
    Boolean(second) &&
    first.score - second!.score < options.config.retrieval.rerankBelowMargin;

  if (!shouldRerank) {
    return {
      categoryKey: first.key,
      categoryUri: first.uri,
      fallback: false,
      embeddingTop,
      rerankerUsed: false,
      timingMs: { embedding: embeddingMs, total: Date.now() - startedAt },
    };
  }

  const rerankCategories = embeddingTop.map((candidate) => {
    const category = options.state.taxonomy.byKey.get(candidate.key);
    if (!category || !category.routeable) {
      throw new Error(`resource routing candidate disappeared from taxonomy: ${candidate.key}`);
    }
    return category;
  });
  const rerankerStartedAt = Date.now();
  const reranked = await options.reranker.rerank(
    semanticInput,
    rerankCategories.map((category) => category.description),
  );
  const rerankerMs = Date.now() - rerankerStartedAt;
  const winner = reranked[0];
  if (!winner) {
    throw new Error("resource routing reranker returned no winner");
  }
  const selected = embeddingTop[winner.index];
  if (!selected) {
    throw new Error(`resource routing reranker selected invalid candidate index ${winner.index}`);
  }

  return {
    categoryKey: selected.key,
    categoryUri: selected.uri,
    fallback: false,
    embeddingTop,
    rerankerUsed: true,
    rerankerScores: reranked.map((result) => ({
      key: embeddingTop[result.index]!.key,
      score: result.score,
    })),
    timingMs: {
      embedding: embeddingMs,
      reranker: rerankerMs,
      total: Date.now() - startedAt,
    },
  };
}
