import { readFile, stat } from "node:fs/promises";

import type { ParsedResourceRoutingConfig } from "./config.js";
import { resolveAgentScopedResourceRoutingPath } from "./config.js";
import {
  readResourceRoutingEmbeddingCache,
  type ResourceRoutingCacheReadResult,
} from "./cache.js";
import {
  parseResourceTaxonomyYaml,
  resolveResourceTaxonomyCategory,
  type CompiledResourceCategory,
  type CompiledResourceTaxonomy,
} from "./taxonomy.js";

const MAX_TAXONOMY_FILE_BYTES = 1_048_576;

export type LoadedAgentResourceRouting = {
  agentId: string;
  taxonomyPath: string;
  cachePath: string;
  taxonomy: CompiledResourceTaxonomy;
  fallbackCategory: CompiledResourceCategory;
  embeddingCache: ResourceRoutingCacheReadResult;
};

export type ResourceRoutingTaxonomyLoader = {
  load(agentId: string): Promise<LoadedAgentResourceRouting>;
  has(agentId: string): boolean;
};

async function readTaxonomyFile(path: string): Promise<string> {
  let info;
  try {
    info = await stat(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `Resource routing taxonomy not found: ${path}. Copy the shipped config/resource-taxonomy.default.yaml to this per-agent path, customize it if needed, and restart OpenClaw.`,
        { cause: err },
      );
    }
    throw new Error(
      `Failed to inspect resource routing taxonomy ${path}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  if (!info.isFile()) {
    throw new Error(`Resource routing taxonomy must be a regular file: ${path}`);
  }
  if (info.size > MAX_TAXONOMY_FILE_BYTES) {
    throw new Error(`Resource routing taxonomy exceeds the 1 MiB safety limit: ${path}`);
  }
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    throw new Error(
      `Failed to read resource routing taxonomy ${path}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}

async function loadOneAgent(
  config: ParsedResourceRoutingConfig,
  agentId: string,
): Promise<LoadedAgentResourceRouting> {
  const taxonomyPath = resolveAgentScopedResourceRoutingPath(config.taxonomyFileTemplate, agentId);
  const cachePath = resolveAgentScopedResourceRoutingPath(config.cacheFileTemplate, agentId);
  const rawTaxonomy = await readTaxonomyFile(taxonomyPath);

  let taxonomy: CompiledResourceTaxonomy;
  try {
    taxonomy = parseResourceTaxonomyYaml(rawTaxonomy, taxonomyPath);
  } catch (err) {
    throw new Error(
      `Invalid resource routing taxonomy for agent ${JSON.stringify(agentId)}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  let fallbackCategory: CompiledResourceCategory;
  try {
    fallbackCategory = resolveResourceTaxonomyCategory(
      taxonomy,
      config.fallbackCategory,
      "configured resource routing fallbackCategory",
    );
  } catch (err) {
    throw new Error(
      `Invalid resource routing fallback for agent ${JSON.stringify(agentId)}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  const embeddingCache = await readResourceRoutingEmbeddingCache(cachePath, {
    taxonomyHash: taxonomy.taxonomyHash,
    embeddingModel: config.embedding.model,
    dimensions: config.embedding.dimensions,
    categoryKeys: taxonomy.routeableCategories.map((category) => category.key),
  });

  return {
    agentId,
    taxonomyPath,
    cachePath,
    taxonomy,
    fallbackCategory,
    embeddingCache,
  };
}

export function createResourceRoutingTaxonomyLoader(
  config: ParsedResourceRoutingConfig,
): ResourceRoutingTaxonomyLoader {
  const loaded = new Map<string, Promise<LoadedAgentResourceRouting>>();

  return {
    load(agentId: string) {
      const normalizedAgentId = agentId.trim();
      const existing = loaded.get(normalizedAgentId);
      if (existing) {
        return existing;
      }
      const pending = loadOneAgent(config, normalizedAgentId);
      loaded.set(normalizedAgentId, pending);
      return pending;
    },
    has(agentId: string) {
      return loaded.has(agentId.trim());
    },
  };
}
