import {
  writeResourceRoutingEmbeddingCacheAtomic,
  type ResourceRoutingEmbeddingCache,
} from "./cache.js";
import type {
  LoadedAgentResourceRouting,
  ResourceRoutingTaxonomyLoader,
} from "./loader.js";
import type { ResourceRoutingEmbeddingClient } from "./providers.js";

export type PreparedResourceCategoryEmbeddings = {
  agentId: string;
  taxonomyHash: string;
  source: "cache" | "embedder";
  vectorsByCategoryKey: ReadonlyMap<string, number[]>;
};

export type ResourceRoutingCategoryEmbeddingStore = {
  get(agentId: string): Promise<PreparedResourceCategoryEmbeddings>;
  has(agentId: string): boolean;
};

export function resourceCategoryEmbeddingInput(description: string): string {
  return description.trim();
}

function vectorsFromCache(
  loaded: LoadedAgentResourceRouting,
): PreparedResourceCategoryEmbeddings | undefined {
  if (loaded.embeddingCache.status !== "hit") {
    return undefined;
  }
  return {
    agentId: loaded.agentId,
    taxonomyHash: loaded.taxonomy.taxonomyHash,
    source: "cache",
    vectorsByCategoryKey: new Map(
      loaded.embeddingCache.cache.categories.map((category) => [category.key, category.embedding]),
    ),
  };
}

export async function prepareResourceCategoryEmbeddings(
  loaded: LoadedAgentResourceRouting,
  embeddingClient: ResourceRoutingEmbeddingClient,
  embeddingModel: string,
  dimensions: number,
): Promise<PreparedResourceCategoryEmbeddings> {
  const cached = vectorsFromCache(loaded);
  if (cached) {
    return cached;
  }

  const categories = loaded.taxonomy.routeableCategories;
  const inputs = categories.map((category) => resourceCategoryEmbeddingInput(category.description));
  const vectors = await embeddingClient.embed(inputs);
  if (vectors.length !== categories.length) {
    throw new Error(
      `Resource routing embedder returned ${vectors.length} category vectors for ${categories.length} routeable categories`,
    );
  }

  const cache: ResourceRoutingEmbeddingCache = {
    schemaVersion: 1,
    taxonomyHash: loaded.taxonomy.taxonomyHash,
    embeddingModel,
    dimensions,
    categories: categories.map((category, index) => ({
      key: category.key,
      embedding: vectors[index]!,
    })),
  };
  await writeResourceRoutingEmbeddingCacheAtomic(loaded.cachePath, cache);

  return {
    agentId: loaded.agentId,
    taxonomyHash: loaded.taxonomy.taxonomyHash,
    source: "embedder",
    vectorsByCategoryKey: new Map(
      cache.categories.map((category) => [category.key, category.embedding]),
    ),
  };
}

export function createResourceRoutingCategoryEmbeddingStore(options: {
  loader: ResourceRoutingTaxonomyLoader;
  embeddingClient: ResourceRoutingEmbeddingClient;
  embeddingModel: string;
  dimensions: number;
}): ResourceRoutingCategoryEmbeddingStore {
  const prepared = new Map<string, Promise<PreparedResourceCategoryEmbeddings>>();

  return {
    get(agentId: string) {
      const normalizedAgentId = agentId.trim();
      const existing = prepared.get(normalizedAgentId);
      if (existing) {
        return existing;
      }
      const pending = options.loader
        .load(normalizedAgentId)
        .then((loaded) =>
          prepareResourceCategoryEmbeddings(
            loaded,
            options.embeddingClient,
            options.embeddingModel,
            options.dimensions,
          ),
        );
      prepared.set(normalizedAgentId, pending);
      return pending;
    },
    has(agentId: string) {
      return prepared.has(agentId.trim());
    },
  };
}
