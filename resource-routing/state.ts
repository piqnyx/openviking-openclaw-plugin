import type { ParsedResourceRoutingConfig } from "./config.js";
import { resolveAgentResourceRoutingPaths } from "./config.js";
import {
  createResourceRoutingCacheExpectation,
  loadResourceRoutingCache,
  writeResourceRoutingCacheAtomic,
  type ResourceRoutingCacheDocument,
} from "./cache.js";
import type { ResourceEmbeddingClient } from "./ml-client.js";
import {
  assertResourceRoutingFallbackCategory,
  listRouteableResourceCategories,
  loadResourceTaxonomyFile,
  type ResourceTaxonomy,
} from "./taxonomy.js";
import type { ResourceRoutingPreparedState } from "./decision.js";

export type PreparedAgentResourceRoutingState = ResourceRoutingPreparedState & {
  agentId: string;
  taxonomyHash: string;
  paths: {
    taxonomyFile: string;
    cacheFile: string;
    auditFile: string;
  };
  cache: {
    rebuilt: boolean;
    reason?: string;
  };
};

export type PrepareAgentResourceRoutingStateOptions = {
  loadTaxonomy?: (filePath: string) => Promise<ResourceTaxonomy>;
  loadCache?: typeof loadResourceRoutingCache;
  writeCache?: typeof writeResourceRoutingCacheAtomic;
};

export function resourceEmbeddingModelIdentity(config: ParsedResourceRoutingConfig): string {
  const endpointIdentity = `${config.embedding.model}@${config.embedding.baseUrl}${config.embedding.endpointPath}`;
  return config.embedding.cacheKey
    ? `${endpointIdentity}|cacheKey=${config.embedding.cacheKey}`
    : endpointIdentity;
}

function cacheToEmbeddingMap(cache: ResourceRoutingCacheDocument): ReadonlyMap<string, readonly number[]> {
  return new Map(cache.categories.map((category) => [category.key, category.embedding] as const));
}

export async function prepareAgentResourceRoutingState(
  config: ParsedResourceRoutingConfig,
  agentId: string,
  embedder: ResourceEmbeddingClient,
  options: PrepareAgentResourceRoutingStateOptions = {},
): Promise<PreparedAgentResourceRoutingState> {
  if (!config.enabled) {
    throw new Error("resource routing is disabled");
  }

  const paths = resolveAgentResourceRoutingPaths(config, agentId);
  const taxonomy = await (options.loadTaxonomy ?? loadResourceTaxonomyFile)(paths.taxonomyFile);
  assertResourceRoutingFallbackCategory(taxonomy, config.fallbackCategory);
  const routeable = listRouteableResourceCategories(taxonomy);
  if (routeable.length === 0) {
    throw new Error(`resource routing taxonomy for agent ${agentId} has no routeable categories`);
  }

  const modelIdentity = resourceEmbeddingModelIdentity(config);
  const expectation = createResourceRoutingCacheExpectation(
    taxonomy,
    modelIdentity,
    config.embedding.dimensions,
  );
  const cacheResult = await (options.loadCache ?? loadResourceRoutingCache)(paths.cacheFile, expectation);
  if (cacheResult.status === "hit") {
    return {
      agentId,
      taxonomy,
      taxonomyHash: expectation.taxonomyHash,
      embeddings: cacheToEmbeddingMap(cacheResult.cache),
      paths,
      cache: { rebuilt: false },
    };
  }

  const vectors = await embedder.embed(routeable.map((category) => category.description));
  if (vectors.length !== routeable.length) {
    throw new Error(
      `resource routing embedder returned ${vectors.length} taxonomy vectors; expected ${routeable.length}`,
    );
  }

  const cache: ResourceRoutingCacheDocument = {
    schemaVersion: 1,
    taxonomyHash: expectation.taxonomyHash,
    embeddingModel: modelIdentity,
    dimensions: config.embedding.dimensions,
    categories: routeable.map((category, index) => ({
      key: category.key,
      embedding: vectors[index]!,
    })),
  };
  await (options.writeCache ?? writeResourceRoutingCacheAtomic)(paths.cacheFile, cache);

  return {
    agentId,
    taxonomy,
    taxonomyHash: expectation.taxonomyHash,
    embeddings: cacheToEmbeddingMap(cache),
    paths,
    cache: {
      rebuilt: true,
      reason: cacheResult.reason,
    },
  };
}
