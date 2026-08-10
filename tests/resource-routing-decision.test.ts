import { describe, expect, it, vi } from "vitest";

import type { ResourceRoutingCategoryEmbeddingStore } from "../resource-routing/category-embeddings.js";
import { parseResourceRoutingConfig } from "../resource-routing/config.js";
import type {
  LoadedAgentResourceRouting,
  ResourceRoutingTaxonomyLoader,
} from "../resource-routing/loader.js";
import type {
  ResourceRoutingEmbeddingClient,
  ResourceRoutingRerankerClient,
} from "../resource-routing/providers.js";
import {
  cosineSimilarity,
  createResourceRoutingDecisionEngine,
  renderResourceRoutingSemanticInput,
} from "../resource-routing/routing.js";
import { parseResourceTaxonomyYaml } from "../resource-routing/taxonomy.js";

const TAXONOMY = `schemaVersion: 1
categories:
  inbox:
    segment: __INBOX__
    description: Uncertain resources.
  security:
    segment: security
    description: General security material.
  security-audits:
    segment: security-audits
    description: Security audits, findings, review reports, and remediation material.
  tests:
    segment: tests
    description: Test fixtures, experiments, and validation resources.
`;

function setup(options: {
  queryEmbedding?: number[];
  categoryVectors?: Record<string, number[]>;
  rerank?: Array<{ index: number; score: number }>;
  minScore?: number;
  margin?: number;
  topK?: number;
  semanticInputTemplate?: string;
  embeddingError?: Error;
  rerankerError?: Error;
} = {}) {
  const taxonomy = parseResourceTaxonomyYaml(TAXONOMY);
  const config = parseResourceRoutingConfig({
    semanticInputTemplate: options.semanticInputTemplate ?? "{{summary}}",
    embedding: { dimensions: 3 },
    retrieval: {
      topK: options.topK ?? 2,
      minScore: options.minScore ?? 0.64,
      rerankBelowMargin: options.margin ?? 0.06,
    },
  });
  const fallback = taxonomy.byKey.get("inbox")!;
  const loaded: LoadedAgentResourceRouting = {
    agentId: "main",
    taxonomyPath: "/tmp/main.yaml",
    cachePath: "/tmp/main.json",
    taxonomy,
    fallbackCategory: fallback,
    embeddingCache: { status: "miss", reason: "not_found" },
  };
  const loader: ResourceRoutingTaxonomyLoader = {
    load: vi.fn(async () => loaded),
    has: vi.fn(() => true),
  };

  const defaultVectors: Record<string, number[]> = {
    inbox: [0, 0, 1],
    security: [1, 0, 0],
    "security-audits": [0.99, 0.1, 0],
    tests: [0, 1, 0],
  };
  const vectors = options.categoryVectors ?? defaultVectors;
  const categoryEmbeddingStore: ResourceRoutingCategoryEmbeddingStore = {
    get: vi.fn(async () => ({
      agentId: "main",
      taxonomyHash: taxonomy.taxonomyHash,
      source: "cache" as const,
      vectorsByCategoryKey: new Map(Object.entries(vectors)),
    })),
    has: vi.fn(() => true),
  };

  const embed = vi.fn(async () => {
    if (options.embeddingError) {
      throw options.embeddingError;
    }
    return [options.queryEmbedding ?? [1, 0, 0]];
  });
  const embeddingClient: ResourceRoutingEmbeddingClient = { embed };

  const rerank = vi.fn(async () => {
    if (options.rerankerError) {
      throw options.rerankerError;
    }
    return options.rerank ?? [
      { index: 0, score: 0.2 },
      { index: 1, score: 0.9 },
    ];
  });
  const rerankerClient: ResourceRoutingRerankerClient = { rerank };

  const engine = createResourceRoutingDecisionEngine({
    config,
    loader,
    categoryEmbeddingStore,
    embeddingClient,
    rerankerClient,
  });

  return { engine, embed, rerank, taxonomy, config };
}

