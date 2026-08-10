import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { memoryOpenVikingConfigSchema } from "../config.js";

describe("OpenViking root config resourceRouting integration", () => {
  it("parses resourceRouting through the existing plugin config", () => {
    const cfg = memoryOpenVikingConfigSchema.parse({
      resourceRouting: {
        enabled: true,
        fallbackCategory: "inbox",
        retrieval: { topK: 3, minScore: 0.5, rerankBelowMargin: 0.07 },
      },
    });

    expect(cfg.resourceRouting.enabled).toBe(true);
    expect(cfg.resourceRouting.fallbackCategory).toBe("inbox");
    expect(cfg.resourceRouting.retrieval).toEqual({
      topK: 3,
      minScore: 0.5,
      rerankBelowMargin: 0.07,
    });
  });

  it("publishes resourceRouting in the OpenClaw plugin config schema", async () => {
    const manifest = JSON.parse(await readFile(new URL("../openclaw.plugin.json", import.meta.url), "utf8"));
    const schema = manifest.configSchema.properties.resourceRouting;
    expect(schema.type).toBe("object");
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.embedding.properties.baseUrl.type).toBe("string");
    expect(schema.properties.reranker.properties.model.type).toBe("string");
    expect(schema.properties.retrieval.properties.minScore.type).toBe("number");
  });
});
