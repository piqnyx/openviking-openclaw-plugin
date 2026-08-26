import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  OPENVIKING_CONFIG_KEYS,
  OPENVIKING_RERANK_KEYS,
  memoryOpenVikingConfigSchema,
} from "../config.js";

/**
 * The manifest and the parser have to name the same options.
 *
 * They are two separate gates and a key missing from either one stops the plugin
 * loading -- with different wording, from different code, which is what made the
 * second failure look like a new problem rather than the same one. Whichever
 * list an option is added to, this fails until it is in both.
 */
const manifest = JSON.parse(
  readFileSync(fileURLToPath(new URL("../openclaw.plugin.json", import.meta.url)), "utf8"),
) as { configSchema: { properties: Record<string, { properties?: Record<string, unknown> }> } };

// Peeled off the base config by the outer parser before it ever sees it, so it
// is declared in the manifest and rightly absent from the list below.
const PARSED_ELSEWHERE = ["resourceRouting"];

describe("config keys", () => {
  it("the manifest and the parser accept the same options", () => {
    const declared = Object.keys(manifest.configSchema.properties)
      .filter((key) => !PARSED_ELSEWHERE.includes(key)).sort();
    expect(declared).toEqual([...OPENVIKING_CONFIG_KEYS].sort());
  });

  it("the reranker's own keys agree too", () => {
    const declared = Object.keys(manifest.configSchema.properties.recallRerank.properties ?? {}).sort();
    expect(declared).toEqual([...OPENVIKING_RERANK_KEYS].sort());
  });

  it("accepts the reranker block the gateway refused", () => {
    const cfg = memoryOpenVikingConfigSchema.parse({
      recallRerank: { enabled: true, model: "cohere/rerank-v3.5", floor: 0.3, keep: 5 },
    });
    expect(cfg.recallRerank.enabled).toBe(true);
    expect(cfg.recallRerank.candidates).toBe(50);
  });

  it("still catches a typo inside the reranker block", () => {
    expect(() => memoryOpenVikingConfigSchema.parse({ recallRerank: { enabled: true, flooor: 0.3 } }))
      .toThrow(/recallRerank has unknown keys: flooor/);
  });
});
