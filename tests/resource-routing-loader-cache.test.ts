import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseResourceRoutingConfig } from "../resource-routing/config.js";
import {
  readResourceRoutingEmbeddingCache,
  validateResourceRoutingEmbeddingCache,
  writeResourceRoutingEmbeddingCacheAtomic,
  type ResourceRoutingEmbeddingCache,
} from "../resource-routing/cache.js";
import { createResourceRoutingTaxonomyLoader } from "../resource-routing/loader.js";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ov-resource-routing-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function taxonomy(extra = ""): string {
  return `schemaVersion: 1
categories:
  inbox:
    segment: __INBOX__
    description: Uncertain resources.
  documents:
    segment: documents
    description: General written documents.
    children:
      reports:
        segment: reports
        description: Reports and formal written analyses.
${extra}`;
}

function routingConfig(dir: string, fallbackCategory = "inbox") {
  return parseResourceRoutingConfig({
    enabled: true,
    taxonomyFileTemplate: join(dir, "{agentId}.yaml"),
    cacheFileTemplate: join(dir, "cache", "{agentId}.json"),
    fallbackCategory,
    embedding: {
      model: "test-embedder",
      dimensions: 3,
    },
  });
}

function cache(
  taxonomyHash: string,
  categories: Array<{ key: string; embedding: number[] }>,
): ResourceRoutingEmbeddingCache {
  return {
    schemaVersion: 1,
    taxonomyHash,
    embeddingModel: "test-embedder",
    dimensions: 3,
    categories,
  };
}

describe("resource routing embedding cache", () => {
  it("accepts only the exact taxonomy/model/dimensions/category identity", () => {
    const identity = {
      taxonomyHash: "a".repeat(64),
      embeddingModel: "test-embedder",
      dimensions: 3,
      categoryKeys: ["inbox", "reports"],
    };
    const value = cache(identity.taxonomyHash, [
      { key: "inbox", embedding: [1, 0, 0] },
      { key: "reports", embedding: [0, 1, 0] },
    ]);
    expect(validateResourceRoutingEmbeddingCache(value, identity).status).toBe("hit");
    expect(
      validateResourceRoutingEmbeddingCache(value, {
        ...identity,
        taxonomyHash: "b".repeat(64),
      }),
    ).toEqual({ status: "miss", reason: "identity_mismatch" });
    expect(
      validateResourceRoutingEmbeddingCache(value, {
        ...identity,
        categoryKeys: ["inbox", "documents"],
      }),
    ).toEqual({ status: "miss", reason: "category_mismatch" });
  });

  it("rejects malformed, duplicate, non-finite, and wrong-sized vectors", () => {
    const identity = {
      taxonomyHash: "a".repeat(64),
      embeddingModel: "test-embedder",
      dimensions: 3,
      categoryKeys: ["inbox"],
    };
    for (const embedding of [[1, 2], [1, 2, Number.NaN], [1, 2, Number.POSITIVE_INFINITY]]) {
      expect(
        validateResourceRoutingEmbeddingCache(
          cache(identity.taxonomyHash, [{ key: "inbox", embedding }]),
          identity,
        ),
      ).toEqual({ status: "miss", reason: "invalid_shape" });
    }
    expect(
      validateResourceRoutingEmbeddingCache(
        cache(identity.taxonomyHash, [
          { key: "inbox", embedding: [1, 0, 0] },
          { key: "inbox", embedding: [0, 1, 0] },
        ]),
        identity,
      ),
    ).toEqual({ status: "miss", reason: "invalid_shape" });
  });

  it("writes atomically and reads a valid cache back", async () => {
    const dir = await tempDir();
    const path = join(dir, "nested", "cache.json");
    const value = cache("a".repeat(64), [
      { key: "inbox", embedding: [1, 0, 0] },
      { key: "reports", embedding: [0, 1, 0] },
    ]);
    await writeResourceRoutingEmbeddingCacheAtomic(path, value);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(value);
    await expect(
      readResourceRoutingEmbeddingCache(path, {
        taxonomyHash: value.taxonomyHash,
        embeddingModel: value.embeddingModel,
        dimensions: value.dimensions,
        categoryKeys: ["reports", "inbox"],
      }),
    ).resolves.toMatchObject({ status: "hit" });
  });

  it("treats missing or corrupt cache content as a safe recompute miss", async () => {
    const dir = await tempDir();
    const path = join(dir, "cache.json");
    const identity = {
      taxonomyHash: "a".repeat(64),
      embeddingModel: "test-embedder",
      dimensions: 3,
      categoryKeys: ["inbox"],
    };
    await expect(readResourceRoutingEmbeddingCache(path, identity)).resolves.toEqual({
      status: "miss",
      reason: "not_found",
    });
    await writeFile(path, "{definitely broken", "utf8");
    await expect(readResourceRoutingEmbeddingCache(path, identity)).resolves.toEqual({
      status: "miss",
      reason: "invalid_json",
    });
  });
});

