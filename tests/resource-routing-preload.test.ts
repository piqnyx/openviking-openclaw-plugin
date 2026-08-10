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
      return new Response(JSON.stringify({
        data: body.input.map((_entry, index) => ({
          index,
          embedding: index === 0 ? [1, 0] : [0, 1],
        })),
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
});
