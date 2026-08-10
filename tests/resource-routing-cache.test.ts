import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  computeResourceRoutingEmbeddingIdentity,
  loadResourceRoutingEmbeddingCache,
  parseResourceRoutingEmbeddingCache,
  writeResourceRoutingEmbeddingCacheAtomic,
} from "../routing/resource-routing-cache.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempPath(name = "cache.json") {
  const dir = mkdtempSync(join(tmpdir(), "ov-resource-routing-cache-"));
  tempDirs.push(dir);
  return join(dir, "nested", name);
}

const embeddingIdentity = computeResourceRoutingEmbeddingIdentity({
  baseUrl: "http://127.0.0.1:18081",
  model: "bge-m3",
  apiKey: "secret-key",
  headers: { "X-Tenant": "main" },
});

const cache = {
  schemaVersion: 1 as const,
  taxonomyHash: "abc123",
  embeddingModel: "bge-m3",
  embeddingIdentity,
  dimensions: 3,
  categories: [
    { key: "docs", embedding: [1, 0, 0] },
    { key: "security", embedding: [0, 1, 0] },
  ],
};

const expected = {
  taxonomyHash: "abc123",
  embeddingModel: "bge-m3",
  embeddingIdentity,
  dimensions: 3,
  categoryKeys: ["docs", "security"],
};

describe("resource routing embedding cache", () => {
  it("round-trips an atomically written valid cache", () => {
    const file = tempPath();
    writeResourceRoutingEmbeddingCacheAtomic(file, cache);

    const result = loadResourceRoutingEmbeddingCache(file, expected);
    expect(result.hit).toBe(true);
    if (result.hit) {
      expect(result.cache).toEqual(cache);
    }
    expect(readFileSync(file, "utf8").endsWith("\n")).toBe(true);
  });

  it("binds cache identity to endpoint, model, credentials, and headers without storing those secrets", () => {
    const sameWithHeaderCaseChanged = computeResourceRoutingEmbeddingIdentity({
      baseUrl: "http://127.0.0.1:18081/",
      model: "bge-m3",
      apiKey: "secret-key",
      headers: { "x-tenant": "main" },
    });
    expect(sameWithHeaderCaseChanged).toBe(embeddingIdentity);

    const changedEndpoint = computeResourceRoutingEmbeddingIdentity({
      baseUrl: "http://127.0.0.1:28081",
      model: "bge-m3",
      apiKey: "secret-key",
      headers: { "X-Tenant": "main" },
    });
    const changedKey = computeResourceRoutingEmbeddingIdentity({
      baseUrl: "http://127.0.0.1:18081",
      model: "bge-m3",
      apiKey: "rotated-key",
      headers: { "X-Tenant": "main" },
    });
    expect(changedEndpoint).not.toBe(embeddingIdentity);
    expect(changedKey).not.toBe(embeddingIdentity);
    expect(JSON.stringify(cache)).not.toContain("secret-key");
  });

  it("treats missing, corrupt and stale cache files as safe misses", () => {
    const missing = tempPath("missing.json");
    expect(loadResourceRoutingEmbeddingCache(missing, expected)).toEqual({
      hit: false,
      reason: "missing",
    });

    const corrupt = tempPath("corrupt.json");
    writeResourceRoutingEmbeddingCacheAtomic(corrupt, cache);
    writeFileSync(corrupt, "not json", "utf8");
    const corruptResult = loadResourceRoutingEmbeddingCache(corrupt, expected);
    expect(corruptResult.hit).toBe(false);
    if (!corruptResult.hit) {
      expect(corruptResult.reason).toMatch(/^invalid:/);
    }

    const valid = tempPath("valid.json");
    writeResourceRoutingEmbeddingCacheAtomic(valid, cache);
    expect(loadResourceRoutingEmbeddingCache(valid, { ...expected, taxonomyHash: "changed" }))
      .toEqual({ hit: false, reason: "taxonomy_hash_mismatch" });
    expect(loadResourceRoutingEmbeddingCache(valid, { ...expected, embeddingModel: "other" }))
      .toEqual({ hit: false, reason: "embedding_model_mismatch" });
    expect(loadResourceRoutingEmbeddingCache(valid, { ...expected, embeddingIdentity: "changed" }))
      .toEqual({ hit: false, reason: "embedding_identity_mismatch" });
    expect(loadResourceRoutingEmbeddingCache(valid, { ...expected, dimensions: 1024 }))
      .toEqual({ hit: false, reason: "dimensions_mismatch" });
    expect(loadResourceRoutingEmbeddingCache(valid, { ...expected, categoryKeys: ["docs"] }))
      .toEqual({ hit: false, reason: "category_keys_mismatch" });
  });

  it("strictly validates cache schema, identity, vectors and category keys", () => {
    expect(() => parseResourceRoutingEmbeddingCache({ ...cache, magic: true }))
      .toThrow(/unknown keys: magic/);
    expect(() => parseResourceRoutingEmbeddingCache({ ...cache, schemaVersion: 2 }))
      .toThrow(/schemaVersion must be 1/);
    expect(() => parseResourceRoutingEmbeddingCache({ ...cache, embeddingIdentity: "" }))
      .toThrow(/embeddingIdentity must be a non-empty string/);
    expect(() => parseResourceRoutingEmbeddingCache({
      ...cache,
      categories: [{ key: "docs", embedding: [0, 0, 0] }],
    })).toThrow(/non-zero norm/);
    expect(() => parseResourceRoutingEmbeddingCache({
      ...cache,
      categories: [
        { key: "docs", embedding: [1, 0, 0] },
        { key: "docs", embedding: [0, 1, 0] },
      ],
    })).toThrow(/duplicated/);
  });
});