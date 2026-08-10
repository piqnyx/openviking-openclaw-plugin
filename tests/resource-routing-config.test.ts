import { describe, expect, it } from "vitest";

import {
  parseResourceRoutingConfig,
  resolveAgentScopedResourceRoutingPath,
} from "../resource-routing/config.js";

describe("resource routing config", () => {
  it("uses the tested local BGE defaults while staying disabled by default", () => {
    const cfg = parseResourceRoutingConfig(undefined);
    expect(cfg.enabled).toBe(false);
    expect(cfg.taxonomyFileTemplate).toContain("{agentId}");
    expect(cfg.cacheFileTemplate).toContain("{agentId}");
    expect(cfg.semanticInputTemplate).toBe("{{summary}}");
    expect(cfg.fallbackCategory).toBe("inbox");
    expect(cfg.embedding).toMatchObject({
      baseUrl: "http://127.0.0.1:18081",
      endpoint: "/v1/embeddings",
      model: "bge-m3",
      dimensions: 1024,
      timeoutMs: 3000,
    });
    expect(cfg.reranker).toMatchObject({
      baseUrl: "http://127.0.0.1:18080",
      endpoint: "/v1/rerank",
      model: "bge-reranker-v2-m3",
      timeoutMs: 3000,
    });
    expect(cfg.retrieval).toEqual({
      topK: 2,
      minScore: 0.64,
      rerankBelowMargin: 0.06,
    });
  });

  it("accepts custom providers, credentials, headers, models, thresholds, and semantic metadata", () => {
    const cfg = parseResourceRoutingConfig({
      enabled: true,
      taxonomyFileTemplate: "/srv/taxonomies/{agentId}.yaml",
      cacheFileTemplate: "/srv/cache/{agentId}.json",
      semanticInputTemplate: "{{summary}}\nSource type: {{sourceKind}}",
      fallbackCategory: "review",
      embedding: {
        baseUrl: "https://embedding.example/v1/",
        endpoint: "/embeddings",
        apiKey: "embed-secret",
        headers: { "X-Tenant": "alpha" },
        model: "custom-embed",
        timeoutMs: 4500,
        dimensions: 768,
      },
      reranker: {
        baseUrl: "https://rerank.example/",
        endpoint: "/rerank",
        apiKey: "rerank-secret",
        headers: { "X-Tenant": "alpha" },
        model: "custom-reranker",
        timeoutMs: 5500,
      },
      retrieval: {
        topK: 4,
        minScore: 0.51,
        rerankBelowMargin: 0.12,
      },
    });
    expect(cfg.enabled).toBe(true);
    expect(cfg.embedding.baseUrl).toBe("https://embedding.example/v1");
    expect(cfg.embedding.dimensions).toBe(768);
    expect(cfg.reranker.baseUrl).toBe("https://rerank.example");
    expect(cfg.retrieval.topK).toBe(4);
    expect(cfg.semanticInputTemplate).toContain("{{sourceKind}}");
  });

  it("requires per-agent file templates", () => {
    expect(() =>
      parseResourceRoutingConfig({ taxonomyFileTemplate: "/tmp/shared.yaml" }),
    ).toThrow(/must contain \{agentId\}/);
    expect(() =>
      parseResourceRoutingConfig({ cacheFileTemplate: "/tmp/shared.json" }),
    ).toThrow(/must contain \{agentId\}/);
  });

  it("requires summary in semantic input and rejects unknown template fields", () => {
    expect(() =>
      parseResourceRoutingConfig({ semanticInputTemplate: "{{filename}}" }),
    ).toThrow(/must contain \{\{summary\}\}/);
    expect(() =>
      parseResourceRoutingConfig({ semanticInputTemplate: "{{summary}} {{magic}}" }),
    ).toThrow(/unknown fields: magic/);
  });

  it("rejects unknown resourceRouting keys and malformed provider endpoints", () => {
    expect(() => parseResourceRoutingConfig({ surprise: true })).toThrow(/unknown keys: surprise/);
    expect(() =>
      parseResourceRoutingConfig({ embedding: { endpoint: "v1/embeddings" } }),
    ).toThrow(/absolute HTTP path/);
  });

  it("resolves an agent-scoped path without permitting arbitrary agent ids", () => {
    expect(
      resolveAgentScopedResourceRoutingPath("/home/openclaw/.openclaw/{agentId}.yaml", "igor"),
    ).toBe("/home/openclaw/.openclaw/igor.yaml");
    expect(() =>
      resolveAgentScopedResourceRoutingPath("/tmp/{agentId}.yaml", "../main"),
    ).toThrow(/must match/);
  });
});
