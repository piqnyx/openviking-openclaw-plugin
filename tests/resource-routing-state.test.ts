import { describe, expect, it, vi } from "vitest";

import { parseResourceRoutingConfig } from "../resource-routing/config.js";
import { ResourceEmbeddingClient, type ResourceRoutingHttpTransport } from "../resource-routing/ml-client.js";
import { prepareAgentResourceRoutingState, resourceEmbeddingModelIdentity } from "../resource-routing/state.js";
import { parseResourceTaxonomy } from "../resource-routing/taxonomy.js";
import { createResourceRoutingCacheExpectation, type ResourceRoutingCacheDocument } from "../resource-routing/cache.js";

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } });
}

function taxonomy() {
  return parseResourceTaxonomy({
    schemaVersion: 1,
    categories: {
      inbox: { segment: "__INBOX__", description: "Unclassified resources." },
      docs: { segment: "documents", description: "General documents." },
      grouping: { segment: "grouping", description: "Grouping only.", routeable: false },
    },
  });
}

describe("prepareAgentResourceRoutingState", () => {
  it("loads a valid per-agent cache without calling the embedder", async () => {
    const cfg = parseResourceRoutingConfig({ enabled: true, embedding: { dimensions: 2 } });
    const parsedTaxonomy = taxonomy();
    const expectation = createResourceRoutingCacheExpectation(
      parsedTaxonomy,
      resourceEmbeddingModelIdentity(cfg),
      2,
    );
    const cache: ResourceRoutingCacheDocument = {
      schemaVersion: 1,
      taxonomyHash: expectation.taxonomyHash,
      embeddingModel: expectation.embeddingModel,
      dimensions: 2,
      categories: [
        { key: "inbox", embedding: [1, 0] },
        { key: "docs", embedding: [0, 1] },
      ],
    };
    const transport: ResourceRoutingHttpTransport = vi.fn(async () => {
      throw new Error("embedder should not be called on cache hit");
    });

    const result = await prepareAgentResourceRoutingState(
      cfg,
      "igor",
      new ResourceEmbeddingClient(cfg.embedding, transport),
      {
        loadTaxonomy: async () => parsedTaxonomy,
        loadCache: async () => ({ status: "hit", cache }),
        writeCache: vi.fn(),
      },
    );

    expect(result.agentId).toBe("igor");
    expect(result.cache.rebuilt).toBe(false);
    expect(result.embeddings.get("docs")).toEqual([0, 1]);
    expect(transport).not.toHaveBeenCalled();
    expect(result.paths.taxonomyFile).toMatch(/\/\.openclaw\/igor\.yaml$/);
  });

  it("rebuilds a stale/corrupt cache from taxonomy descriptions and writes it atomically through the cache seam", async () => {
    const cfg = parseResourceRoutingConfig({ enabled: true, embedding: { dimensions: 2 } });
    const parsedTaxonomy = taxonomy();
    const transport: ResourceRoutingHttpTransport = vi.fn(async (_url, init) => {
      expect(JSON.parse(String(init.body)).input).toEqual([
        "Unclassified resources.",
        "General documents.",
      ]);
      return jsonResponse({
        data: [
          { index: 0, embedding: [1, 0] },
          { index: 1, embedding: [0, 1] },
        ],
      });
    });
    let writtenCache: ResourceRoutingCacheDocument | undefined;
    const writeCache = vi.fn(async (_path: string, cache: ResourceRoutingCacheDocument) => {
      writtenCache = cache;
    });

    const result = await prepareAgentResourceRoutingState(
      cfg,
      "main",
      new ResourceEmbeddingClient(cfg.embedding, transport),
      {
        loadTaxonomy: async () => parsedTaxonomy,
        loadCache: async () => ({ status: "miss", reason: "taxonomy hash mismatch" }),
        writeCache,
      },
    );

    expect(result.cache).toEqual({ rebuilt: true, reason: "taxonomy hash mismatch" });
    expect(result.embeddings.get("inbox")).toEqual([1, 0]);
    expect(result.embeddings.get("docs")).toEqual([0, 1]);
    expect(writeCache).toHaveBeenCalledOnce();
    expect(writtenCache).toBeDefined();
    expect(writtenCache!.embeddingModel).toBe(resourceEmbeddingModelIdentity(cfg));
    expect(writtenCache!.categories.map((entry) => entry.key)).toEqual(["inbox", "docs"]);
  });

  it("fails closed when configured fallback is absent instead of building a misleading cache", async () => {
    const cfg = parseResourceRoutingConfig({
      enabled: true,
      fallbackCategory: "missing",
      embedding: { dimensions: 2 },
    });
    const transport: ResourceRoutingHttpTransport = vi.fn(async () => jsonResponse({ data: [] }));

    await expect(prepareAgentResourceRoutingState(
      cfg,
      "main",
      new ResourceEmbeddingClient(cfg.embedding, transport),
      {
        loadTaxonomy: async () => taxonomy(),
      },
    )).rejects.toThrow(/fallback category does not exist/);
    expect(transport).not.toHaveBeenCalled();
  });

  it("fails closed when the taxonomy file cannot be loaded", async () => {
    const cfg = parseResourceRoutingConfig({ enabled: true, embedding: { dimensions: 2 } });
    const transport: ResourceRoutingHttpTransport = vi.fn(async () => jsonResponse({ data: [] }));

    await expect(prepareAgentResourceRoutingState(
      cfg,
      "main",
      new ResourceEmbeddingClient(cfg.embedding, transport),
      {
        loadTaxonomy: async () => { throw new Error("taxonomy missing"); },
      },
    )).rejects.toThrow("taxonomy missing");
    expect(transport).not.toHaveBeenCalled();
  });
});
