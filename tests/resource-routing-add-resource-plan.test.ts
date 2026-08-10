import { describe, expect, it, vi } from "vitest";

import { ResourceRoutingCategoryError } from "../resource-routing/manager.js";

import {
  AddResourceRoutingError,
  planAddResourceRouting,
  type AddResourceRoutingManager,
} from "../resource-routing/add-resource-plan.js";

function manager(overrides: Partial<AddResourceRoutingManager> = {}): AddResourceRoutingManager {
  return {
    isEnabled: () => true,
    resolveCategory: vi.fn(async (_agentId: string, categoryKey: string) => ({
      categoryKey,
      categoryUri: `viking://resources/trusted/${categoryKey}`,
    })),
    routeResource: vi.fn(async () => ({
      categoryKey: "docs",
      categoryUri: "viking://resources/documents",
      fallback: false,
      embeddingTop: [{ key: "docs", uri: "viking://resources/documents", score: 0.9 }],
      rerankerUsed: false,
      timingMs: { embedding: 1, total: 1 },
    })),
    ...overrides,
  };
}

describe("add_resource routing planner", () => {
  it("gives legacy explicit targets priority over category/automatic routing without rewriting them", async () => {
    const routing = manager();
    const explicitTo = await planAddResourceRouting({
      agentId: "main",
      manager: routing,
      params: {
        source: "/workspace/draft/a.md",
        to: "viking://resources/exact",
        parent: "viking://resources/conflicting-parent",
        category: "ignored-category",
      },
    });
    expect(explicitTo.details.mode).toBe("explicit-to");
    expect(explicitTo.input).toMatchObject({
      to: "viking://resources/exact",
      parent: "viking://resources/conflicting-parent",
    });
    expect(routing.resolveCategory).not.toHaveBeenCalled();
    expect(routing.routeResource).not.toHaveBeenCalled();

    const explicitParent = await planAddResourceRouting({
      agentId: "main",
      manager: routing,
      params: {
        source: "/workspace/draft/a.md",
        parent: "viking://resources/manual",
        category: "ignored-category",
        createParent: true,
      },
    });
    expect(explicitParent.details.mode).toBe("explicit-parent");
    expect(explicitParent.input).toMatchObject({
      parent: "viking://resources/manual",
      createParent: true,
    });
    expect(routing.resolveCategory).not.toHaveBeenCalled();
  });

  it("resolves explicit semantic category to a trusted plugin URI without ML", async () => {
    const routing = manager();
    const plan = await planAddResourceRouting({
      agentId: "igor",
      manager: routing,
      params: {
        source: "/workspace/draft/a.md",
        category: "project-openviking",
      },
    });

    expect(plan.details).toMatchObject({
      mode: "explicit-category",
      categoryKey: "project-openviking",
      parentUri: "viking://resources/trusted/project-openviking",
    });
    expect(plan.input).toMatchObject({
      parent: "viking://resources/trusted/project-openviking",
      createParent: true,
    });
    expect(routing.resolveCategory).toHaveBeenCalledWith("igor", "project-openviking");
    expect(routing.routeResource).not.toHaveBeenCalled();
  });

  it("requires summary only for automatic routing", async () => {
    const routing = manager();
    await expect(planAddResourceRouting({
      agentId: "main",
      manager: routing,
      params: { source: "/workspace/draft/a.md" },
    })).rejects.toMatchObject({
      name: "AddResourceRoutingError",
      code: "summary_required",
    });

    await expect(planAddResourceRouting({
      agentId: "main",
      manager: routing,
      params: {
        source: "/workspace/draft/a.md",
        parent: "viking://resources/manual",
      },
    })).resolves.toMatchObject({ details: { mode: "explicit-parent" } });
  });

  it("automatic routing imports to the trusted selected category and preserves fallback decisions", async () => {
    const routing = manager({
      routeResource: vi.fn(async () => ({
        categoryKey: "inbox",
        categoryUri: "viking://resources/__INBOX__",
        fallback: true,
        fallbackReason: "below-min-score" as const,
        embeddingTop: [{ key: "docs", uri: "viking://resources/documents", score: 0.4 }],
        rerankerUsed: false,
        timingMs: { embedding: 1, total: 1 },
      })),
    });

    const plan = await planAddResourceRouting({
      agentId: "main",
      manager: routing,
      params: {
        source: "/workspace/draft/joke.md",
        summary: "A disposable joke used to test resource ingestion behavior.",
        reason: "routing test",
      },
    });

    expect(plan.input).toMatchObject({
      pathOrUrl: "/workspace/draft/joke.md",
      parent: "viking://resources/__INBOX__",
      createParent: true,
      reason: "routing test",
    });
    expect(plan.details).toMatchObject({
      mode: "automatic",
      categoryKey: "inbox",
      fallback: true,
      fallbackReason: "below-min-score" as const,
    });
  });

  it("keeps legacy root behavior when resourceRouting is disabled", async () => {
    const disabled = manager({ isEnabled: () => false });
    const plan = await planAddResourceRouting({
      agentId: "main",
      manager: disabled,
      params: { source: "/workspace/draft/a.md" },
    });
    expect(plan.details.mode).toBe("legacy-root");
    expect(plan.input.parent).toBeUndefined();
    expect(plan.input.to).toBeUndefined();
  });

  it("rejects explicit category when routing is disabled", async () => {
    const disabled = manager({ isEnabled: () => false });
    await expect(planAddResourceRouting({
      agentId: "main",
      manager: disabled,
      params: { source: "/workspace/draft/a.md", category: "docs" },
    })).rejects.toMatchObject({ code: "routing_disabled" });
  });

  it("turns automatic infrastructure failure into a fail-closed routing error", async () => {
    const routing = manager({
      routeResource: vi.fn(async () => {
        throw new Error("embedder HTTP 503");
      }),
    });
    await expect(planAddResourceRouting({
      agentId: "main",
      manager: routing,
      params: {
        source: "/workspace/draft/a.md",
        summary: "An API reference document.",
      },
    })).rejects.toEqual(expect.objectContaining({
      code: "routing_infrastructure_error",
      message: expect.stringContaining("resource was not imported"),
    }));
  });

  it("wraps invalid explicit category without allowing model-generated URI fallback", async () => {
    const routing = manager({
      resolveCategory: vi.fn(async () => {
        throw new ResourceRoutingCategoryError("unknown category");
      }),
    });
    await expect(planAddResourceRouting({
      agentId: "main",
      manager: routing,
      params: {
        source: "/workspace/draft/a.md",
        category: "invented-by-model",
      },
    })).rejects.toMatchObject({
      name: "AddResourceRoutingError",
      code: "invalid_category",
    });
  });
});
