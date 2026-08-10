import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { RESOURCE_ROUTING_CONFIG_DEFAULTS } from "../resource-routing/config.js";

function asRecord(value: unknown): Record<string, any> {
  expect(value).toBeTruthy();
  expect(typeof value).toBe("object");
  expect(Array.isArray(value)).toBe(false);
  return value as Record<string, any>;
}

describe("resource routing manifest schema parity", () => {
  it("exposes runtime routing controls with matching important bounds/defaults", async () => {
    const manifest = JSON.parse(await readFile(new URL("../openclaw.plugin.json", import.meta.url), "utf8"));
    const rootProps = asRecord(asRecord(manifest.configSchema).properties);
    const routing = asRecord(rootProps.resourceRouting);
    const props = asRecord(routing.properties);

    expect(props.enabled.default).toBe(false);
    expect(props.logDecisions.type).toBe("boolean");

    const embeddingProps = asRecord(asRecord(props.embedding).properties);
    expect(embeddingProps.cacheKey.type).toBe("string");
    expect(embeddingProps.dimensions.maximum).toBe(65_536);

    const retrievalProps = asRecord(asRecord(props.retrieval).properties);
    expect(retrievalProps.topK.minimum).toBe(1);
    expect(retrievalProps.topK.maximum).toBe(RESOURCE_ROUTING_CONFIG_DEFAULTS.maxTopK);
    expect(retrievalProps.minScore.minimum).toBe(-1);
    expect(retrievalProps.minScore.maximum).toBe(1);
    expect(retrievalProps.rerankBelowMargin.maximum).toBe(2);
  });
});
