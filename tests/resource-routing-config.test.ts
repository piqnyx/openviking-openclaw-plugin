import { describe, expect, it } from "vitest";

import {
  parseResourceRoutingConfig,
  resolveAgentResourceRoutingPaths,
} from "../resource-routing/config.js";

describe("resource routing config", () => {
  it("uses tested local-model defaults and keeps automatic routing disabled until configured", () => {
    const cfg = parseResourceRoutingConfig(undefined);

    expect(cfg.enabled).toBe(false);
    expect(cfg.taxonomyFile).toBe("~/.openclaw/{agentId}.yaml");
    expect(cfg.embedding).toMatchObject({
      baseUrl: "http://127.0.0.1:18081",
      endpointPath: "/v1/embeddings",
      model: "bge-m3",
      dimensions: 1024,
    });
    expect(cfg.reranker).toMatchObject({
      baseUrl: "http://127.0.0.1:18080",
      endpointPath: "/v1/rerank",
      model: "bge-reranker-v2-m3",
    });
    expect(cfg.retrieval).toEqual({
      topK: 2,
      minScore: 0.64,
      rerankBelowMargin: 0.06,
    });
    expect(cfg.semanticInputTemplate).toBe("{{summary}}");
    expect(cfg.fallbackCategory).toBe("inbox");
    expect(cfg.failurePolicy).toBe("error");
  });

  it("accepts custom model endpoints, auth material, thresholds and semantic template", () => {
    const cfg = parseResourceRoutingConfig({
      enabled: true,
      taxonomyFile: "/srv/openviking/taxonomies/{agentId}.yaml",
      cacheFile: "/srv/openviking/cache/{agentId}.json",
      auditFile: "/srv/openviking/audit/{agentId}.jsonl",
      fallbackCategory: "unclassified",
      semanticInputTemplate: "{{summary}}\nSource kind: {{sourceKind}}",
      embedding: {
        baseUrl: "https://embed.example.test/api",
        endpointPath: "/v1/embeddings",
        apiKey: "secret-embed",
        headers: { "X-Tenant": "alpha" },
        model: "custom-embed",
        timeoutMs: 9000,
        dimensions: 1536,
      },
      reranker: {
        baseUrl: "https://rerank.example.test",
        endpointPath: "/v1/rerank",
        apiKey: "secret-rerank",
        model: "custom-reranker",
        timeoutMs: 11000,
      },
      retrieval: {
        topK: 4,
        minScore: 0.51,
        rerankBelowMargin: 0.08,
      },
      audit: {
        enabled: true,
        includeSummaryPreview: true,
        summaryPreviewChars: 180,
      },
    });

    expect(cfg.enabled).toBe(true);
    expect(cfg.embedding.model).toBe("custom-embed");
    expect(cfg.embedding.dimensions).toBe(1536);
    expect(cfg.embedding.headers).toEqual({ "X-Tenant": "alpha" });
    expect(cfg.reranker.model).toBe("custom-reranker");
    expect(cfg.retrieval.topK).toBe(4);
    expect(cfg.fallbackCategory).toBe("unclassified");
    expect(cfg.semanticInputTemplate).toContain("{{sourceKind}}");
  });

  it("resolves isolated per-agent paths from templates", () => {
    const cfg = parseResourceRoutingConfig(undefined);
    const paths = resolveAgentResourceRoutingPaths(cfg, "igor");

    expect(paths.taxonomyFile).toMatch(/\/\.openclaw\/igor\.yaml$/);
    expect(paths.cacheFile).toMatch(/\/\.openclaw\/cache\/openviking-resource-routing\/igor\.json$/);
    expect(paths.auditFile).toMatch(/\/\.openclaw\/logs\/openviking-resource-routing\/igor\.jsonl$/);
  });

  it.each(["/tmp/taxonomy.yaml", "~/.openclaw/main.yaml"])(
    "rejects a shared taxonomy template without {agentId}: %s",
    (taxonomyFile) => {
      expect(() => parseResourceRoutingConfig({ taxonomyFile })).toThrow(/must contain \{agentId\}/);
    },
  );

  it("requires summary to remain part of the semantic input", () => {
    expect(() => parseResourceRoutingConfig({ semanticInputTemplate: "{{filename}}" })).toThrow(/must include \{\{summary\}\}/);
    expect(() => parseResourceRoutingConfig({ semanticInputTemplate: "{{summary}} {{madeUpField}}" })).toThrow(/unknown fields/);
  });

  it("rejects masking infrastructure failures through a configurable fallback policy", () => {
    expect(() => parseResourceRoutingConfig({ failurePolicy: "inbox" })).toThrow(/supports only "error"/);
  });
});
