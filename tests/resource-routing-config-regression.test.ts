import { describe, expect, it } from "vitest";

import { parseResourceRoutingConfig } from "../routing/resource-routing-config.js";

describe("resource routing endpoint key boundaries", () => {
  it("accepts dimensions only for the embedding endpoint", () => {
    expect(parseResourceRoutingConfig({ embedding: { dimensions: 1536 } }).embedding.dimensions)
      .toBe(1536);
  });

  it("keeps reranker endpoint strict and rejects dimensions", () => {
    expect(() => parseResourceRoutingConfig({ reranker: { dimensions: 1024 } }))
      .toThrow(/reranker has unknown keys: dimensions/);
  });
});
