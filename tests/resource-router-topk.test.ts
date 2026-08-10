import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { HttpTransport } from "../adapters/http-transport.js";
import { parseResourceRoutingConfig } from "../routing/resource-routing-config.js";
import {
  ResourceRoutingEmbeddingClient,
  ResourceRoutingRerankerClient,
} from "../routing/resource-routing-model-client.js";
import { ResourceRouter } from "../routing/resource-router.js";
import { compileResourceTaxonomy } from "../routing/resource-taxonomy.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("ResourceRouter configurable topK", () => {
  it("uses top1/top2 margin as the rerank trigger but reranks the full configured topK", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ov-router-topk-"));
    tempDirs.push(dir);
    const config = parseResourceRoutingConfig({
      enabled: true,
      taxonomyFile: join(dir, "{agentId}.yaml"),
      cacheFile: join(dir, "cache-{agentId}.json"),
      embedding: { dimensions: 2 },
      retrieval: { topK: 3, minScore: 0.64, rerankBelowMargin: 0.06 },
      fallbackCategory: "inbox",
      audit: { enabled: false, file: join(dir, "audit-{agentId}.jsonl") },
    });
    const taxonomy = compileResourceTaxonomy({
      schemaVersion: 1,
      fallback: "inbox",
      categories: {
        inbox: { segment: "__INBOX__", description: "Fallback resources." },
        security: { segment: "security", description: "General security material." },
        audits: { segment: "audits", description: "Security audit findings and remediation reports." },
        reports: { segment: "reports", description: "General analytical and operational reports." },
      },
    });

    const embeddingTransport: HttpTransport = vi.fn(async () => new Response(JSON.stringify({
      data: [{ index: 0, embedding: [1, 0] }],
    }), { status: 200 }));
    const rerankerTransport: HttpTransport = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init.body)) as { documents: string[]; top_n: number };
      expect(body.documents).toEqual(["Security", "Audits", "Reports"]);
      expect(body.top_n).toBe(3);
      return new Response(JSON.stringify({
        results: [
          { index: 2, relevance_score: 0.95 },
          { index: 1, relevance_score: 0.91 },
          { index: 0, relevance_score: 0.70 },
        ],
      }), { status: 200 });
    });

    const router = new ResourceRouter({
      taxonomy,
      config,
      embeddings: {
        source: "cache",
        categories: [
          { key: "inbox", description: "Inbox", embedding: [0, 1] },
          { key: "security", description: "Security", embedding: [1, 0] },
          { key: "audits", description: "Audits", embedding: [0.999, 0.04] },
          { key: "reports", description: "Reports", embedding: [0.997, 0.07] },
        ],
      },
      embedder: new ResourceRoutingEmbeddingClient(config.embedding, { transport: embeddingTransport }),
      reranker: new ResourceRoutingRerankerClient(config.reranker, { transport: rerankerTransport }),
    });

    const result = await router.route("A security audit report.");
    expect(result.embeddingCandidates).toHaveLength(3);
    expect(result.rerankerScores).toHaveLength(3);
    expect(result.categoryKey).toBe("reports");
    expect(rerankerTransport).toHaveBeenCalledTimes(1);
  });
});
