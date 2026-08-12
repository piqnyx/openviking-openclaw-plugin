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

const validTaxonomy = `
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

describe("ResourceRoutingService.preloadAgents", () => {
  it("preloads configured agent taxonomies sequentially and isolates failures", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ov-routing-preload-"));
    tempDirs.push(dir);
    writeFileSync(join(dir, "main.yaml"), validTaxonomy, "utf8");
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
      expect(body.input[0]).not.toContain("Fallback resources");
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
    expect(embeddingTransport).toHaveBeenCalledTimes(1);
  });

  it("does not make main wait for an unrelated igor cold preload", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ov-routing-preload-race-"));
    tempDirs.push(dir);
    writeFileSync(join(dir, "igor.yaml"), validTaxonomy, "utf8");
    writeFileSync(join(dir, "main.yaml"), validTaxonomy, "utf8");

    const config = parseResourceRoutingConfig({
      enabled: true,
      taxonomyFile: join(dir, "{agentId}.yaml"),
      cacheFile: join(dir, "cache-{agentId}.json"),
      audit: { enabled: false, file: join(dir, "audit-{agentId}.jsonl") },
      embedding: { dimensions: 2 },
    });

    let releaseIgor!: () => void;
    const igorGate = new Promise<void>((resolve) => {
      releaseIgor = resolve;
    });
    let markIgorStarted!: () => void;
    const igorStarted = new Promise<void>((resolve) => {
      markIgorStarted = resolve;
    });
    let markMainStarted!: () => void;
    const mainStarted = new Promise<void>((resolve) => {
      markMainStarted = resolve;
    });

    let requestCount = 0;
    const embeddingTransport: HttpTransport = vi.fn(async (_url, init) => {
      requestCount += 1;
      if (requestCount === 1) {
        markIgorStarted();
        await igorGate;
      } else if (requestCount === 2) {
        markMainStarted();
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
    await igorStarted;

    const routePromise = service.routeAutomatic({
      agentId: "main",
      source: "/workspace/guide.md",
      sourceKind: "local_path",
      summary: "Documentation and guides for configuring an application.",
    });

    await mainStarted;
    const routed = await routePromise;
    expect(routed.category.key).toBe("docs");
    expect(requestCount).toBe(3);

    releaseIgor();
    await preloadPromise;
    expect(requestCount).toBe(3);
  });
});
