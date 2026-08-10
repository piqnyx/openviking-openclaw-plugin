import { describe, expect, it } from "vitest";

import { openVikingPluginConfigSchema } from "../plugin-config.js";

describe("openVikingPluginConfigSchema", () => {
  it("preserves existing OpenViking defaults and adds disabled resource routing defaults", () => {
    const cfg = openVikingPluginConfigSchema.parse({
      peer_role: "none",
      enableAddResourceTool: true,
    });

    expect(cfg.peer_role).toBe("none");
    expect(cfg.enableAddResourceTool).toBe(true);
    expect(cfg.resourceRouting.enabled).toBe(false);
    expect(cfg.resourceRouting.taxonomyFile).toBe("~/.openclaw/{agentId}.yaml");
    expect(cfg.resourceRouting.embedding.dimensions).toBe(1024);
  });

  it("accepts resourceRouting without weakening the strict base config parser", () => {
    const cfg = openVikingPluginConfigSchema.parse({
      peer_role: "none",
      resourceRouting: {
        enabled: true,
        embedding: {
          baseUrl: "http://127.0.0.1:18081",
          model: "custom-embed",
          dimensions: 768,
        },
        retrieval: {
          topK: 3,
          minScore: 0.5,
          rerankBelowMargin: 0.08,
        },
      },
    });

    expect(cfg.resourceRouting.enabled).toBe(true);
    expect(cfg.resourceRouting.embedding.model).toBe("custom-embed");
    expect(cfg.resourceRouting.embedding.dimensions).toBe(768);
    expect(cfg.resourceRouting.retrieval.topK).toBe(3);
  });

  it("still rejects unknown top-level base config keys", () => {
    expect(() => openVikingPluginConfigSchema.parse({
      resourceRouting: {},
      inventedOption: true,
    })).toThrow(/openviking config has unknown keys: inventedOption/);
  });

  it("keeps resourceRouting strict at its own boundary", () => {
    expect(() => openVikingPluginConfigSchema.parse({
      resourceRouting: { inventedOption: true },
    })).toThrow(/resourceRouting has unknown keys: inventedOption/);
  });
});
