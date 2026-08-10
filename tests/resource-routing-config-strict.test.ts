import { describe, expect, it } from "vitest";

import { parseResourceRoutingConfig } from "../resource-routing/config.js";

describe("resource routing endpoint config strictness", () => {
  it("allows embedding-only dimensions/cacheKey but rejects them on reranker", () => {
    const embedding = parseResourceRoutingConfig({
      embedding: { dimensions: 1536, cacheKey: "weights-v2" },
    }).embedding;
    expect(embedding.dimensions).toBe(1536);
    expect(embedding.cacheKey).toBe("weights-v2");

    expect(() => parseResourceRoutingConfig({
      reranker: { dimensions: 1536 },
    })).toThrow(/resourceRouting\.reranker has unknown keys: dimensions/);

    expect(() => parseResourceRoutingConfig({
      reranker: { cacheKey: "not-applicable" },
    })).toThrow(/resourceRouting\.reranker has unknown keys: cacheKey/);
  });
});
