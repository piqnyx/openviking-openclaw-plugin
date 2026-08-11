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

describe("ResourceRoutingService.preloadAgents", () => {
  it("preloads configured agent taxonomies sequentially and isolates failures", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ov-routing-preload-"));
    tempDirs.push(dir);
    const taxonomy = `
schemaVersion: 1
fallback: inbox
categories:
  inbox:
    segment: __INBOX__
    description: Fallback resources.
  docs:
    segment: documents
    description: Documentation and guides.
`;
    writeFileSync(join(dir, "main.yaml"), taxonomy, "utf8");
    // Intentionally do not create igor.yaml: one broken agent must not disable the other.

    const config = parseResourceRoutingConfig({
      enabled: true,
      taxonomyFile: join(dir, "{agentId}.yaml"),
      cacheFile: join(dir, "cache-{agentId}.json"),
      audit: { enabled: false, file: join(dir, "audit-{agentId}.jsonl") },
      embedding: { dimensions: 2 },
    });

    const embeddingTransport: HttpTransport = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init.body)) as { input: string[] };
      expect(body.input).toHaveLength(1);
      return new Response(JSON.stringify({
        data: [{ index: 0, embedding: [1, 0] }],
      }), { status: 200 });
    });
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const result = await new ResourceRoutingService(config, { embeddingTransport })
      .preloadAgents(["igor", "main", "main"], logger);

    expect(result.ready).toEqual(["main"]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.agentId).toBe("igor");
    expect(result.failed[0]?.error).toMatch(/igor\.yaml.*could not be read/);
    expect(logger.info).toHaveBeenCalledWith("openviking: resource routing ready for agent main");
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("resource routing preload failed for agent igor"));
    expect(embeddingTransport).toHaveBeenCalledTimes(2);
  });

  it("waits for an active preload before starting automatic routing model requests", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ov-routing-preload-race-"));
    tempDirs.push(dir);
    const taxonomy = `
schemaVersion: 1
fallback: inbox
categories:
  inbox:
    segment: __INBOX__
    description: Fallback resources.
`;
    writeFileSync(join(dir, "igor.yaml"), taxonomy, "utf8");
    writeFileSync(join(dir, "main.yaml"), taxonomy, "utf8");

    const config = parseResourceRoutingConfig({
      enabled: true,
      taxonomyFile: join(dir, "{agentId}.yaml"),
      cacheFile: join(dir, "cache-{agentId}.json"),
      audit: { enabled: false, file: join(dir, "audit-{agentId}.jsonl") },
      embedding: { dimensions: 2 },
    });

    let releaseFirstRequest!: () => void;
    const firstRequestGate = new Promise<void>((resolve) => {
      releaseFirstRequest = resolve;
    });
    let markFirstRequestStarted!: () => void;
    const firstRequestStarted = new Promise<void>((resolve) => {
      markFirstRequestStarted = resolve;
    });
    let requestCount = 0;
    const embeddingTransport: HttpTransport = vi.fn(async (_url, init) => {
      requestCount += 1;
      if (requestCount === 1) {
        markFirstRequestStarted();
        await firstRequestGate;
      }
      const body = JSON.parse(String(init.body)) as { input: string[] };
      return new Response(JSON.stringify({
        data: body.input.map((_entry, index) => ({
          index,
          embedding: [1, 0],
        })),
      }), { status: 200 });
    });
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const service = new ResourceRoutingService(config, { embeddingTransport });

    const preloadPromise = service.preloadAgents(["igor"], logger);
    await firstRequestStarted;

    const routePromise = service.routeAutomatic({
      agentId: "main",
      source: "/workspace/verse.md",
      sourceKind: "local_path",
      summary: "A short synthetic text resource used to validate routing.",
    });

    await Promise.resolve();
    expect(embeddingTransport).toHaveBeenCalledTimes(1);

    releaseFirstRequest();
    await preloadPromise;
    const routed = await routePromise;

    expect(routed.category.key).toBe("inbox");
    expect(embeddingTransport).toHaveBeenCalledTimes(3);
  });
});
