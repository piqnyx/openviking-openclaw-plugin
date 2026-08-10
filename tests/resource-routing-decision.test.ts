import { describe, expect, it, vi } from "vitest";

import { parseResourceRoutingConfig } from "../resource-routing/config.js";
import { decideAutomaticResourceRoute, cosineSimilarity } from "../resource-routing/decision.js";
import {
  ResourceEmbeddingClient,
  ResourceRerankerClient,
  type ResourceRoutingHttpTransport,
} from "../resource-routing/ml-client.js";
import { parseResourceTaxonomy } from "../resource-routing/taxonomy.js";

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function taxonomy() {
  return parseResourceTaxonomy({
    schemaVersion: 1,
    categories: {
      inbox: { segment: "__INBOX__", description: "Unclassified resources." },
      security: { segment: "security", description: "General security material." },
      "security-audits": { segment: "audits", description: "Security audit reports and findings." },
    },
  });
}

function clients(queryEmbedding: number[], rerankResponse: unknown = [
  { index: 0, score: 0.7 },
  { index: 1, score: 0.6 },
]) {
  const cfg = parseResourceRoutingConfig({
    enabled: true,
    embedding: { dimensions: queryEmbedding.length },
  });
  const embedTransport: ResourceRoutingHttpTransport = async () => jsonResponse({
    data: [{ index: 0, embedding: queryEmbedding }],
  });
  const rerankTransport: ResourceRoutingHttpTransport = vi.fn(async () => jsonResponse(rerankResponse));
  return {
    cfg,
    embedder: new ResourceEmbeddingClient(cfg.embedding, embedTransport),
    reranker: new ResourceRerankerClient(cfg.reranker, rerankTransport),
    rerankTransport,
  };
}

describe("cosineSimilarity", () => {
  it("computes cosine without assuming vectors are pre-normalized", () => {
    expect(cosineSimilarity([2, 0], [3, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1);
  });

  it("rejects dimension mismatch and zero vectors", () => {
    expect(() => cosineSimilarity([1], [1, 2])).toThrow(/dimension mismatch/);
    expect(() => cosineSimilarity([0, 0], [1, 0])).toThrow(/zero or invalid norm/);
  });
});

describe("automatic resource routing decision", () => {
  it("accepts a confident embedding top1 without reranker", async () => {
    const { cfg, embedder, reranker, rerankTransport } = clients([1, 0]);
    const result = await decideAutomaticResourceRoute({
      semanticInput: "Security audit report.",
      config: cfg,
      state: {
        taxonomy: taxonomy(),
        embeddings: new Map([
          ["inbox", [0, 1]],
          ["security", [0.4, 0.916515]],
          ["security-audits", [1, 0]],
        ]),
      },
      embedder,
      reranker,
    });

    expect(result.categoryKey).toBe("security-audits");
    expect(result.fallback).toBe(false);
    expect(result.rerankerUsed).toBe(false);
    expect(rerankTransport).not.toHaveBeenCalled();
  });

  it("uses configured fallback when embedding confidence is below minScore", async () => {
    const { cfg, embedder, reranker, rerankTransport } = clients([1, 0]);
    const result = await decideAutomaticResourceRoute({
      semanticInput: "Ambiguous material.",
      config: cfg,
      state: {
        taxonomy: taxonomy(),
        embeddings: new Map([
          ["inbox", [0, 1]],
          ["security", [0.2, 0.9799]],
          ["security-audits", [0.3, 0.9539]],
        ]),
      },
      embedder,
      reranker,
    });

    expect(result.categoryKey).toBe("inbox");
    expect(result.categoryUri).toBe("viking://resources/__INBOX__");
    expect(result.fallback).toBe(true);
    expect(result.fallbackReason).toBe("below-min-score");
    expect(rerankTransport).not.toHaveBeenCalled();
  });

  it("reranks only close top candidates and trusts only their indices", async () => {
    const { cfg, embedder, reranker, rerankTransport } = clients(
      [1, 0],
      [
        { index: 1, score: 0.91 },
        { index: 0, score: 0.52 },
      ],
    );
    const result = await decideAutomaticResourceRoute({
      semanticInput: "Detailed security audit findings.",
      config: cfg,
      state: {
        taxonomy: taxonomy(),
        embeddings: new Map([
          ["inbox", [0, 1]],
          ["security", [0.82, 0.57236]],
          ["security-audits", [0.84, 0.54259]],
        ]),
      },
      embedder,
      reranker,
    });

    expect(rerankTransport).toHaveBeenCalledOnce();
    expect(result.rerankerUsed).toBe(true);
    expect(result.categoryKey).toBe("security");
    expect(result.rerankerScores?.map((entry) => entry.key)).toEqual(["security", "security-audits"]);
  });

  it("propagates required reranker infrastructure failure instead of falling back", async () => {
    const cfg = parseResourceRoutingConfig({ enabled: true, embedding: { dimensions: 2 } });
    const embedTransport: ResourceRoutingHttpTransport = async () => jsonResponse({
      data: [{ index: 0, embedding: [1, 0] }],
    });
    const rerankTransport: ResourceRoutingHttpTransport = async () => new Response("down", { status: 503 });

    await expect(decideAutomaticResourceRoute({
      semanticInput: "Detailed security audit findings.",
      config: cfg,
      state: {
        taxonomy: taxonomy(),
        embeddings: new Map([
          ["inbox", [0, 1]],
          ["security", [0.82, 0.57236]],
          ["security-audits", [0.84, 0.54259]],
        ]),
      },
      embedder: new ResourceEmbeddingClient(cfg.embedding, embedTransport),
      reranker: new ResourceRerankerClient(cfg.reranker, rerankTransport),
    })).rejects.toThrow(/HTTP 503/);
  });
});
