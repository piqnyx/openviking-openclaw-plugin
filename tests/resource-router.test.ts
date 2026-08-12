import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { HttpTransport } from "../adapters/http-transport.js";
import { parseResourceRoutingConfig } from "../routing/resource-routing-config.js";
import {
  ResourceRoutingEmbeddingClient,
  ResourceRoutingRerankerClient,
} from "../routing/resource-routing-model-client.js";
import {
  buildResourceRoutingEmbeddingState,
  ResourceRouter,
} from "../routing/resource-router.js";
import { compileResourceTaxonomy } from "../routing/resource-taxonomy.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempConfig(overrides: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ov-resource-router-"));
  tempDirs.push(dir);
  return parseResourceRoutingConfig({
    enabled: true,
    taxonomyFile: join(dir, "{agentId}.yaml"),
    cacheFile: join(dir, "cache-{agentId}.json"),
    embedding: { dimensions: 2 },
    retrieval: { topK: 2, minScore: 0.64, rerankBelowMargin: 0.06 },
    fallbackCategory: "inbox",
    ...overrides,
  });
}

const taxonomy = compileResourceTaxonomy({
  schemaVersion: 1,
  fallback: "inbox",
  categories: {
    inbox: {
      segment: "__INBOX__",
      description: "Resources that cannot be confidently classified elsewhere.",
    },
    docs: {
      segment: "documents",
      description: "General documentation, guides, manuals and explanatory documents.",
    },
    security: {
      segment: "security",
      description: "General security material.",
      children: {
        security_audits: {
          segment: "audits",
          description: "Security audits, findings, review reports and remediation material.",
        },
      },
    },
  },
});

function embedded(key: string, path: string, embeddingText: string, embedding: number[]) {
  return { key, path, embeddingText, embedding };
}

function embeddingClientFor(vector: number[], transportOverride?: HttpTransport) {
  const transport: HttpTransport = transportOverride ?? vi.fn(async () => new Response(JSON.stringify({
    data: [{ index: 0, embedding: vector }],
  }), { status: 200 }));
  return new ResourceRoutingEmbeddingClient({
    baseUrl: "http://127.0.0.1:18081",
    model: "bge-m3",
    apiKey: "",
    headers: {},
    timeoutMs: 3_000,
    dimensions: 2,
  }, { transport });
}

function rerankerClient(transport: HttpTransport) {
  return new ResourceRoutingRerankerClient({
    baseUrl: "http://127.0.0.1:18080",
    model: "bge-reranker-v2-m3",
    apiKey: "",
    headers: {},
    timeoutMs: 3_000,
  }, { transport });
}

describe("buildResourceRoutingEmbeddingState", () => {
  it("embeds only semantic categories sequentially and never embeds fallback", async () => {
    const config = makeTempConfig();
    const seenInputs: string[] = [];
    const expectedRoutingTexts = taxonomy.semanticCategories.map((category) => category.embeddingText);
    const firstTransport: HttpTransport = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init.body)) as { input: string[] };
      expect(body.input).toHaveLength(1);
      const text = body.input[0];
      expect(text).toBeDefined();
      seenInputs.push(text!);
      const categoryIndex = expectedRoutingTexts.indexOf(text!);
      expect(categoryIndex).toBeGreaterThanOrEqual(0);
      return new Response(JSON.stringify({
        data: [{
          index: 0,
          embedding: categoryIndex % 2 === 0 ? [1, 0] : [0, 1],
        }],
      }), { status: 200 });
    });
    const first = await buildResourceRoutingEmbeddingState({
      taxonomy,
      agentId: "main",
      config,
      embedder: embeddingClientFor([1, 0], firstTransport),
    });
    expect(first.source).toBe("recomputed");
    expect(first.cacheMissReason).toBe("missing");
    expect(first.categories).toHaveLength(taxonomy.semanticCategories.length);
    expect(firstTransport).toHaveBeenCalledTimes(taxonomy.semanticCategories.length);
    expect(seenInputs).toEqual(expectedRoutingTexts);
    expect(seenInputs).not.toContain(taxonomy.byKey.get("inbox")?.embeddingText);

    const forbiddenTransport: HttpTransport = vi.fn(async () => {
      throw new Error("embedder must not be called on cache hit");
    });
    const second = await buildResourceRoutingEmbeddingState({
      taxonomy,
      agentId: "main",
      config,
      embedder: embeddingClientFor([1, 0], forbiddenTransport),
    });
    expect(second.source).toBe("cache");
    expect(forbiddenTransport).not.toHaveBeenCalled();
  });

  it("does not persist a partial cache when sequential embedding fails", async () => {
    const config = makeTempConfig();
    const cacheFile = config.cacheFile.replace("{agentId}", "main");
    let calls = 0;
    const transport: HttpTransport = vi.fn(async () => {
      calls += 1;
      if (calls === 2) {
        throw new Error("embedder offline");
      }
      return new Response(JSON.stringify({
        data: [{ index: 0, embedding: [1, 0] }],
      }), { status: 200 });
    });

    await expect(buildResourceRoutingEmbeddingState({
      taxonomy,
      agentId: "main",
      config,
      embedder: embeddingClientFor([1, 0], transport),
    })).rejects.toThrow(/embedder offline/);

    expect(transport).toHaveBeenCalledTimes(2);
    expect(existsSync(cacheFile)).toBe(false);
  });

  it("fails closed when config fallback and taxonomy fallback disagree", async () => {
    const config = makeTempConfig({ fallbackCategory: "docs" });
    await expect(buildResourceRoutingEmbeddingState({
      taxonomy,
      agentId: "main",
      config,
      embedder: embeddingClientFor([1, 0]),
    })).rejects.toThrow(/fallback mismatch/);
  });
});

