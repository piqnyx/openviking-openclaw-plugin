import { describe, expect, it, vi } from "vitest";

import { parseResourceRoutingConfig } from "../resource-routing/config.js";
import { ResourceRoutingManager } from "../resource-routing/manager.js";
import { parseResourceTaxonomy } from "../resource-routing/taxonomy.js";
import type { PreparedAgentResourceRoutingState } from "../resource-routing/state.js";
import type { ResourceRoutingHttpTransport } from "../resource-routing/ml-client.js";

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function preparedState(): PreparedAgentResourceRoutingState {
  const taxonomy = parseResourceTaxonomy({
    schemaVersion: 1,
    categories: {
      inbox: { segment: "__INBOX__", description: "Unclassified resources." },
      docs: { segment: "documents", description: "Technical documentation and guides." },
    },
  });
  return {
    agentId: "main",
    taxonomy,
    taxonomyHash: "tax-hash",
    embeddings: new Map([
      ["inbox", [0, 1]],
      ["docs", [1, 0]],
    ]),
    paths: {
      taxonomyFile: "/tmp/main.yaml",
      cacheFile: "/tmp/main.json",
      auditFile: "/tmp/main.jsonl",
    },
    cache: { rebuilt: false },
  };
}

function makeManager(options: { logDecisions: boolean; embeddingTransport: ResourceRoutingHttpTransport }) {
  const cfg = parseResourceRoutingConfig({
    enabled: true,
    logDecisions: options.logDecisions,
    embedding: { dimensions: 2 },
    retrieval: { minScore: 0.1, rerankBelowMargin: 0 },
    audit: { enabled: false },
  });
  const logger = { info: vi.fn(), warn: vi.fn() };
  const manager = new ResourceRoutingManager(cfg, logger, {
    prepareState: vi.fn(async () => preparedState()),
    embeddingTransport: options.embeddingTransport,
  });
  return { manager, logger };
}

describe("resource routing gateway diagnostics", () => {
  it("logs a compact decision without source or summary when explicitly enabled", async () => {
    const transport: ResourceRoutingHttpTransport = vi.fn(async () => jsonResponse({
      data: [{ index: 0, embedding: [1, 0] }],
    }));
    const { manager, logger } = makeManager({ logDecisions: true, embeddingTransport: transport });

    const result = await manager.routeResource("main", {
      summary: "Private technical documentation about a confidential gateway.",
      source: "/workspace/draft/private-gateway.md",
    });

    expect(result.categoryKey).toBe("docs");
    expect(result.timingMs.total).toBeGreaterThanOrEqual(result.timingMs.embedding);
    expect(logger.info).toHaveBeenCalledTimes(1);
    const line = String(logger.info.mock.calls[0]?.[0]);
    expect(line).toContain('category="docs"');
    expect(line).toContain("cosine=[");
    expect(line).toContain("timing_ms=");
    expect(line).not.toContain("private-gateway.md");
    expect(line).not.toContain("confidential gateway");
  });

  it("does not emit per-decision info logs when logDecisions is disabled", async () => {
    const transport: ResourceRoutingHttpTransport = vi.fn(async () => jsonResponse({
      data: [{ index: 0, embedding: [1, 0] }],
    }));
    const { manager, logger } = makeManager({ logDecisions: false, embeddingTransport: transport });

    await manager.routeResource("main", {
      summary: "Technical documentation.",
      source: "/workspace/draft/doc.md",
    });

    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("always warns on routing infrastructure failure without leaking resource content", async () => {
    const transport: ResourceRoutingHttpTransport = vi.fn(async () => new Response("down", { status: 503 }));
    const { manager, logger } = makeManager({ logDecisions: false, embeddingTransport: transport });

    await expect(manager.routeResource("main", {
      summary: "Secret incident report.",
      source: "/workspace/draft/secret-incident.md",
    })).rejects.toThrow(/HTTP 503/);

    expect(logger.warn).toHaveBeenCalledTimes(1);
    const line = String(logger.warn.mock.calls[0]?.[0]);
    expect(line).toContain("resource not imported");
    expect(line).toContain("HTTP 503");
    expect(line).not.toContain("secret-incident.md");
    expect(line).not.toContain("Secret incident report");
  });
});
