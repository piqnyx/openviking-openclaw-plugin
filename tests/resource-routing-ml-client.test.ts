import { describe, expect, it, vi } from "vitest";

import { parseResourceRoutingConfig } from "../resource-routing/config.js";
import {
  ResourceEmbeddingClient,
  ResourceRerankerClient,
  type ResourceRoutingHttpTransport,
} from "../resource-routing/ml-client.js";
import {
  renderResourceSemanticInput,
  requireResourceSemanticSummary,
} from "../resource-routing/semantic-input.js";

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("resource routing semantic input", () => {
  it("keeps summary-only as the default semantic signal", () => {
    const cfg = parseResourceRoutingConfig(undefined);
    const rendered = renderResourceSemanticInput(cfg.semanticInputTemplate, {
      summary: "A security audit report describing OpenClaw permission findings.",
      filename: "network-linux-final.md",
      sourceKind: "local-file",
    });
    expect(rendered).toBe("A security audit report describing OpenClaw permission findings.");
  });

  it("supports explicitly configured future metadata fields", () => {
    expect(renderResourceSemanticInput("{{summary}}\nSource: {{sourceKind}}", {
      summary: "Reference documentation for an HTTP API.",
      sourceKind: "web",
    })).toBe("Reference documentation for an HTTP API.\nSource: web");
  });

  it("returns an actionable error when automatic routing has no summary", () => {
    expect(() => requireResourceSemanticSummary("  ")).toThrow(/retry add_resource with that summary/);
  });
});

describe("ResourceEmbeddingClient", () => {
  it("uses the configured OpenAI-compatible endpoint and restores input order by index", async () => {
    const cfg = parseResourceRoutingConfig({
      embedding: {
        baseUrl: "http://embed.test:18081/",
        endpointPath: "/v1/embeddings",
        apiKey: "embed-secret",
        headers: { "X-Test": "yes" },
        model: "custom-embed",
        dimensions: 3,
      },
    });
    const transport: ResourceRoutingHttpTransport = vi.fn(async (url, init) => {
      expect(url).toBe("http://embed.test:18081/v1/embeddings");
      const headers = new Headers(init.headers);
      expect(headers.get("Authorization")).toBe("Bearer embed-secret");
      expect(headers.get("X-Test")).toBe("yes");
      expect(JSON.parse(String(init.body))).toEqual({
        model: "custom-embed",
        input: ["first", "second"],
      });
      return jsonResponse({
        data: [
          { index: 1, embedding: [4, 5, 6] },
          { index: 0, embedding: [1, 2, 3] },
        ],
      });
    });

    const vectors = await new ResourceEmbeddingClient(cfg.embedding, transport).embed(["first", "second"]);
    expect(vectors).toEqual([[1, 2, 3], [4, 5, 6]]);
  });

  it("fails closed on dimension mismatch and duplicate indices", async () => {
    const cfg = parseResourceRoutingConfig({ embedding: { dimensions: 3 } });
    const wrongDimensions: ResourceRoutingHttpTransport = async () => jsonResponse({
      data: [{ index: 0, embedding: [1, 2] }],
    });
    await expect(new ResourceEmbeddingClient(cfg.embedding, wrongDimensions).embed(["x"]))
      .rejects.toThrow(/expected 3/);

    const duplicateIndices: ResourceRoutingHttpTransport = async () => jsonResponse({
      data: [
        { index: 0, embedding: [1, 2, 3] },
        { index: 0, embedding: [4, 5, 6] },
      ],
    });
    await expect(new ResourceEmbeddingClient(cfg.embedding, duplicateIndices).embed(["x", "y"]))
      .rejects.toThrow(/duplicate index/);
  });

  it("surfaces HTTP and malformed-response failures instead of fabricating vectors", async () => {
    const cfg = parseResourceRoutingConfig({ embedding: { dimensions: 3 } });
    const httpFailure: ResourceRoutingHttpTransport = async () => new Response("model unavailable", { status: 503 });
    await expect(new ResourceEmbeddingClient(cfg.embedding, httpFailure).embed(["x"]))
      .rejects.toThrow(/HTTP 503/);

    const malformed: ResourceRoutingHttpTransport = async () => new Response("not-json", { status: 200 });
    await expect(new ResourceEmbeddingClient(cfg.embedding, malformed).embed(["x"]))
      .rejects.toThrow(/malformed JSON/);
  });
});

describe("ResourceRerankerClient", () => {
  it("accepts llama.cpp array output and sorts results by score", async () => {
    const cfg = parseResourceRoutingConfig(undefined);
    const transport: ResourceRoutingHttpTransport = vi.fn(async (url, init) => {
      expect(url).toBe("http://127.0.0.1:18080/v1/rerank");
      expect(JSON.parse(String(init.body))).toEqual({
        model: "bge-reranker-v2-m3",
        query: "security audit",
        documents: ["general security", "security audit reports"],
        top_n: 2,
      });
      return jsonResponse([
        { index: 0, score: 0.2 },
        { index: 1, score: 0.9 },
      ]);
    });
    const result = await new ResourceRerankerClient(cfg.reranker, transport).rerank(
      "security audit",
      ["general security", "security audit reports"],
    );
    expect(result).toEqual([
      { index: 1, score: 0.9 },
      { index: 0, score: 0.2 },
    ]);
  });

  it("also accepts Jina-style results/relevance_score for configurable compatible services", async () => {
    const cfg = parseResourceRoutingConfig(undefined);
    const transport: ResourceRoutingHttpTransport = async () => jsonResponse({
      results: [
        { index: 1, relevance_score: 0.8 },
        { index: 0, relevance_score: 0.3 },
      ],
    });
    const result = await new ResourceRerankerClient(cfg.reranker, transport).rerank("q", ["a", "b"]);
    expect(result[0]).toEqual({ index: 1, score: 0.8 });
  });

  it("fails closed on incomplete, duplicate or non-finite reranker results", async () => {
    const cfg = parseResourceRoutingConfig(undefined);
    const incomplete: ResourceRoutingHttpTransport = async () => jsonResponse([{ index: 0, score: 1 }]);
    await expect(new ResourceRerankerClient(cfg.reranker, incomplete).rerank("q", ["a", "b"]))
      .rejects.toThrow(/exactly 2/);

    const duplicate: ResourceRoutingHttpTransport = async () => jsonResponse([
      { index: 0, score: 1 },
      { index: 0, score: 0.5 },
    ]);
    await expect(new ResourceRerankerClient(cfg.reranker, duplicate).rerank("q", ["a", "b"]))
      .rejects.toThrow(/duplicate index/);

    const nonFinite: ResourceRoutingHttpTransport = async () => jsonResponse([
      { index: 0, score: null },
      { index: 1, score: 0.5 },
    ]);
    await expect(new ResourceRerankerClient(cfg.reranker, nonFinite).rerank("q", ["a", "b"]))
      .rejects.toThrow(/finite number/);
  });
});
