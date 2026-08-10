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

function taxonomy() {
  return parseResourceTaxonomy({
    schemaVersion: 1,
    categories: {
      inbox: { segment: "__INBOX__", description: "Unclassified resources." },
      alpha: { segment: "alpha", description: "Alpha project materials." },
      beta: { segment: "beta", description: "Beta project materials." },
      gamma: { segment: "gamma", description: "Gamma project materials." },
    },
  });
}

const embeddings = new Map([
  ["inbox", [0, 1]],
  ["alpha", [1, 0]],
  ["beta", [0.99, 0.1]],
  ["gamma", [0.98, 0.2]],
]);

describe("resource routing topK", () => {
  it("passes the configured cosine topK candidate set to the conditional reranker", async () => {
    const cfg = parseResourceRoutingConfig({
      enabled: true,
      embedding: { dimensions: 2 },
      retrieval: {
        topK: 3,
        minScore: -1,
        rerankBelowMargin: 2,
      },
    });
    const embeddingTransport: ResourceRoutingHttpTransport = async () => jsonResponse({
      data: [{ index: 0, embedding: [1, 0] }],
    });
    const rerankTransport: ResourceRoutingHttpTransport = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init.body));
      expect(body.documents).toEqual([
        "Alpha project materials.",
        "Beta project materials.",
        "Gamma project materials.",
      ]);
      expect(body.top_n).toBe(3);
      return jsonResponse([
        { index: 2, score: 0.95 },
        { index: 1, score: 0.7 },
        { index: 0, score: 0.6 },
      ]);
    });

    const result = await decideAutomaticResourceRoute({
      semanticInput: "Gamma project release and maintenance notes.",
      config: cfg,
      state: { taxonomy: taxonomy(), embeddings },
      embedder: new ResourceEmbeddingClient(cfg.embedding, embeddingTransport),
      reranker: new ResourceRerankerClient(cfg.reranker, rerankTransport),
    });

    expect(rerankTransport).toHaveBeenCalledOnce();
    expect(result.embeddingTop.map((candidate) => candidate.key)).toEqual(["alpha", "beta", "gamma"]);
    expect(result.categoryKey).toBe("gamma");
    expect(result.rerankerUsed).toBe(true);
  });

  it("never reranks when topK=1 because there is no competing candidate", async () => {
    const cfg = parseResourceRoutingConfig({
      enabled: true,
      embedding: { dimensions: 2 },
      retrieval: {
        topK: 1,
        minScore: -1,
        rerankBelowMargin: 2,
      },
    });
    const embeddingTransport: ResourceRoutingHttpTransport = async () => jsonResponse({
      data: [{ index: 0, embedding: [1, 0] }],
    });
    const rerankTransport: ResourceRoutingHttpTransport = vi.fn(async () => {
      throw new Error("reranker must not be called for topK=1");
    });

    const result = await decideAutomaticResourceRoute({
      semanticInput: "Alpha project notes.",
      config: cfg,
      state: { taxonomy: taxonomy(), embeddings },
      embedder: new ResourceEmbeddingClient(cfg.embedding, embeddingTransport),
      reranker: new ResourceRerankerClient(cfg.reranker, rerankTransport),
    });

    expect(result.embeddingTop.map((candidate) => candidate.key)).toEqual(["alpha"]);
    expect(result.categoryKey).toBe("alpha");
    expect(result.rerankerUsed).toBe(false);
    expect(rerankTransport).not.toHaveBeenCalled();
  });
});
