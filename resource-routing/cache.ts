import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { ResourceTaxonomy } from "./taxonomy.js";
import { listRouteableResourceCategories } from "./taxonomy.js";

export const RESOURCE_ROUTING_CACHE_SCHEMA_VERSION = 1 as const;

export type ResourceRoutingCacheCategory = {
  key: string;
  embedding: number[];
};

export type ResourceRoutingCacheDocument = {
  schemaVersion: 1;
  taxonomyHash: string;
  embeddingModel: string;
  dimensions: number;
  categories: ResourceRoutingCacheCategory[];
};

export type ResourceRoutingCacheExpectation = {
  taxonomyHash: string;
  embeddingModel: string;
  dimensions: number;
  categoryKeys: readonly string[];
};

export type ResourceRoutingCacheLoadResult =
  | { status: "hit"; cache: ResourceRoutingCacheDocument }
  | { status: "miss"; reason: string };

function canonicalTaxonomyValue(taxonomy: ResourceTaxonomy): unknown {
  return {
    schemaVersion: taxonomy.schemaVersion,
    categories: taxonomy.categories.map((category) => ({
      key: category.key,
      segment: category.segment,
      description: category.description,
      routeable: category.routeable,
      parentKey: category.parentKey ?? null,
      depth: category.depth,
      uri: category.uri,
    })),
  };
}

export function computeResourceTaxonomyHash(taxonomy: ResourceTaxonomy): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalTaxonomyValue(taxonomy)), "utf8")
    .digest("hex");
}

export function createResourceRoutingCacheExpectation(
  taxonomy: ResourceTaxonomy,
  embeddingModel: string,
  dimensions: number,
): ResourceRoutingCacheExpectation {
  return {
    taxonomyHash: computeResourceTaxonomyHash(taxonomy),
    embeddingModel,
    dimensions,
    categoryKeys: listRouteableResourceCategories(taxonomy).map((category) => category.key),
  };
}

function isFiniteEmbedding(value: unknown, dimensions: number): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === dimensions &&
    value.every((entry) => typeof entry === "number" && Number.isFinite(entry))
  );
}

export function validateResourceRoutingCache(
  value: unknown,
  expected: ResourceRoutingCacheExpectation,
): ResourceRoutingCacheLoadResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { status: "miss", reason: "cache is not an object" };
  }
  const cache = value as Partial<ResourceRoutingCacheDocument>;
  if (cache.schemaVersion !== RESOURCE_ROUTING_CACHE_SCHEMA_VERSION) {
    return { status: "miss", reason: "cache schema version mismatch" };
  }
  if (cache.taxonomyHash !== expected.taxonomyHash) {
    return { status: "miss", reason: "taxonomy hash mismatch" };
  }
  if (cache.embeddingModel !== expected.embeddingModel) {
    return { status: "miss", reason: "embedding model mismatch" };
  }
  if (cache.dimensions !== expected.dimensions) {
    return { status: "miss", reason: "embedding dimensions mismatch" };
  }
  if (!Array.isArray(cache.categories)) {
    return { status: "miss", reason: "cache categories are missing" };
  }
  if (cache.categories.length !== expected.categoryKeys.length) {
    return { status: "miss", reason: "cache category count mismatch" };
  }

  const expectedKeys = new Set(expected.categoryKeys);
  const seen = new Set<string>();
  for (const category of cache.categories) {
    if (!category || typeof category !== "object") {
      return { status: "miss", reason: "cache category is malformed" };
    }
    const key = (category as ResourceRoutingCacheCategory).key;
    const embedding = (category as ResourceRoutingCacheCategory).embedding;
    if (typeof key !== "string" || !expectedKeys.has(key) || seen.has(key)) {
      return { status: "miss", reason: "cache category keys do not match taxonomy" };
    }
    if (!isFiniteEmbedding(embedding, expected.dimensions)) {
      return { status: "miss", reason: `cache embedding is invalid for category ${key}` };
    }
    seen.add(key);
  }

  if (seen.size !== expectedKeys.size) {
    return { status: "miss", reason: "cache category keys are incomplete" };
  }

  return { status: "hit", cache: cache as ResourceRoutingCacheDocument };
}

export async function loadResourceRoutingCache(
  filePath: string,
  expected: ResourceRoutingCacheExpectation,
): Promise<ResourceRoutingCacheLoadResult> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "";
    return {
      status: "miss",
      reason: code === "ENOENT" ? "cache file does not exist" : `cache file could not be read: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { status: "miss", reason: `cache JSON is malformed: ${error instanceof Error ? error.message : String(error)}` };
  }
  return validateResourceRoutingCache(parsed, expected);
}

export async function writeResourceRoutingCacheAtomic(
  filePath: string,
  cache: ResourceRoutingCacheDocument,
): Promise<void> {
  const directory = dirname(filePath);
  await mkdir(directory, { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(cache)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}
