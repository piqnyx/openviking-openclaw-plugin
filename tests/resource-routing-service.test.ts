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
    description: Ресурсы, которые нельзя уверенно классифицировать.
  docs:
    segment: docs
    description: Структурный раздел документации.
    routeable: false
    children:
      docs-code:
        segment: code
        description: Документация, объясняющая программный код и его устройство.
  code-root:
    segment: code
    description: Структурный раздел исходного кода.
    routeable: false
    children:
      code-source:
        segment: source
        description: Структурный раздел исходников по языкам.
        routeable: false
        children:
          code-source-javascript:
            segment: javascript
            description: Исходный код программ на JavaScript и TypeScript.
  security:
    segment: security
    description: Отчёты по безопасности и материалы по защите систем.
`, "utf8");
  const config = parseResourceRoutingConfig({
    enabled: true,
    taxonomyFile: taxonomyTemplate,
    cacheFile: join(dir, "cache-{agentId}.json"),
    audit: { enabled: false, file: join(dir, "audit-{agentId}.jsonl") },
    embedding: { dimensions: 2 },
    retrieval: { topK: 3, minScore: 0.64, rerankBelowMargin: 0.06 },
    fallbackCategory: "inbox",
  });
  return { dir, config };
}

describe("ResourceRoutingService", () => {
  it("resolves explicit categories by full taxonomy path or semantic key without models", () => {
    const { config } = setup();
    const embeddingTransport: HttpTransport = vi.fn(async () => {
      throw new Error("embedding infrastructure must not be used");
    });
    const rerankerTransport: HttpTransport = vi.fn(async () => {
      throw new Error("reranker infrastructure must not be used");
    });
    const service = new ResourceRoutingService(config, { embeddingTransport, rerankerTransport });

    expect(service.resolveCategory("main", "docs/code").key).toBe("docs-code");
    expect(service.resolveCategory("main", "docs/code").uri).toBe("viking://resources/docs/code");
    expect(service.resolveCategory("main", "code/source/javascript").key).toBe("code-source-javascript");
    expect(service.resolveCategory("main", "code-source-javascript").uri).toBe(
      "viking://resources/code/source/javascript",
    );
    expect(embeddingTransport).not.toHaveBeenCalled();
    expect(rerankerTransport).not.toHaveBeenCalled();
  });

  it("keeps identical leaf segment names unambiguous because full paths and keys are distinct", () => {
    const { config } = setup();
    const service = new ResourceRoutingService(config);

    const docsCode = service.resolveCategory("main", "docs/code");
    const sourceJs = service.resolveCategory("main", "code/source/javascript");
    expect(docsCode.segment).toBe("code");
    expect(sourceJs.path).toBe("code/source/javascript");
    expect(docsCode.key).not.toBe(sourceJs.key);
    expect(docsCode.uri).not.toBe(sourceJs.uri);
  });

  it("falls back to inbox for unknown or organizational explicit selectors", () => {
    const { config } = setup();
    const service = new ResourceRoutingService(config);

    expect(service.resolveCategoryOrFallback("main", "missing/path")).toMatchObject({
      requested: "missing/path",
      fallback: true,
      fallbackReason: "unknown_category",
      matchedBy: "fallback",
      category: { key: "inbox", uri: "viking://resources/__INBOX__" },
    });
    expect(service.resolveCategoryOrFallback("main", "code/source")).toMatchObject({
      requested: "code/source",
      fallback: true,
      fallbackReason: "organizational_category",
      matchedBy: "fallback",
      category: { key: "inbox" },
    });
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

  it("embeds ancestry-aware category context and routes from summary-only semantic input", async () => {
    const { config } = setup();
    const summary = "Исходный код собственного приложения на JavaScript и TypeScript.";
    const embeddingByInput = new Map<string, number[]>([
      [
        "description: Документация, объясняющая программный код и его устройство.\n" +
        "ancestors: docs: Структурный раздел документации.\n" +
        "path: docs/code",
        [0.6, 0.4],
      ],
      [
        "description: Исходный код программ на JavaScript и TypeScript.\n" +
        "ancestors: code: Структурный раздел исходного кода. > code/source: Структурный раздел исходников по языкам.\n" +
        "path: code/source/javascript",
        [1, 0],
      ],
      [
        "description: Отчёты по безопасности и материалы по защите систем.\npath: security",
        [0.2, 0.8],
      ],
      [summary, [1, 0]],
    ]);
    const embeddingTransport: HttpTransport = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init.body)) as { input: string[] };
      expect(body.input).toHaveLength(1);
      const text = body.input[0];
      expect(text).toBeDefined();
      const embedding = embeddingByInput.get(text!);
      expect(embedding, `unexpected embedding input: ${text}`).toBeDefined();
      return new Response(JSON.stringify({
        data: [{ index: 0, embedding }],
      }), { status: 200 });
    });
    const rerankerTransport: HttpTransport = vi.fn(async () => {
      throw new Error("confident top1 should not rerank");
    });
    const service = new ResourceRoutingService(config, { embeddingTransport, rerankerTransport });

    const result = await service.routeAutomatic({
      agentId: "main",
      source: "/workspace/main.js",
      sourceKind: "local_file",
      summary,
      filename: "main.js",
    });
    expect(result.semanticInput).toBe(summary);
    expect(result.category.key).toBe("code-source-javascript");
    expect(result.category.path).toBe("code/source/javascript");
    expect(result.category.uri).toBe("viking://resources/code/source/javascript");
    expect(result.decision.fallback).toBe(false);
    expect(result.decision.embeddingCandidates.every((candidate) => candidate.key !== "inbox")).toBe(true);
    expect(embeddingTransport).toHaveBeenCalledTimes(4);
    expect(rerankerTransport).not.toHaveBeenCalled();
  });

  it("fails closed on automatic-routing infrastructure errors instead of returning inbox", async () => {
    const { config } = setup();
    const embeddingTransport: HttpTransport = vi.fn(async () => new Response("embedder down", { status: 503 }));
    const service = new ResourceRoutingService(config, { embeddingTransport });
    await expect(service.routeAutomatic({
      agentId: "main",
      source: "/workspace/guide.md",
      summary: "Практическое руководство по настройке системы.",
    })).rejects.toThrow(/HTTP 503: embedder down/);
  });
});