describe("resource routing semantic input", () => {
  it("uses summary-only by default and supports explicit future metadata templates", () => {
    expect(
      renderResourceRoutingSemanticInput("{{summary}}", {
        summary: "  A security audit report with remediation findings.  ",
        filename: "audit.md",
        sourceKind: "local-file",
      }),
    ).toBe("A security audit report with remediation findings.");

    expect(
      renderResourceRoutingSemanticInput("{{summary}}\nSource type: {{sourceKind}}\nAgent: {{agentId}}", {
        summary: "A security audit report.",
        sourceKind: "local-file",
        agentId: "main",
      }),
    ).toBe("A security audit report.\nSource type: local-file\nAgent: main");
  });

  it("requires a concise semantic summary with an actionable retry hint", async () => {
    const { engine, embed } = setup();
    await expect(engine.route("main", { summary: "   " })).rejects.toThrow(
      /requires `summary`.*one short sentence.*retry add_resource/i,
    );
    expect(embed).not.toHaveBeenCalled();
  });
});

describe("resource routing cosine ranking", () => {
  it("computes cosine similarity and rejects invalid vectors", () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBeCloseTo(0);
    expect(() => cosineSimilarity([1, 0], [1, 0, 0])).toThrow(/dimensions/);
    expect(() => cosineSimilarity([0, 0, 0], [1, 0, 0])).toThrow(/zero or invalid magnitude/);
  });
});

