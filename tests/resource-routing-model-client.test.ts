import { describe, expect, it, vi } from "vitest";

import type { HttpTransport } from "../adapters/http-transport.js";
import {
  ResourceRoutingEmbeddingClient,
  ResourceRoutingRerankerClient,
} from "../routing/resource-routing-model-client.js";
import {
  cosineSimilarity,
  selectTopCosineCandidates,
} from "../routing/resource-routing-retrieval.js";

const embeddingConfig = {
  baseUrl: "http://127.0.0.1:18081",
  model: "bge-m3",
  apiKey: "embed-key",
  headers: { "X-Tenant": "main" },
  timeoutMs: 3_000,
  dimensions: 3,
};

const rerankerConfig = {
  baseUrl: "http://127.0.0.1:18080/v1",
  model: "bge-reranker-v2-m3",
  apiKey: "",
  headers: {},
  timeoutMs: 3_000,
};

describe("ResourceRoutingEmbeddingClient", () => {
  it("calls the OpenAI-compatible embeddings endpoint and restores index order", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const transport: HttpTransport = vi.fn(async (url, init) => {
      capturedUrl = url;
      capturedInit = init;
      return new Response(JSON.stringify({
        data: [
          { index: 1, embedding: [0, 1, 0] },
          { index: 0, embedding: [1, 0, 0] },
        ],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });

    const vectors = await new ResourceRoutingEmbeddingClient(embeddingConfig, { transport })
      .embed(["alpha", "beta"]);

    expect(capturedUrl).toBe("http://127.0.0.1:18081/v1/embeddings");
    const headers = new Headers(capturedInit?.headers);
    expect(headers.get("authorization")).toBe("Bearer embed-key");
    expect(headers.get("x-tenant")).toBe("main");
    expect(JSON.parse(String(capturedInit?.body))).toEqual({
      model: "bge-m3",
      input: ["alpha", "beta"],
      encoding_format: "float",
    });
    expect(vectors).toEqual([
      [1, 0, 0],
      [0, 1, 0],
    ]);
  });

  it("fails closed on dimension mismatches, duplicate indexes and malformed JSON", async () => {
    const dimensionTransport: HttpTransport = vi.fn(async () => new Response(JSON.stringify({
      data: [{ index: 0, embedding: [1, 0] }],
    }), { status: 200 }));
    await expect(new ResourceRoutingEmbeddingClient(embeddingConfig, { transport: dimensionTransport })
      .embed(["alpha"]))
      .rejects.toThrow(/exactly 3 dimensions/);

    const duplicateTransport: HttpTransport = vi.fn(async () => new Response(JSON.stringify({
      data: [
        { index: 0, embedding: [1, 0, 0] },
        { index: 0, embedding: [0, 1, 0] },
      ],
    }), { status: 200 }));
    await expect(new ResourceRoutingEmbeddingClient(embeddingConfig, { transport: duplicateTransport })
      .embed(["alpha", "beta"]))
      .rejects.toThrow(/duplicate index 0/);

    const malformedTransport: HttpTransport = vi.fn(async () => new Response("not-json", { status: 200 }));
    await expect(new ResourceRoutingEmbeddingClient(embeddingConfig, { transport: malformedTransport })
      .embed(["alpha"]))
      .rejects.toThrow(/malformed JSON/);
  });

  it("preserves an explicit Authorization header instead of overwriting it with apiKey", async () => {
    const transport: HttpTransport = vi.fn(async (_url, init) => {
      expect(new Headers(init.headers).get("authorization")).toBe("Custom token");
      return new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0, 0] }] }), {
        status: 200,
      });
    });
    await new ResourceRoutingEmbeddingClient({
      ...embeddingConfig,
      headers: { Authorization: "Custom token" },
    }, { transport }).embed(["alpha"]);
  });
});

describe("ResourceRoutingRerankerClient", () => {
  it("uses /v1/rerank and accepts the results/relevance_score response shape", async () => {
    let capturedUrl = "";
    const transport: HttpTransport = vi.fn(async (url, init) => {
      capturedUrl = url;
      expect(JSON.parse(String(init.body))).toEqual({
        model: "bge-reranker-v2-m3",
        query: "security review",
        documents: ["general security", "security audit report"],
        top_n: 2,
      });
      return new Response(JSON.stringify({
        results: [
          { index: 0, relevance_score: 0.31 },
          { index: 1, relevance_score: 0.91 },
        ],
      }), { status: 200 });
    });

    const results = await new ResourceRoutingRerankerClient(rerankerConfig, { transport })
      .rerank("security review", ["general security", "security audit report"]);

    expect(capturedUrl).toBe("http://127.0.0.1:18080/v1/rerank");
    expect(results).toEqual([
      { index: 1, score: 0.91 },
      { index: 0, score: 0.31 },
    ]);
  });

  it("accepts llama.cpp-style top-level arrays with score while still validating indexes", async () => {
    const transport: HttpTransport = vi.fn(async () => new Response(JSON.stringify([
      { index: 1, score: 0.7 },
      { index: 0, score: 0.2 },
    ]), { status: 200 }));
    await expect(new ResourceRoutingRerankerClient(rerankerConfig, { transport })
      .rerank("query", ["a", "b"]))
      .resolves.toEqual([
        { index: 1, score: 0.7 },
        { index: 0, score: 0.2 },
      ]);
  });

  it("fails closed on incomplete reranker output and HTTP errors", async () => {
    const incompleteTransport: HttpTransport = vi.fn(async () => new Response(JSON.stringify({
      results: [{ index: 0, relevance_score: 0.8 }],
    }), { status: 200 }));
    await expect(new ResourceRoutingRerankerClient(rerankerConfig, { transport: incompleteTransport })
      .rerank("query", ["a", "b"]))
      .rejects.toThrow(/exactly 2 results/);

    const httpTransport: HttpTransport = vi.fn(async () => new Response("model unavailable", { status: 503 }));
    await expect(new ResourceRoutingRerankerClient(rerankerConfig, { transport: httpTransport })
      .rerank("query", ["a"]))
      .rejects.toThrow(/HTTP 503: model unavailable/);
  });
});

describe("cosine retrieval", () => {
  it("computes cosine similarity without assuming pre-normalized vectors", () => {
    expect(cosineSimilarity([2, 0], [7, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 3])).toBeCloseTo(0);
    expect(cosineSimilarity([1, 0], [-4, 0])).toBeCloseTo(-1);
  });

  it("selects deterministic top-K candidates by cosine score and preserves paths", () => {
    const candidates = selectTopCosineCandidates([1, 0], [
      { key: "docs", path: "docs", routingText: "Documents", embedding: [0.8, 0.2] },
      { key: "security-audits", path: "security/audits", routingText: "Security audit reports", embedding: [0.99, 0.01] },
      { key: "media", path: "media", routingText: "Media", embedding: [0, 1] },
    ], 2);
    expect(candidates.map(({ key }) => key)).toEqual(["security-audits", "docs"]);
    expect(candidates[0]?.path).toBe("security/audits");
  });

  it("rejects zero vectors and dimension mismatches", () => {
    expect(() => cosineSimilarity([0, 0], [1, 0])).toThrow(/non-zero vectors/);
    expect(() => cosineSimilarity([1, 0], [1, 0, 0])).toThrow(/dimensions differ/);
  });
});
