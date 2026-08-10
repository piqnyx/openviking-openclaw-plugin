import { describe, expect, it } from "vitest";

import { parseResourceRoutingConfig } from "../resource-routing/config.js";

describe("resource routing path template isolation", () => {
  it.each([
    { taxonomyFile: "/tmp/{agentId}/../shared.yaml" },
    { cacheFile: "/tmp/{agentId}/../shared-cache.json" },
    { auditFile: "/tmp/{agentId}/../shared-audit.jsonl" },
  ])("rejects a template whose agent placeholder disappears after path normalization", (input) => {
    expect(() => parseResourceRoutingConfig(input)).toThrow(/distinct paths for different agents/);
  });

  it("accepts custom templates that remain distinct after normalization", () => {
    const cfg = parseResourceRoutingConfig({
      taxonomyFile: "/srv/taxonomy/{agentId}.yaml",
      cacheFile: "/srv/cache/{agentId}.json",
      auditFile: "/srv/audit/{agentId}.jsonl",
    });
    expect(cfg.taxonomyFile).toBe("/srv/taxonomy/{agentId}.yaml");
  });
});
