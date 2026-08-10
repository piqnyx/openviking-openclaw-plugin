import { performance } from "node:perf_hooks";

import type { ParsedResourceRoutingConfig } from "./resource-routing-config.js";
import {
  computeResourceRoutingEmbeddingIdentity,
  loadResourceRoutingEmbeddingCache,
  writeResourceRoutingEmbeddingCacheAtomic,
  type ResourceRoutingEmbeddingCache,
} from "./resource-routing-cache.js";
import {
  ResourceRoutingEmbeddingClient,
  ResourceRoutingRerankerClient,
} from "./resource-routing-model-client.js";
import {
  selectTopCosineCandidates,
  type ResourceRoutingCandidate,
  type ResourceRoutingEmbeddedCategory,
} from "./resource-routing-retrieval.js";
import {
  resolvePerAgentFileTemplate,
  type CompiledResourceTaxonomy,
} from "./resource-taxonomy.js";

export type ResourceRoutingEmbeddingState = {
  source: "cache" | "recomputed";
  cacheMissReason?: string;
  categories: readonly ResourceRoutingEmbeddedCategory[];
};

export type ResourceRoutingDecisionTiming = {
  embeddingMs: number;
  rerankerMs?: number;
  totalMs: number;
};

export type ResourceRoutingDecision = {
  categoryKey: string;
  uri: string;
  fallback: boolean;
  fallbackReason?: "below_min_score";
  embeddingCandidates: readonly ResourceRoutingCandidate[];
  rerankerUsed: boolean;
  rerankerScores?: readonly {
    key: string;
    score: number;
  }[];
  timing: ResourceRoutingDecisionTiming;
};

type BuildEmbeddingStateInput = {
  taxonomy: CompiledResourceTaxonomy;
  agentId: string;
  config: ParsedResourceRoutingConfig;
  embedder: ResourceRoutingEmbeddingClient;
};

type ResourceRouterInput = {
  taxonomy: CompiledResourceTaxonomy;
  config: ParsedResourceRoutingConfig;
  embeddings: ResourceRoutingEmbeddingState;
  embedder: ResourceRoutingEmbeddingClient;
  reranker: ResourceRoutingRerankerClient;
};

function ensureConfiguredFallback(
  taxonomy: CompiledResourceTaxonomy,
  configuredFallback: string,
): void {
  if (taxonomy.fallbackKey !== configuredFallback) {
    throw new Error(
      `resource routing fallback mismatch: config selects ${JSON.stringify(configuredFallback)} but taxonomy declares ${JSON.stringify(taxonomy.fallbackKey)}`,
    );
  }
  const fallback = taxonomy.byKey.get(configuredFallback);
  if (!fallback || !fallback.routeable) {
    throw new Error(`resource routing fallback category ${JSON.stringify(configuredFallback)} is missing or not routeable`);
  }
}

function embeddingIdentity(config: ParsedResourceRoutingConfig): string {
  return computeResourceRoutingEmbeddingIdentity({
    baseUrl: config.embedding.baseUrl,
    model: config.embedding.model,
    apiKey: config.embedding.apiKey,
    headers: config.embedding.headers,
  });
}

function cacheFromVectors(
  taxonomy: CompiledResourceTaxonomy,
  config: ParsedResourceRoutingConfig,
  vectors: readonly number[][],
): ResourceRoutingEmbeddingCache {
  if (vectors.length !== taxonomy.routeableCategories.length) {
    throw new Error(
      `resource routing embedder returned ${vectors.length} category embeddings for ${taxonomy.routeableCategories.length} routeable categories`,
    );
  }
  return {
    schemaVersion: 1,
    taxonomyHash: taxonomy.taxonomyHash,
    embeddingModel: config.embedding.model,
    embeddingIdentity: embeddingIdentity(config),
    dimensions: config.embedding.dimensions,
    categories: taxonomy.routeableCategories.map((category, index) => ({
      key: category.key,
      embedding: [...vectors[index]],
    })),
  };
}

function embeddedCategoriesFromCache(
  taxonomy: CompiledResourceTaxonomy,
  cache: ResourceRoutingEmbeddingCache,
): ResourceRoutingEmbeddedCategory[] {
  const vectors = new Map(cache.categories.map((entry) => [entry.key, entry.embedding]));
  return taxonomy.routeableCategories.map((category) => {
    const embedding = vectors.get(category.key);
    if (!embedding) {
      throw new Error(`resource routing cache is missing category ${JSON.stringify(category.key)}`);
    }
    return {
      key: category.key,
      description: category.description,
      embedding,
    };
  });
}

