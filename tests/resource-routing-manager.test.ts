import { describe, expect, it, vi } from "vitest";

import { parseResourceRoutingConfig } from "../resource-routing/config.js";
import { ResourceRoutingManager } from "../resource-routing/manager.js";
import { parseResourceTaxonomy } from "../resource-routing/taxonomy.js";
import type { PreparedAgentResourceRoutingState } from "../resource-routing/state.js";

function taxonomy() {
  return parseResourceTaxonomy({
    schemaVersion: 1,
    categories: {
      inbox: { segment: "__INBOX__", description: "Unclassified resources." },
      docs: { segment: "documents", description: "General documents." },
    },
  });
}

function state(agentId: string): PreparedAgentResourceRoutingState {
  return {
    agentId,
    taxonomy: taxonomy(),
    taxonomyHash: `hash-${agentId}`,
    embeddings: new Map([
      ["inbox", [0, 1]],
      ["docs", [1, 0]],
    ]),
    paths: {
      taxonomyFile: `/tmp/${agentId}.yaml`,
      cacheFile: `/tmp/${agentId}.json`,
      auditFile: `/tmp/${agentId}.jsonl`,
    },
    cache: { rebuilt: false },
  };
}

describe("ResourceRoutingManager", () => {
  it("keeps prepared state isolated per agent and initializes known agents sequentially", async () => {
    const cfg = parseResourceRoutingConfig({ enabled: true, embedding: { dimensions: 2 } });
    const order: string[] = [];
    const prepareState = vi.fn(async (_cfg, agentId: string) => {
      order.push(`start:${agentId}`);
      await Promise.resolve();
      order.push(`end:${agentId}`);
      return state(agentId);
    });
    const logger = { info: vi.fn(), warn: vi.fn() };
    const manager = new ResourceRoutingManager(cfg, logger, { prepareState });

    const result = await manager.initializeKnownAgents(["main", "igor", "main"]);
    expect(result.map((entry) => entry.agentId)).toEqual(["igor", "main"]);
    expect(result.every((entry) => entry.ok)).toBe(true);
    expect(order).toEqual(["start:igor", "end:igor", "start:main", "end:main"]);
    expect(prepareState).toHaveBeenCalledTimes(2);

    expect((await manager.getAgentState("main")).agentId).toBe("main");
    expect((await manager.getAgentState("igor")).agentId).toBe("igor");
    expect(prepareState).toHaveBeenCalledTimes(2);
  });

  it("does not let one agent's taxonomy failure disable another agent", async () => {
    const cfg = parseResourceRoutingConfig({ enabled: true, embedding: { dimensions: 2 } });
    const prepareState = vi.fn(async (_cfg, agentId: string) => {
      if (agentId === "igor") {
        throw new Error("igor taxonomy missing");
      }
      return state(agentId);
    });
    const logger = { info: vi.fn(), warn: vi.fn() };
    const manager = new ResourceRoutingManager(cfg, logger, { prepareState });

    const result = await manager.initializeKnownAgents(["igor", "main"]);
    expect(result).toEqual([
      { agentId: "igor", ok: false, error: "igor taxonomy missing" },
      { agentId: "main", ok: true, cacheRebuilt: false },
    ]);
    expect((await manager.getAgentState("main")).agentId).toBe("main");
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("igor taxonomy missing"));
  });

  it("drops a failed state promise so infrastructure can recover on a later call", async () => {
    const cfg = parseResourceRoutingConfig({ enabled: true, embedding: { dimensions: 2 } });
    let attempts = 0;
    const prepareState = vi.fn(async (_cfg, agentId: string) => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("embedder temporarily unavailable");
      }
      return state(agentId);
    });
    const manager = new ResourceRoutingManager(cfg, { info: vi.fn(), warn: vi.fn() }, { prepareState });

    await expect(manager.getAgentState("main")).rejects.toThrow("temporarily unavailable");
    await expect(manager.getAgentState("main")).resolves.toMatchObject({ agentId: "main" });
    expect(prepareState).toHaveBeenCalledTimes(2);
  });

  it("resolves an explicit category from taxonomy without requiring embedder/cache state", async () => {
    const cfg = parseResourceRoutingConfig({ enabled: true, embedding: { dimensions: 2 } });
    const prepareState = vi.fn(async () => {
      throw new Error("embedder is down");
    });
    const loadTaxonomy = vi.fn(async () => taxonomy());
    const manager = new ResourceRoutingManager(
      cfg,
      { info: vi.fn(), warn: vi.fn() },
      { prepareState, loadTaxonomy },
    );

    await expect(manager.resolveCategory("main", "docs")).resolves.toEqual({
      categoryKey: "docs",
      categoryUri: "viking://resources/documents",
    });
    expect(loadTaxonomy).toHaveBeenCalledOnce();
    expect(prepareState).not.toHaveBeenCalled();
  });

  it("caches explicit taxonomy per agent for restart-only semantics", async () => {
    const cfg = parseResourceRoutingConfig({ enabled: true, embedding: { dimensions: 2 } });
    const loadTaxonomy = vi.fn(async () => taxonomy());
    const manager = new ResourceRoutingManager(
      cfg,
      { info: vi.fn(), warn: vi.fn() },
      { loadTaxonomy },
    );

    await manager.resolveCategory("main", "docs");
    await manager.resolveCategory("main", "inbox");
    expect(loadTaxonomy).toHaveBeenCalledOnce();
  });
});