describe("per-agent resource taxonomy loader", () => {
  it("loads isolated per-agent taxonomies and resolves the configured fallback", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "main.yaml"), taxonomy(), "utf8");
    await writeFile(
      join(dir, "igor.yaml"),
      taxonomy(`  media:
    segment: media
    description: Media resources.
`),
      "utf8",
    );
    const loader = createResourceRoutingTaxonomyLoader(routingConfig(dir));
    const main = await loader.load("main");
    const igor = await loader.load("igor");

    expect(main.taxonomyPath).toBe(join(dir, "main.yaml"));
    expect(igor.taxonomyPath).toBe(join(dir, "igor.yaml"));
    expect(main.taxonomy.byKey.has("media")).toBe(false);
    expect(igor.taxonomy.byKey.has("media")).toBe(true);
    expect(main.fallbackCategory).toMatchObject({
      key: "inbox",
      uri: "viking://resources/__INBOX__",
      routeable: true,
    });
    expect(main.embeddingCache).toEqual({ status: "miss", reason: "not_found" });
    expect(loader.has("main")).toBe(true);
    expect(loader.has("igor")).toBe(true);
  });

  it("loads a matching category cache into the per-agent runtime state", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "main.yaml"), taxonomy(), "utf8");
    const cfg = routingConfig(dir);
    const first = await createResourceRoutingTaxonomyLoader(cfg).load("main");
    await writeResourceRoutingEmbeddingCacheAtomic(
      first.cachePath,
      cache(
        first.taxonomy.taxonomyHash,
        first.taxonomy.routeableCategories.map((category, index) => ({
          key: category.key,
          embedding: [index + 1, index + 2, index + 3],
        })),
      ),
    );

    const loaded = await createResourceRoutingTaxonomyLoader(cfg).load("main");
    expect(loaded.embeddingCache.status).toBe("hit");
  });

  it("invalidates a cache when semantic taxonomy content changes", async () => {
    const dir = await tempDir();
    const path = join(dir, "main.yaml");
    await writeFile(path, taxonomy(), "utf8");
    const cfg = routingConfig(dir);
    const before = await createResourceRoutingTaxonomyLoader(cfg).load("main");
    await writeResourceRoutingEmbeddingCacheAtomic(
      before.cachePath,
      cache(
        before.taxonomy.taxonomyHash,
        before.taxonomy.routeableCategories.map((category, index) => ({
          key: category.key,
          embedding: [index + 1, index + 2, index + 3],
        })),
      ),
    );
    await writeFile(
      path,
      taxonomy().replace("Reports and formal written analyses.", "Changed semantic meaning."),
      "utf8",
    );

    const after = await createResourceRoutingTaxonomyLoader(cfg).load("main");
    expect(after.taxonomy.taxonomyHash).not.toBe(before.taxonomy.taxonomyHash);
    expect(after.embeddingCache).toEqual({ status: "miss", reason: "identity_mismatch" });
  });

  it("keeps taxonomy state fixed for the process lifetime until restart", async () => {
    const dir = await tempDir();
    const path = join(dir, "main.yaml");
    await writeFile(path, taxonomy(), "utf8");
    const cfg = routingConfig(dir);
    const loader = createResourceRoutingTaxonomyLoader(cfg);
    const first = await loader.load("main");
    await writeFile(
      path,
      taxonomy(`  media:
    segment: media
    description: Media resources.
`),
      "utf8",
    );
    const sameProcess = await loader.load("main");
    const afterRestart = await createResourceRoutingTaxonomyLoader(cfg).load("main");

    expect(sameProcess).toBe(first);
    expect(sameProcess.taxonomy.byKey.has("media")).toBe(false);
    expect(afterRestart.taxonomy.byKey.has("media")).toBe(true);
  });

  it("fails closed with a useful hint when the per-agent taxonomy is missing", async () => {
    const dir = await tempDir();
    const loader = createResourceRoutingTaxonomyLoader(routingConfig(dir));
    await expect(loader.load("main")).rejects.toThrow(
      /taxonomy not found.*resource-taxonomy\.default\.yaml.*restart OpenClaw/i,
    );
  });

  it("fails closed when the configured fallback does not exist or is not routeable", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "main.yaml"), taxonomy(), "utf8");
    await expect(
      createResourceRoutingTaxonomyLoader(routingConfig(dir, "missing")).load("main"),
    ).rejects.toThrow(/fallback.*does not exist/i);

    await writeFile(
      join(dir, "main.yaml"),
      taxonomy().replace("segment: __INBOX__", "segment: __INBOX__\n    routeable: false"),
      "utf8",
    );
    await expect(
      createResourceRoutingTaxonomyLoader(routingConfig(dir)).load("main"),
    ).rejects.toThrow(/fallback.*not routeable/i);
  });
});
