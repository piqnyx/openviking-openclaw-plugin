import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const manifest = JSON.parse(
  readFileSync(join(process.cwd(), "openclaw.plugin.json"), "utf8"),
) as {
  configSchema?: {
    properties?: Record<string, unknown>;
  };
};

describe("resourceRouting manifest schema", () => {
  it("exposes the strict resourceRouting section accepted by runtime config", () => {
    const routing = manifest.configSchema?.properties?.resourceRouting as {
      additionalProperties?: boolean;
      properties?: Record<string, unknown>;
    } | undefined;

    expect(routing?.additionalProperties).toBe(false);
    expect(Object.keys(routing?.properties ?? {})).toEqual([
      "enabled",
      "taxonomyFile",
      "cacheFile",
      "semanticInputTemplate",
      "embedding",
      "reranker",
      "retrieval",
      "fallbackCategory",
      "failurePolicy",
      "audit",
    ]);
  });

  it("keeps embedding dimensions separate from the reranker schema", () => {
    const routing = manifest.configSchema?.properties?.resourceRouting as {
      properties?: Record<string, { properties?: Record<string, unknown> }>;
    } | undefined;
    expect(routing?.properties?.embedding?.properties).toHaveProperty("dimensions");
    expect(routing?.properties?.reranker?.properties).not.toHaveProperty("dimensions");
  });
});
