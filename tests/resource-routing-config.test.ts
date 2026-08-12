import { describe, expect, it, vi } from "vitest";

import {
  parseResourceRoutingConfig,
  RESOURCE_ROUTING_DEFAULTS,
} from "../routing/resource-routing-config.js";


describe("resource routing config", () => {
  it("uses the tested local BGE defaults while remaining disabled and language-neutral by default", () => {
    const cfg = parseResourceRoutingConfig(undefined);

    expect(cfg.enabled).toBe(false);
    expect(cfg.taxonomyFile).toBe("~/.openclaw/{agentId}.yaml");
    expect(cfg.cacheFile).toContain("{agentId}");
    expect(cfg.semanticInputTemplate).toBe("{{summary}}");
    expect(cfg.summaryLanguage).toBe("any");
    expect(cfg.embedding).toMatchObject({
      baseUrl: "http://127.0.0.1:18081",
      model: "bge-m3",
      apiKey: "",
      timeoutMs: 3000,
      dimensions: 1024,
    });
    expect(cfg.reranker).toMatchObject({
      baseUrl: "http://127.0.0.1:18080",
      model: "bge-reranker-v2-m3",
      apiKey: "",
      timeoutMs: 3000,
    });
    expect(cfg.retrieval).toEqual({
      topK: 2,
      minScore: 0.64,
      rerankBelowMargin: 0.06,
    });
    expect(cfg.fallbackCategory).toBe("inbox");
    expect(cfg.failurePolicy).toBe("error");
    expect(cfg.audit.enabled).toBe(true);
  });

  it("accepts custom model endpoints, credentials, headers, summary language and thresholds", () => {
    vi.stubEnv("ROUTER_EMBED_KEY", "embed-secret");
    vi.stubEnv("ROUTER_RERANK_KEY", "rerank-secret");
    vi.stubEnv("ROUTER_TENANT", "tenant-a");

    try {
      const cfg = parseResourceRoutingConfig({
        enabled: true,
        taxonomyFile: "/srv/openclaw/taxonomy/{agentId}.yaml",
        cacheFile: "/srv/openclaw/cache/{agentId}.json",
        semanticInputTemplate: "{{summary}}\nSource type: {{sourceKind}}",
        summaryLanguage: "ru",
        embedding: {
          baseUrl: "https://embedding.example.test/v1/",
          model: "custom-embed",
          apiKey: "${ROUTER_EMBED_KEY}",
          headers: { "X-Tenant": "${ROUTER_TENANT}" },
          timeoutMs: 4500,
          dimensions: 1536,
        },
        reranker: {
          baseUrl: "https://rerank.example.test/v1",
          model: "custom-reranker",
          apiKey: "${ROUTER_RERANK_KEY}",
          headers: { "X-Mode": "routing" },
          timeoutMs: 6500,
        },
        retrieval: {
          topK: 4,
          minScore: 0.52,
          rerankBelowMargin: 0.1,
        },
        fallbackCategory: "needs_review",
        failurePolicy: "error",
        audit: {
          enabled: false,
          file: "/srv/openclaw/audit/{agentId}.jsonl",
          summaryPreviewChars: 512,
        },
      });

      expect(cfg.summaryLanguage).toBe("ru");
      expect(cfg.embedding).toEqual({
        baseUrl: "https://embedding.example.test/v1",
        model: "custom-embed",
        apiKey: "embed-secret",
        headers: { "X-Tenant": "tenant-a" },
        timeoutMs: 4500,
        dimensions: 1536,
      });
      expect(cfg.reranker).toEqual({
        baseUrl: "https://rerank.example.test/v1",
        model: "custom-reranker",
        apiKey: "rerank-secret",
        headers: { "X-Mode": "routing" },
        timeoutMs: 6500,
      });
      expect(cfg.retrieval).toEqual({
        topK: 4,
        minScore: 0.52,
        rerankBelowMargin: 0.1,
      });
      expect(cfg.fallbackCategory).toBe("needs_review");
      expect(cfg.audit).toEqual({
        enabled: false,
        file: "/srv/openclaw/audit/{agentId}.jsonl",
        summaryPreviewChars: 512,
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("validates the optional summary language policy", () => {
    expect(parseResourceRoutingConfig({ summaryLanguage: "any" }).summaryLanguage).toBe("any");
    expect(parseResourceRoutingConfig({ summaryLanguage: "ru" }).summaryLanguage).toBe("ru");
    expect(() => parseResourceRoutingConfig({ summaryLanguage: "en" }))
      .toThrow(/summaryLanguage must be "any" or "ru"/);
  });

  it("requires every per-agent file template to contain {agentId}", () => {
    expect(() => parseResourceRoutingConfig({ taxonomyFile: "/tmp/shared.yaml" }))
      .toThrow(/must contain \{agentId\}/);
    expect(() => parseResourceRoutingConfig({ cacheFile: "/tmp/shared.json" }))
      .toThrow(/must contain \{agentId\}/);
    expect(() => parseResourceRoutingConfig({ audit: { file: "/tmp/shared.jsonl" } }))
      .toThrow(/must contain \{agentId\}/);
  });

  it("rejects relative file templates", () => {
    expect(() => parseResourceRoutingConfig({ taxonomyFile: "taxonomies/{agentId}.yaml" }))
      .toThrow(/absolute path/);
  });

  it("requires summary to remain part of customized semantic model input", () => {
    expect(() => parseResourceRoutingConfig({ semanticInputTemplate: "{{filename}}" }))
      .toThrow(/must include \{\{summary\}\}/);
  });

  it("rejects unknown semantic input placeholders", () => {
    expect(() => parseResourceRoutingConfig({
      semanticInputTemplate: "{{summary}} {{magicMetadata}}",
    })).toThrow(/unknown placeholders: magicMetadata/);
  });

  it("rejects unknown keys at every nested config boundary", () => {
    expect(() => parseResourceRoutingConfig({ magic: true })).toThrow(/unknown keys: magic/);
    expect(() => parseResourceRoutingConfig({ embedding: { magic: true } }))
      .toThrow(/embedding has unknown keys: magic/);
    expect(() => parseResourceRoutingConfig({ reranker: { magic: true } }))
      .toThrow(/reranker has unknown keys: magic/);
    expect(() => parseResourceRoutingConfig({ retrieval: { magic: true } }))
      .toThrow(/retrieval has unknown keys: magic/);
    expect(() => parseResourceRoutingConfig({ audit: { magic: true } }))
      .toThrow(/audit has unknown keys: magic/);
  });

  it("rejects invalid routing thresholds and dimensions instead of silently clamping them", () => {
    expect(() => parseResourceRoutingConfig({ embedding: { dimensions: 0 } }))
      .toThrow(/dimensions must be an integer/);
    expect(() => parseResourceRoutingConfig({ retrieval: { topK: 0 } }))
      .toThrow(/topK must be an integer/);
    expect(() => parseResourceRoutingConfig({ retrieval: { minScore: 2 } }))
      .toThrow(/minScore must be between/);
    expect(() => parseResourceRoutingConfig({ retrieval: { rerankBelowMargin: -0.1 } }))
      .toThrow(/rerankBelowMargin must be between/);
  });

  it("keeps infrastructure failure policy fail-closed", () => {
    expect(parseResourceRoutingConfig({ failurePolicy: "error" }).failurePolicy).toBe("error");
    expect(() => parseResourceRoutingConfig({ failurePolicy: "inbox" }))
      .toThrow(/supports only "error"/);
  });

  it("rejects malformed endpoint URLs and missing environment secrets", () => {
    expect(() => parseResourceRoutingConfig({ embedding: { baseUrl: "file:///tmp/model" } }))
      .toThrow(/must use http or https/);
    expect(() => parseResourceRoutingConfig({ reranker: { apiKey: "${MISSING_ROUTER_KEY}" } }))
      .toThrow(/MISSING_ROUTER_KEY/);
  });

  it("exports defaults for manifest and documentation parity", () => {
    expect(RESOURCE_ROUTING_DEFAULTS).toMatchObject({
      embeddingBaseUrl: "http://127.0.0.1:18081",
      rerankerBaseUrl: "http://127.0.0.1:18080",
      topK: 2,
      minScore: 0.64,
      rerankBelowMargin: 0.06,
      fallbackCategory: "inbox",
      summaryLanguage: "any",
    });
  });
});
