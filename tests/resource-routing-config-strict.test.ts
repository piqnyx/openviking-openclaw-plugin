import { describe, expect, it } from "vitest";

import { parseResourceRoutingConfig } from "../resource-routing/config.js";

describe("resource routing endpoint config strictness", () => {
  it("allows embedding dimensions but rejects meaningless reranker dimensions", () => {
    expect(parseResourceRoutingConfig({
      embedding: { dimensions: 1536 },
    }).embedding.dimensions).toBe(1536);

    expect(() => parseResourceRoutingConfig({
      reranker: { dimensions: 1536 },
    })).toThrow(/resourceRouting\.reranker has unknown keys: dimensions/);
  });
});
