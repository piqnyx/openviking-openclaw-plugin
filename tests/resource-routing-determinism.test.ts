import { describe, expect, it, vi } from "vitest";

import { parseResourceRoutingConfig } from "../resource-routing/config.js";
import { decideAutomaticResourceRoute } from "../resource-routing/decision.js";
import {
  ResourceEmbeddingClient,
  ResourceRerankerClient,
  type ResourceRoutingHttpTransport,
} from "../resource-routing/ml-client.js";
import { parseResourceTaxonomy } from "../resource-routing/taxonomy.js";

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("resource routing deterministic ties", () => {
  it("breaks identical cosine scores by stable key ordering without locale collation", async () => {
    const cfg = parseResourceRoutingConfig({
      enabled: true,
      embedding: { dimensions: 2 },
      retrieval: { topK: 2, minScore: -1, rerankBelowMargin: 0 },
    });
    const taxonomy = parseResourceTaxonomy({
      schemaVersion: 1,
      categories: {
        zeta: { segment: "zeta", description: "Zeta material." },
        alpha: { segment: "alpha", description: "Alpha material." },
      },
    });
    const embedTransport: ResourceRoutingHttpTransport = async () => jsonResponse({
      data: [{ index: 0, embedding: [1, 0] }],
    });
    const rerankTransport: ResourceRoutingHttpTransport = vi.fn(async () => {
      throw new Error("exact ties must not rerank when margin threshold is zero");
    });

    const result = await decideAutomaticResourceRoute({
      semanticInput: "equally similar",
      config: cfg,
      state: {
        taxonomy,
        embeddings: new Map([
          ["zeta", [1, 0]],
          ["alpha", [1, 0]],
        ]),
      },
      embedder: new ResourceEmbeddingClient(cfg.embedding, embedTransport),
      reranker: new ResourceRerankerClient(cfg.reranker, rerankTransport),
    });

    expect(result.embeddingTop.map((entry) => entry.key)).toEqual(["alpha", "zeta"]);
    expect(result.categoryKey).toBe("alpha");
    expect(result.rerankerUsed).toBe(false);
    expect(rerankTransport).not.toHaveBeenCalled();
  });
});
