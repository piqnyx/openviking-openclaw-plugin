import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  computeResourceTaxonomyHash,
  createResourceRoutingCacheExpectation,
  loadResourceRoutingCache,
  validateResourceRoutingCache,
  writeResourceRoutingCacheAtomic,
  type ResourceRoutingCacheDocument,
} from "../resource-routing/cache.js";
import { parseResourceTaxonomy } from "../resource-routing/taxonomy.js";

function taxonomy() {
  return parseResourceTaxonomy({
    schemaVersion: 1,
    categories: {
      inbox: {
        segment: "__INBOX__",
        description: "Fallback destination for semantically uncertain resources.",
      },
      docs: {
        segment: "documents",
        description: "General documents.",
        children: {
          manuals: {
            segment: "manuals",
            description: "Product and operator manuals.",
          },
        },
      },
      grouping: {
        segment: "grouping",
        description: "Organizational branch only.",
        routeable: false,
      },
    },
  });
}

function makeCache(): ResourceRoutingCacheDocument {
  const parsed = taxonomy();
  const expectation = createResourceRoutingCacheExpectation(parsed, "bge-m3", 3);
  return {
    schemaVersion: 1,
    taxonomyHash: expectation.taxonomyHash,
    embeddingModel: "bge-m3",
    dimensions: 3,
    categories: expectation.categoryKeys.map((key, index) => ({
      key,
      embedding: [index + 0.1, index + 0.2, index + 0.3],
    })),
  };
}

describe("resource routing cache", () => {
  it("hashes canonical routing data deterministically", () => {
    const first = taxonomy();
    const second = taxonomy();
    expect(computeResourceTaxonomyHash(first)).toMatch(/^[a-f0-9]{64}$/);
    expect(computeResourceTaxonomyHash(second)).toBe(computeResourceTaxonomyHash(first));
  });

  it("invalidates cache when semantic taxonomy data changes", () => {
    const first = taxonomy();
    const changed = parseResourceTaxonomy({
      schemaVersion: 1,
      categories: {
        inbox: {
          segment: "__INBOX__",
          description: "A changed fallback description.",
        },
      },
    });
    expect(computeResourceTaxonomyHash(changed)).not.toBe(computeResourceTaxonomyHash(first));
  });

  it("accepts exactly the routeable category set with matching model and dimensions", () => {
    const parsed = taxonomy();
    const expected = createResourceRoutingCacheExpectation(parsed, "bge-m3", 3);
    const result = validateResourceRoutingCache(makeCache(), expected);
    expect(result.status).toBe("hit");
    expect(expected.categoryKeys).toEqual(["inbox", "docs", "manuals"]);
  });

  it("treats corrupt or stale cache as a miss that can be rebuilt", () => {
    const parsed = taxonomy();
    const expected = createResourceRoutingCacheExpectation(parsed, "bge-m3", 3);
    const cache = makeCache();

    expect(validateResourceRoutingCache({ ...cache, taxonomyHash: "stale" }, expected)).toMatchObject({ status: "miss" });
    expect(validateResourceRoutingCache({ ...cache, embeddingModel: "other" }, expected)).toMatchObject({ status: "miss" });
    expect(validateResourceRoutingCache({ ...cache, dimensions: 4 }, expected)).toMatchObject({ status: "miss" });
    expect(validateResourceRoutingCache({ ...cache, categories: cache.categories.slice(1) }, expected)).toMatchObject({ status: "miss" });
    expect(validateResourceRoutingCache({
      ...cache,
      categories: cache.categories.map((entry, index) => index === 0 ? { ...entry, embedding: [1, Number.NaN, 3] } : entry),
    }, expected)).toMatchObject({ status: "miss" });
  });

  it("loads malformed JSON as a rebuildable miss instead of trusting it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ov-routing-cache-"));
    const path = join(dir, "cache.json");
    await writeFile(path, "{ definitely-not-json", "utf8");
    const expected = createResourceRoutingCacheExpectation(taxonomy(), "bge-m3", 3);
    const result = await loadResourceRoutingCache(path, expected);
    expect(result).toMatchObject({ status: "miss" });
    if (result.status === "miss") {
      expect(result.reason).toMatch(/malformed/);
    }
  });

  it("writes and replaces cache atomically with mode 0600 and no temp-file debris", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ov-routing-cache-"));
    const path = join(dir, "nested", "cache.json");
    const first = makeCache();
    await writeResourceRoutingCacheAtomic(path, first);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(first);

    const fileStat = await stat(path);
    if (process.platform !== "win32") {
      expect(fileStat.mode & 0o777).toBe(0o600);
    }

    const second: ResourceRoutingCacheDocument = {
      ...first,
      embeddingModel: "bge-m3-replaced",
    };
    await writeResourceRoutingCacheAtomic(path, second);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(second);

    const siblings = await readdir(dirname(path));
    expect(siblings.filter((name) => name.startsWith("cache.json.tmp-"))).toEqual([]);
  });
});