describe("deterministic resource routing decisions", () => {
  it("accepts a confident embedding top1 without invoking the reranker", async () => {
    const { engine, rerank } = setup({
      queryEmbedding: [1, 0, 0],
      categoryVectors: {
        inbox: [0, 0, 1],
        security: [1, 0, 0],
        "security-audits": [0.5, 0.5, 0],
        tests: [0, 1, 0],
      },
      margin: 0.06,
    });
    const decision = await engine.route("main", {
      summary: "General security guidance and defensive controls.",
    });
    expect(decision).toMatchObject({
      reason: "embedding",
      rerankerUsed: false,
      category: {
        key: "security",
        uri: "viking://resources/security",
      },
    });
    expect(rerank).not.toHaveBeenCalled();
  });

  it("routes semantic uncertainty to configured fallback and still does not call reranker", async () => {
    const { engine, rerank } = setup({
      queryEmbedding: [1, 0, 0],
      categoryVectors: {
        inbox: [0, 1, 0],
        security: [0.5, Math.sqrt(0.75), 0],
        "security-audits": [0.4, Math.sqrt(0.84), 0],
        tests: [0, 0, 1],
      },
      minScore: 0.64,
    });
    const decision = await engine.route("main", {
      summary: "An ambiguous resource whose destination is not clear.",
    });
    expect(decision).toMatchObject({
      reason: "fallback_low_score",
      rerankerUsed: false,
      fallbackReason: "below_min_score",
      category: {
        key: "inbox",
        uri: "viking://resources/__INBOX__",
      },
    });
    expect(decision.embeddingCandidates[0]!.score).toBeLessThan(0.64);
    expect(rerank).not.toHaveBeenCalled();
  });

  it("conditionally reranks close top candidates and can refine security to security-audits", async () => {
    const { engine, rerank } = setup({
      queryEmbedding: [1, 0, 0],
      categoryVectors: {
        inbox: [0, 0, 1],
        security: [1, 0, 0],
        "security-audits": [0.999, 0.0447, 0],
        tests: [0, 1, 0],
      },
      rerank: [
        { index: 0, score: 0.3 },
        { index: 1, score: 0.91 },
      ],
    });
    const decision = await engine.route("main", {
      summary: "A security audit report containing findings and remediation actions.",
    });
    expect(rerank).toHaveBeenCalledTimes(1);
    expect(rerank).toHaveBeenCalledWith(
      "A security audit report containing findings and remediation actions.",
      [
        "General security material.",
        "Security audits, findings, review reports, and remediation material.",
      ],
    );
    expect(decision).toMatchObject({
      reason: "reranker",
      rerankerUsed: true,
      category: {
        key: "security-audits",
        uri: "viking://resources/security-audits",
      },
    });
    expect(decision.rerankerCandidates?.[0]).toEqual({
      key: "security-audits",
      score: 0.91,
    });
  });

  it("reranks all retrieved topK candidates when the leading margin is small", async () => {
    const { engine, rerank } = setup({
      topK: 3,
      queryEmbedding: [1, 0, 0],
      categoryVectors: {
        inbox: [0.97, Math.sqrt(1 - 0.97 ** 2), 0],
        security: [1, 0, 0],
        "security-audits": [0.99, Math.sqrt(1 - 0.99 ** 2), 0],
        tests: [0, 1, 0],
      },
      rerank: [
        { index: 0, score: 0.2 },
        { index: 1, score: 0.8 },
        { index: 2, score: 0.4 },
      ],
    });
    const decision = await engine.route("main", { summary: "Security review material." });
    expect(rerank).toHaveBeenCalledWith(
      "Security review material.",
      [
        "General security material.",
        "Security audits, findings, review reports, and remediation material.",
        "Uncertain resources.",
      ],
    );
    expect(decision.rerankerUsed).toBe(true);
  });

  it("does not rerank when the gap equals the configured margin exactly", async () => {
    const { engine, rerank } = setup({
      margin: 0.06,
      queryEmbedding: [1, 0, 0],
      categoryVectors: {
        inbox: [0, 0, 1],
        security: [1, 0, 0],
        "security-audits": [0.94, Math.sqrt(1 - 0.94 ** 2), 0],
        tests: [0, 1, 0],
      },
    });
    const decision = await engine.route("main", { summary: "Security material." });
    expect(decision.reason).toBe("embedding");
    expect(rerank).not.toHaveBeenCalled();
  });

  it("accepts a top score exactly equal to minScore rather than forcing fallback", async () => {
    const minScore = 0.64;
    const { engine } = setup({
      minScore,
      margin: 0,
      queryEmbedding: [1, 0, 0],
      categoryVectors: {
        inbox: [0, 0, 1],
        security: [minScore, Math.sqrt(1 - minScore ** 2), 0],
        "security-audits": [0, 1, 0],
        tests: [0, 0, 1],
      },
    });
    const decision = await engine.route("main", { summary: "Borderline security material." });
    expect(decision.reason).toBe("embedding");
    expect(decision.category.key).toBe("security");
  });

  it("allows inbox to win as an ordinary semantic category without labeling it a forced fallback", async () => {
    const { engine } = setup({
      margin: 0,
      queryEmbedding: [0, 0, 1],
    });
    const decision = await engine.route("main", {
      summary: "Unclear miscellaneous material with no confident subject.",
    });
    expect(decision.category.key).toBe("inbox");
    expect(decision.reason).toBe("embedding");
    expect(decision.fallbackReason).toBeUndefined();
  });

  it("propagates embedder infrastructure failure instead of disguising it as inbox", async () => {
    const { engine } = setup({ embeddingError: new Error("embedder unavailable") });
    await expect(engine.route("main", { summary: "Some resource." })).rejects.toThrow(
      /embedder unavailable/,
    );
  });

  it("propagates required reranker failure instead of disguising it as inbox", async () => {
    const { engine } = setup({
      queryEmbedding: [1, 0, 0],
      categoryVectors: {
        inbox: [0, 0, 1],
        security: [1, 0, 0],
        "security-audits": [0.999, 0.0447, 0],
        tests: [0, 1, 0],
      },
      rerankerError: new Error("reranker unavailable"),
    });
    await expect(
      engine.route("main", { summary: "A security audit report." }),
    ).rejects.toThrow(/reranker unavailable/);
  });

  it("never accepts a category outside the trusted taxonomy mapping", async () => {
    const { engine } = setup({
      categoryVectors: {
        inbox: [0, 0, 1],
        security: [1, 0, 0],
        tests: [0, 1, 0],
      },
    });
    await expect(engine.route("main", { summary: "Security material." })).rejects.toThrow(
      /embedding is missing for "security-audits"/,
    );
  });
});
