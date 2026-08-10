import { describe, expect, it } from "vitest";

import { parseResourceRoutingConfig } from "../resource-routing/config.js";
import { resourceEmbeddingModelIdentity } from "../resource-routing/state.js";

describe("resource routing embedding cache identity", () => {
  it("changes when self-hosted weights change behind the same endpoint/model name", () => {
    const first = parseResourceRoutingConfig({
      embedding: {
        baseUrl: "http://127.0.0.1:18081",
        model: "bge-m3",
        cacheKey: "bge-m3-q4-k-m-v1",
      },
    });
    const second = parseResourceRoutingConfig({
      embedding: {
        baseUrl: "http://127.0.0.1:18081",
        model: "bge-m3",
        cacheKey: "bge-m3-q4-k-m-v2",
      },
    });

    expect(resourceEmbeddingModelIdentity(first)).not.toBe(resourceEmbeddingModelIdentity(second));
    expect(resourceEmbeddingModelIdentity(first)).toContain("cacheKey=bge-m3-q4-k-m-v1");
  });

  it("keeps the historical endpoint/model identity when cacheKey is omitted", () => {
    const cfg = parseResourceRoutingConfig(undefined);
    expect(resourceEmbeddingModelIdentity(cfg)).toBe(
      "bge-m3@http://127.0.0.1:18081/v1/embeddings",
    );
  });
});
