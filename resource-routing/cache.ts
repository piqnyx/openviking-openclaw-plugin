import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

export const RESOURCE_ROUTING_CACHE_SCHEMA_VERSION = 1;

export type ResourceRoutingCachedCategory = {
  key: string;
  embedding: number[];
};

export type ResourceRoutingEmbeddingCache = {
  schemaVersion: 1;
  taxonomyHash: string;
  embeddingModel: string;
  dimensions: number;
  categories: ResourceRoutingCachedCategory[];
};

export type ResourceRoutingCacheIdentity = {
  taxonomyHash: string;
  embeddingModel: string;
  dimensions: number;
  categoryKeys: readonly string[];
};

export type ResourceRoutingCacheReadResult =
  | {
      status: "hit";
      cache: ResourceRoutingEmbeddingCache;
    }
  | {
      status: "miss";
      reason:
        | "not_found"
        | "invalid_json"
        | "invalid_shape"
        | "identity_mismatch"
        | "category_mismatch";
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function isFiniteEmbedding(value: unknown, dimensions: number): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === dimensions &&
    value.every((item) => typeof item === "number" && Number.isFinite(item))
  );
}

function parseCacheShape(value: unknown): ResourceRoutingEmbeddingCache | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const allowedRootKeys = new Set([
    "schemaVersion",
    "taxonomyHash",
    "embeddingModel",
    "dimensions",
    "categories",
  ]);
  if (Object.keys(value).some((key) => !allowedRootKeys.has(key))) {
    return undefined;
  }
  if (value.schemaVersion !== RESOURCE_ROUTING_CACHE_SCHEMA_VERSION) {
    return undefined;
  }
  if (!isSha256(value.taxonomyHash)) {
    return undefined;
  }
  if (typeof value.embeddingModel !== "string" || !value.embeddingModel.trim()) {
    return undefined;
  }
  if (
    typeof value.dimensions !== "number" ||
    !Number.isInteger(value.dimensions) ||
    value.dimensions < 1 ||
    value.dimensions > 65_536
  ) {
    return undefined;
  }
  if (!Array.isArray(value.categories)) {
    return undefined;
  }

  const categories: ResourceRoutingCachedCategory[] = [];
  const seen = new Set<string>();
  for (const rawCategory of value.categories) {
    if (!isRecord(rawCategory)) {
      return undefined;
    }
    if (Object.keys(rawCategory).some((key) => key !== "key" && key !== "embedding")) {
      return undefined;
    }
    if (typeof rawCategory.key !== "string" || !rawCategory.key.trim() || seen.has(rawCategory.key)) {
      return undefined;
    }
    if (!isFiniteEmbedding(rawCategory.embedding, value.dimensions)) {
      return undefined;
    }
    seen.add(rawCategory.key);
    categories.push({
      key: rawCategory.key,
      embedding: rawCategory.embedding,
    });
  }

  return {
    schemaVersion: RESOURCE_ROUTING_CACHE_SCHEMA_VERSION,
    taxonomyHash: value.taxonomyHash,
    embeddingModel: value.embeddingModel.trim(),
    dimensions: value.dimensions,
    categories,
  };
}

function sameCategoryKeySet(actual: readonly string[], expected: readonly string[]): boolean {
  if (actual.length !== expected.length) {
    return false;
  }
  const expectedSet = new Set(expected);
  return expectedSet.size === expected.length && actual.every((key) => expectedSet.has(key));
}

export function validateResourceRoutingEmbeddingCache(
  value: unknown,
  identity: ResourceRoutingCacheIdentity,
): ResourceRoutingCacheReadResult {
  const cache = parseCacheShape(value);
  if (!cache) {
    return { status: "miss", reason: "invalid_shape" };
  }
  if (
    cache.taxonomyHash !== identity.taxonomyHash ||
    cache.embeddingModel !== identity.embeddingModel ||
    cache.dimensions !== identity.dimensions
  ) {
    return { status: "miss", reason: "identity_mismatch" };
  }
  if (!sameCategoryKeySet(cache.categories.map((category) => category.key), identity.categoryKeys)) {
    return { status: "miss", reason: "category_mismatch" };
  }
  return { status: "hit", cache };
}

export async function readResourceRoutingEmbeddingCache(
  path: string,
  identity: ResourceRoutingCacheIdentity,
): Promise<ResourceRoutingCacheReadResult> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { status: "miss", reason: "not_found" };
    }
    throw new Error(
      `Failed to read resource routing cache ${path}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: "miss", reason: "invalid_json" };
  }
  return validateResourceRoutingEmbeddingCache(parsed, identity);
}

export async function writeResourceRoutingEmbeddingCacheAtomic(
  path: string,
  cache: ResourceRoutingEmbeddingCache,
): Promise<void> {
  const validated = validateResourceRoutingEmbeddingCache(cache, {
    taxonomyHash: cache.taxonomyHash,
    embeddingModel: cache.embeddingModel,
    dimensions: cache.dimensions,
    categoryKeys: cache.categories.map((category) => category.key),
  });
  if (validated.status !== "hit") {
    throw new Error(`Refusing to write invalid resource routing cache: ${validated.reason}`);
  }

  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tempPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const handle = await open(tempPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(cache)}\n`, "utf8");
    await handle.sync();
  } catch (err) {
    await handle.close().catch(() => undefined);
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw err;
  }
  await handle.close();

  try {
    await rename(tempPath, path);
  } catch (err) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw new Error(
      `Failed to atomically replace resource routing cache ${path}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}
