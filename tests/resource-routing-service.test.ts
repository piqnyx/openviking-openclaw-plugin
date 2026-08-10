import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { HttpTransport } from "../adapters/http-transport.js";
import { parseResourceRoutingConfig } from "../routing/resource-routing-config.js";
import { ResourceRoutingService } from "../routing/resource-routing-service.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "ov-resource-routing-service-"));
  tempDirs.push(dir);
  const taxonomyTemplate = join(dir, "{agentId}.yaml");
  writeFileSync(join(dir, "main.yaml"), `
schemaVersion: 1
fallback: inbox
categories:
  inbox:
    segment: __INBOX__
    description: Resources that cannot be confidently classified elsewhere.
  docs:
    segment: documents
    description: General documentation, guides and manuals.
  security:
    segment: security
    description: Security reports and operational security material.
`, "utf8");
  const config = parseResourceRoutingConfig({
    enabled: true,
    taxonomyFile: taxonomyTemplate,
    cacheFile: join(dir, "cache-{agentId}.json"),
    audit: { enabled: false, file: join(dir, "audit-{agentId}.jsonl") },
    embedding: { dimensions: 2 },
    retrieval: { topK: 2, minScore: 0.64, rerankBelowMargin: 0.06 },
    fallbackCategory: "inbox",
  });
  return { dir, config };
}

describe("ResourceRoutingService", () => {
  it("resolves explicit semantic categories without touching embedding or reranker infrastructure", () => {
    const { config } = setup();
    const embeddingTransport: HttpTransport = vi.fn(async () => {
      throw new Error("embedding infrastructure must not be used");
    });
    const rerankerTransport: HttpTransport = vi.fn(async () => {
      throw new Error("reranker infrastructure must not be used");
    });
    const service = new ResourceRoutingService(config, { embeddingTransport, rerankerTransport });

    const category = service.resolveCategory("main", "docs");
    expect(category.uri).toBe("viking://resources/documents");
    expect(embeddingTransport).not.toHaveBeenCalled();
    expect(rerankerTransport).not.toHaveBeenCalled();
  });

  it("rejects unknown or organizational-only explicit categories", () => {
    const { dir, config } = setup();
    writeFileSync(join(dir, "main.yaml"), `
schemaVersion: 1
fallback: inbox
categories:
  inbox:
    segment: __INBOX__
    description: Fallback resources.
  projects:
    segment: projects
    description: Project grouping only.
    routeable: false
`, "utf8");
    const service = new ResourceRoutingService(config);
    expect(() => service.resolveCategory("main", "missing")).toThrow(/Unknown resource category/);
    expect(() => service.resolveCategory("main", "projects")).toThrow(/organizational only/);
  });

  it("requires a semantic summary before automatic routing calls any model", async () => {
    const { config } = setup();
    const embeddingTransport: HttpTransport = vi.fn(async () => {
      throw new Error("should not be reached");
    });
    const service = new ResourceRoutingService(config, { embeddingTransport });
    await expect(service.routeAutomatic({
      agentId: "main",
      source: "/workspace/doc.md",
      summary: "",
    })).rejects.toThrow(/requires `summary`/);
    expect(embeddingTransport).not.toHaveBeenCalled();
  });

  it("routes automatically from summary-only semantic input and keeps the per-agent taxonomy", async () => {
    const { config } = setup();
    const embeddingTransport: HttpTransport = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init.body)) as { input: string[] };
      if (body.input.length === 3) {
        return new Response(JSON.stringify({
          data: [
            { index: 0, embedding: [0, 1] },
            { index: 1, embedding: [1, 0] },
            { index: 2, embedding: [0.2, 0.8] },
          ],
        }), { status: 200 });
      }
      expect(body.input).toEqual(["A setup guide explaining how to configure the application."]);
      return new Response(JSON.stringify({
        data: [{ index: 0, embedding: [1, 0] }],
      }), { status: 200 });
    });
    const rerankerTransport: HttpTransport = vi.fn(async () => {
      throw new Error("confident top1 should not rerank");
    });
    const service = new ResourceRoutingService(config, { embeddingTransport, rerankerTransport });

    const result = await service.routeAutomatic({
      agentId: "main",
      source: "/workspace/guide.md",
      sourceKind: "local_file",
      summary: "A setup guide explaining how to configure the application.",
      filename: "guide.md",
    });
    expect(result.semanticInput).toBe("A setup guide explaining how to configure the application.");
    expect(result.category.key).toBe("docs");
    expect(result.category.uri).toBe("viking://resources/documents");
    expect(result.decision.fallback).toBe(false);
    expect(rerankerTransport).not.toHaveBeenCalled();
  });

  it("fails closed on automatic-routing infrastructure errors instead of returning inbox", async () => {
    const { config } = setup();
    const embeddingTransport: HttpTransport = vi.fn(async () => new Response("embedder down", { status: 503 }));
    const service = new ResourceRoutingService(config, { embeddingTransport });
    await expect(service.routeAutomatic({
      agentId: "main",
      source: "/workspace/guide.md",
      summary: "A setup guide.",
    })).rejects.toThrow(/HTTP 503: embedder down/);
  });
});