describe("ResourceRouter", () => {
  it("accepts a confident semantic top1 without allowing fallback to compete", async () => {
    const config = makeTempConfig();
    const rerankTransport: HttpTransport = vi.fn(async () => {
      throw new Error("reranker should not be called");
    });
    const router = new ResourceRouter({
      taxonomy,
      config,
      embeddings: {
        source: "cache",
        categories: [
          embedded("docs", "documents", "Docs", [1, 0]),
          embedded("security", "security", "Security", [0.4, 0.6]),
          embedded("security_audits", "security/audits", "Audits", [0.3, 0.7]),
        ],
      },
      embedder: embeddingClientFor([1, 0]),
      reranker: rerankerClient(rerankTransport),
    });

    const decision = await router.route("A practical software documentation guide.");
    expect(decision).toMatchObject({
      categoryKey: "docs",
      uri: "viking://resources/documents",
      fallback: false,
      rerankerUsed: false,
    });
    expect(decision.embeddingCandidates.every((candidate) => candidate.key !== "inbox")).toBe(true);
    expect(rerankTransport).not.toHaveBeenCalled();
  });

  it("reranks close semantic candidates using embeddingText and can refine to second place", async () => {
    const config = makeTempConfig();
    const rerankTransport: HttpTransport = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init.body)) as { documents: string[] };
      expect(body.documents).toEqual(["Security", "Security audits"]);
      return new Response(JSON.stringify({
        results: [
          { index: 1, relevance_score: 0.94 },
          { index: 0, relevance_score: 0.71 },
        ],
      }), { status: 200 });
    });
    const router = new ResourceRouter({
      taxonomy,
      config,
      embeddings: {
        source: "cache",
        categories: [
          embedded("docs", "documents", "Docs", [0.2, 0.8]),
          embedded("security", "security", "Security", [1, 0]),
          embedded("security_audits", "security/audits", "Security audits", [0.999, 0.04]),
        ],
      },
      embedder: embeddingClientFor([1, 0]),
      reranker: rerankerClient(rerankTransport),
    });

    const decision = await router.route("A security audit report with findings and remediation.");
    expect(decision.categoryKey).toBe("security_audits");
    expect(decision.uri).toBe("viking://resources/security/audits");
    expect(decision.rerankerUsed).toBe(true);
    expect(decision.rerankerScores?.[0]).toEqual({
      key: "security_audits",
      path: "security/audits",
      score: 0.94,
    });
  });

  it("sends semantic uncertainty to fallback without making fallback a candidate", async () => {
    const config = makeTempConfig();
    const rerankTransport: HttpTransport = vi.fn(async () => {
      throw new Error("reranker should not be called for below-threshold uncertainty");
    });
    const router = new ResourceRouter({
      taxonomy,
      config,
      embeddings: {
        source: "cache",
        categories: [
          embedded("docs", "documents", "Docs", [0.9, 0.1]),
          embedded("security", "security", "Security", [0.8, 0.2]),
          embedded("security_audits", "security/audits", "Audits", [0.7, 0.3]),
        ],
      },
      embedder: embeddingClientFor([0, 1]),
      reranker: rerankerClient(rerankTransport),
    });

    const decision = await router.route("Ambiguous miscellaneous material.");
    expect(decision).toMatchObject({
      categoryKey: "inbox",
      uri: "viking://resources/__INBOX__",
      fallback: true,
      fallbackReason: "below_min_score",
      rerankerUsed: false,
    });
    expect(decision.embeddingCandidates.every((candidate) => candidate.key !== "inbox")).toBe(true);
    expect(rerankTransport).not.toHaveBeenCalled();
  });

  it("propagates reranker infrastructure failure instead of disguising it as inbox", async () => {
    const config = makeTempConfig();
    const router = new ResourceRouter({
      taxonomy,
      config,
      embeddings: {
        source: "cache",
        categories: [
          embedded("docs", "documents", "Docs", [0.1, 0.9]),
          embedded("security", "security", "Security", [1, 0]),
          embedded("security_audits", "security/audits", "Audits", [0.999, 0.04]),
        ],
      },
      embedder: embeddingClientFor([1, 0]),
      reranker: rerankerClient(vi.fn(async () => new Response("reranker down", { status: 503 })) as HttpTransport),
    });

    await expect(router.route("Security audit findings."))
      .rejects.toThrow(/HTTP 503: reranker down/);
  });
});
