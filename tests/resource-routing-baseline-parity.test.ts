import { describe, expect, it, vi } from "vitest";

import { planAddResourceRouting, type AddResourceRoutingManager } from "../resource-routing/add-resource-plan.js";

function manager(enabled: boolean): AddResourceRoutingManager {
  return {
    isEnabled: () => enabled,
    resolveCategory: vi.fn(async () => ({
      categoryKey: "docs",
      categoryUri: "viking://resources/docs",
    })),
    routeResource: vi.fn(async () => ({
      categoryKey: "docs",
      categoryUri: "viking://resources/docs",
      fallback: false,
      embeddingTop: [],
      rerankerUsed: false,
      timingMs: { embedding: 0, total: 0 },
    })),
  };
}

describe("add_resource baseline parity", () => {
  it("preserves every pre-routing field exactly when resource routing is disabled", async () => {
    const routing = manager(false);
    const plan = await planAddResourceRouting({
      agentId: "main",
      manager: routing,
      params: {
        source: " /workspace/draft/report.md ",
        reason: " reason with spaces ",
        instruction: " instruction with spaces ",
        wait: false,
        timeout: 123,
      },
    });

    expect(plan.details.mode).toBe("legacy-root");
    expect(plan.input).toEqual({
      pathOrUrl: " /workspace/draft/report.md ",
      reason: " reason with spaces ",
      instruction: " instruction with spaces ",
      wait: false,
      timeout: 123,
    });
    expect(routing.resolveCategory).not.toHaveBeenCalled();
    expect(routing.routeResource).not.toHaveBeenCalled();
  });

  it("does not add a new whitespace-only source rejection to the disabled legacy path", async () => {
    const routing = manager(false);
    const plan = await planAddResourceRouting({
      agentId: "main",
      manager: routing,
      params: { source: "   " },
    });

    expect(plan.details.mode).toBe("legacy-root");
    expect(plan.input.pathOrUrl).toBe("   ");
    expect(routing.resolveCategory).not.toHaveBeenCalled();
    expect(routing.routeResource).not.toHaveBeenCalled();
  });

  it("does not silently rewrite the legacy to+parent conflict", async () => {
    const routing = manager(true);
    const plan = await planAddResourceRouting({
      agentId: "main",
      manager: routing,
      params: {
        source: "/workspace/draft/report.md",
        to: " viking://resources/exact ",
        parent: " viking://resources/parent ",
        createParent: true,
        category: "docs",
        summary: "This must not trigger automatic routing.",
      },
    });

    expect(plan.details.mode).toBe("explicit-to");
    expect(plan.input).toMatchObject({
      pathOrUrl: "/workspace/draft/report.md",
      to: " viking://resources/exact ",
      parent: " viking://resources/parent ",
      createParent: true,
    });
    expect(routing.resolveCategory).not.toHaveBeenCalled();
    expect(routing.routeResource).not.toHaveBeenCalled();
  });

  it("keeps a legacy explicit parent exact while allowing create_parent parity", async () => {
    const plan = await planAddResourceRouting({
      agentId: "main",
      manager: manager(true),
      params: {
        source: "/workspace/draft/report.md",
        parent: " viking://resources/manual ",
        createParent: false,
      },
    });

    expect(plan.details).toEqual({
      mode: "explicit-parent",
      parentUri: " viking://resources/manual ",
    });
    expect(plan.input.parent).toBe(" viking://resources/manual ");
    expect(plan.input.createParent).toBe(false);
  });
});
