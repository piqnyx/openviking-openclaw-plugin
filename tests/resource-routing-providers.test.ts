import { describe, expect, it, vi } from "vitest";

import { parseResourceRoutingConfig } from "../resource-routing/config.js";
import {
  createResourceRoutingEmbeddingClient,
  createResourceRoutingRerankerClient,
} from "../resource-routing/providers.js";

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("resource routing embedding client", () => {
  it("uses the OpenAI-compatible llama-server embeddings contract and restores indexed order", async () => {
    const cfg = parseResourceRoutingConfig({
      embedding: {
        baseUrl: "http://127.0.0.1:18081",
        endpoint: "/v1/embeddings",
        apiKey: "secret",
        headers: { "X-Test": "yes" },
        model: "bge-m3",
        dimensions: 3,
      },
    });
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer secret");
      expect(new Headers(init?.headers).get("X-Test")).toBe("yes");
      expect(JSON.parse(String(init?.body))).toEqual({
        model: "bge-m3",
        input: ["first", "second"],
        encoding_format: "float",
      });
      return jsonResponse({
        data: [
          { index: 1, embedding: [0, 1, 0] },
          { index: 0, embedding: [1, 0, 0] },
        ],
      });
    });
    const client = createResourceRoutingEmbeddingClient(cfg.embedding, fetchImpl as typeof fetch);
    await expect(client.embed(["first", "second"])).resolves.toEqual([
      [1, 0, 0],
      [0, 1, 0],
    ]);
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:18081/v1/embeddings",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("accepts response order when llama-server omits explicit indices", async () => {
    const cfg = parseResourceRoutingConfig({ embedding: { dimensions: 2 } });
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ data: [{ embedding: [1, 0] }, { embedding: [0, 1] }] }),
    );
    const client = createResourceRoutingEmbeddingClient(cfg.embedding, fetchImpl as typeof fetch);
    await expect(client.embed(["a", "b"])).resolves.toEqual([
      [1, 0],
      [0, 1],
    ]);
  });

  it("fails closed on dimensions mismatch, malformed indices, or provider errors", async () => {
    const cfg = parseResourceRoutingConfig({ embedding: { dimensions: 3 } });
    const wrongDimensions = createResourceRoutingEmbeddingClient(
      cfg.embedding,
      vi.fn(async () => jsonResponse({ data: [{ embedding: [1, 2] }] })) as typeof fetch,
    );
    await expect(wrongDimensions.embed(["query"])).rejects.toThrow(/exactly 3 dimensions/);

    const badIndex = createResourceRoutingEmbeddingClient(
      cfg.embedding,
      vi.fn(async () => jsonResponse({ data: [{ index: 8, embedding: [1, 2, 3] }] })) as typeof fetch,
    );
    await expect(badIndex.embed(["query"])).rejects.toThrow(/invalid index/);

    const providerError = createResourceRoutingEmbeddingClient(
      cfg.embedding,
      vi.fn(async () => jsonResponse({ error: { message: "model unavailable" } }, 503)) as typeof fetch,
    );
    await expect(providerError.embed(["query"])).rejects.toThrow(/HTTP 503: model unavailable/);
  });
});

describe("resource routing reranker client", () => {
  it("uses llama-server /v1/rerank and accepts unsorted result order", async () => {
    const cfg = parseResourceRoutingConfig({
      reranker: {
        baseUrl: "http://127.0.0.1:18080",
        endpoint: "/v1/rerank",
        model: "bge-reranker-v2-m3",
      },
    });
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({
        model: "bge-reranker-v2-m3",
        query: "security audit",
        documents: ["general security", "security audit reports"],
        top_n: 2,
      });
      return jsonResponse({
        results: [
          { index: 0, relevance_score: 0.2 },
          { index: 1, relevance_score: 0.9 },
        ],
      });
    });
    const client = createResourceRoutingRerankerClient(cfg.reranker, fetchImpl as typeof fetch);
    await expect(
      client.rerank("security audit", ["general security", "security audit reports"]),
    ).resolves.toEqual([
      { index: 0, score: 0.2 },
      { index: 1, score: 0.9 },
    ]);
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:18080/v1/rerank",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("fails closed on missing, duplicate, or non-finite reranker results", async () => {
    const cfg = parseResourceRoutingConfig(undefined);
    const missing = createResourceRoutingRerankerClient(
      cfg.reranker,
      vi.fn(async () => jsonResponse({ results: [{ index: 0, relevance_score: 0.5 }] })) as typeof fetch,
    );
    await expect(missing.rerank("q", ["a", "b"])).rejects.toThrow(/1 results for 2 documents/);

    const duplicate = createResourceRoutingRerankerClient(
      cfg.reranker,
      vi.fn(async () =>
        jsonResponse({
          results: [
            { index: 0, relevance_score: 0.5 },
            { index: 0, relevance_score: 0.6 },
          ],
        }),
      ) as typeof fetch,
    );
    await expect(duplicate.rerank("q", ["a", "b"])).rejects.toThrow(/invalid index/);

    const nonFinite = createResourceRoutingRerankerClient(
      cfg.reranker,
      vi.fn(async () =>
        jsonResponse({
          results: [
            { index: 0, relevance_score: null },
            { index: 1, relevance_score: 0.6 },
          ],
        }),
      ) as typeof fetch,
    );
    await expect(nonFinite.rerank("q", ["a", "b"])).rejects.toThrow(/invalid relevance_score/);
  });
});