export async function buildResourceRoutingEmbeddingState(
  input: BuildEmbeddingStateInput,
): Promise<ResourceRoutingEmbeddingState> {
  ensureConfiguredFallback(input.taxonomy, input.config.fallbackCategory);
  const cacheFile = resolvePerAgentFileTemplate(input.config.cacheFile, input.agentId);
  const expected = {
    taxonomyHash: input.taxonomy.taxonomyHash,
    embeddingModel: input.config.embedding.model,
    embeddingIdentity: embeddingIdentity(input.config),
    dimensions: input.config.embedding.dimensions,
    categoryKeys: input.taxonomy.routeableCategories.map((category) => category.key),
  };
  const cached = loadResourceRoutingEmbeddingCache(cacheFile, expected);
  if (cached.hit) {
    return {
      source: "cache",
      categories: embeddedCategoriesFromCache(input.taxonomy, cached.cache),
    };
  }

  const semanticDescriptions = input.taxonomy.routeableCategories.map((category) => category.description);
  const vectors = await input.embedder.embed(semanticDescriptions);
  const cache = cacheFromVectors(input.taxonomy, input.config, vectors);
  writeResourceRoutingEmbeddingCacheAtomic(cacheFile, cache);
  return {
    source: "recomputed",
    cacheMissReason: cached.reason,
    categories: embeddedCategoriesFromCache(input.taxonomy, cache),
  };
}

export class ResourceRouter {
  readonly #taxonomy: CompiledResourceTaxonomy;
  readonly #config: ParsedResourceRoutingConfig;
  readonly #embeddings: ResourceRoutingEmbeddingState;
  readonly #embedder: ResourceRoutingEmbeddingClient;
  readonly #reranker: ResourceRoutingRerankerClient;

  constructor(input: ResourceRouterInput) {
    ensureConfiguredFallback(input.taxonomy, input.config.fallbackCategory);
    this.#taxonomy = input.taxonomy;
    this.#config = input.config;
    this.#embeddings = input.embeddings;
    this.#embedder = input.embedder;
    this.#reranker = input.reranker;
  }

  async route(semanticInput: string): Promise<ResourceRoutingDecision> {
    if (typeof semanticInput !== "string" || !semanticInput.trim()) {
      throw new Error("resource routing semantic input must be a non-empty string");
    }
    const started = performance.now();
    const embeddingStarted = performance.now();
    const [queryEmbedding] = await this.#embedder.embed([semanticInput]);
    const embeddingMs = performance.now() - embeddingStarted;
    if (!queryEmbedding) {
      throw new Error("resource routing embedder returned no query embedding");
    }

    const embeddingCandidates = selectTopCosineCandidates(
      queryEmbedding,
      this.#embeddings.categories,
      this.#config.retrieval.topK,
    );
    const top = embeddingCandidates[0];
    if (!top) {
      throw new Error("resource routing produced no semantic candidates");
    }

    if (top.score < this.#config.retrieval.minScore) {
      const fallback = this.#taxonomy.byKey.get(this.#config.fallbackCategory);
      if (!fallback || !fallback.routeable) {
        throw new Error("resource routing configured fallback disappeared from the validated taxonomy");
      }
      return {
        categoryKey: fallback.key,
        uri: fallback.uri,
        fallback: true,
        fallbackReason: "below_min_score",
        embeddingCandidates,
        rerankerUsed: false,
        timing: {
          embeddingMs,
          totalMs: performance.now() - started,
        },
      };
    }

    const second = embeddingCandidates[1];
    const shouldRerank = Boolean(
      second &&
      top.score - second.score < this.#config.retrieval.rerankBelowMargin,
    );
    if (!shouldRerank || !second) {
      const selected = this.#taxonomy.byKey.get(top.key);
      if (!selected || !selected.routeable) {
        throw new Error(`resource routing selected unknown category ${JSON.stringify(top.key)}`);
      }
      return {
        categoryKey: selected.key,
        uri: selected.uri,
        fallback: false,
        embeddingCandidates,
        rerankerUsed: false,
        timing: {
          embeddingMs,
          totalMs: performance.now() - started,
        },
      };
    }

    const rerankCandidates = [top, second];
    const rerankerStarted = performance.now();
    const reranked = await this.#reranker.rerank(
      semanticInput,
      rerankCandidates.map((candidate) => candidate.description),
    );
    const rerankerMs = performance.now() - rerankerStarted;
    const rerankerScores = reranked.map((result) => {
      const candidate = rerankCandidates[result.index];
      if (!candidate) {
        throw new Error(`resource routing reranker selected invalid candidate index ${result.index}`);
      }
      return { key: candidate.key, score: result.score };
    });
    const selectedKey = rerankerScores[0]?.key;
    if (!selectedKey) {
      throw new Error("resource routing reranker returned no selected category");
    }
    const selected = this.#taxonomy.byKey.get(selectedKey);
    if (!selected || !selected.routeable) {
      throw new Error(`resource routing reranker selected unknown category ${JSON.stringify(selectedKey)}`);
    }
    return {
      categoryKey: selected.key,
      uri: selected.uri,
      fallback: false,
      embeddingCandidates,
      rerankerUsed: true,
      rerankerScores,
      timing: {
        embeddingMs,
        rerankerMs,
        totalMs: performance.now() - started,
      },
    };
  }
}