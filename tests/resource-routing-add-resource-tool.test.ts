import { describe, expect, it, vi } from "vitest";

import { registerOpenVikingImportTools } from "../plugin/openviking-import-tools.js";
import type { AddResourceInput } from "../client.js";

type ToolFactory = (ctx: Record<string, unknown>) => {
  name: string;
  description: string;
  parameters: { properties?: Record<string, unknown> };
  execute: (id: string, params: Record<string, unknown>) => Promise<unknown>;
};

function setup(options: {
  routingEnabled?: boolean;
  routeFailure?: Error;
} = {}) {
  const factories = new Map<string, ToolFactory>();
  const addResource = vi.fn(async (input: AddResourceInput) => ({
    root_uri: input.to ?? input.parent ?? "viking://resources/file.md",
    status: "success",
  }));
  const getClient = vi.fn(async () => ({
    addResource,
    removeResource: vi.fn(),
    addSkill: vi.fn(),
  }));
  const resolveCategory = vi.fn(async (_agentId: string, key: string) => ({
    categoryKey: key,
    categoryUri: `viking://resources/trusted/${key}`,
  }));
  const routeResource = options.routeFailure
    ? vi.fn(async () => { throw options.routeFailure; })
    : vi.fn(async () => ({
        categoryKey: "docs",
        categoryUri: "viking://resources/documents",
        fallback: false,
        embeddingTop: [{ key: "docs", uri: "viking://resources/documents", score: 0.91 }],
        rerankerUsed: false,
      }));

  registerOpenVikingImportTools({
    registerTool: (factory, meta) => factories.set(meta.name, factory as ToolFactory),
    getClient,
    resolvePluginSessionRouting: () => ({ agentId: "main", actorPeerId: "main_peer" }),
    isBypassedSession: () => false,
    makeBypassedToolResult: vi.fn(),
    enableAddResourceTool: true,
    enableRemoveResourceTool: false,
    resourceRoutingManager: {
      isEnabled: () => options.routingEnabled !== false,
      resolveCategory,
      routeResource,
    },
  });

  return { factories, addResource, getClient, resolveCategory, routeResource };
}

describe("routed add_resource tool", () => {
  it("keeps source as the top-level local-input selector and exposes routing hints", () => {
    const { factories } = setup();
    const tool = factories.get("add_resource")!({ agentId: "main" });
    expect(Object.keys(tool.parameters.properties ?? {})).toEqual([
      "source",
      "to",
      "parent",
      "category",
      "summary",
      "create_parent",
      "reason",
      "instruction",
      "wait",
      "timeout",
    ]);
    expect(tool.description).toContain("one short sentence");
    expect(tool.description).toContain("Do not invent category names");
  });

  it("returns an actionable summary error before opening an OpenViking client", async () => {
    const { factories, addResource, getClient } = setup();
    const tool = factories.get("add_resource")!({ agentId: "main" });
    const result = await tool.execute("call-1", {
      source: "/workspace/draft/file.md",
    }) as { content?: Array<{ text?: string }>; details?: Record<string, unknown> };

    expect(result.details).toMatchObject({
      action: "resource_routing_rejected",
      code: "summary_required",
    });
    expect(result.content?.[0]?.text).toContain("retry add_resource");
    expect(getClient).not.toHaveBeenCalled();
    expect(addResource).not.toHaveBeenCalled();
  });

  it("routes automatically to trusted parent with createParent=true", async () => {
    const { factories, addResource, routeResource } = setup();
    const tool = factories.get("add_resource")!({ agentId: "main" });
    const result = await tool.execute("call-1", {
      source: "/workspace/draft/file.md",
      summary: "Reference documentation explaining an HTTP API.",
      wait: true,
    }) as { details?: Record<string, unknown> };

    expect(routeResource).toHaveBeenCalledWith("main", expect.objectContaining({
      summary: "Reference documentation explaining an HTTP API.",
      source: "/workspace/draft/file.md",
    }));
    expect(addResource).toHaveBeenCalledWith({
      pathOrUrl: "/workspace/draft/file.md",
      parent: "viking://resources/documents",
      createParent: true,
      reason: undefined,
      instruction: undefined,
      wait: true,
      timeout: undefined,
    }, "main_peer");
    expect(result.details).toMatchObject({
      action: "resource_imported",
      routing: {
        mode: "automatic",
        categoryKey: "docs",
        parentUri: "viking://resources/documents",
        fallback: false,
      },
    });
  });

  it("uses explicit to without summary or classifier calls", async () => {
    const { factories, addResource, resolveCategory, routeResource } = setup();
    const tool = factories.get("add_resource")!({ agentId: "main" });
    await tool.execute("call-1", {
      source: "/workspace/draft/file.md",
      to: "viking://resources/manual/file.md",
      category: "ignored",
    });

    expect(resolveCategory).not.toHaveBeenCalled();
    expect(routeResource).not.toHaveBeenCalled();
    expect(addResource).toHaveBeenCalledWith(expect.objectContaining({
      pathOrUrl: "/workspace/draft/file.md",
      to: "viking://resources/manual/file.md",
    }), "main_peer");
  });

  it("fails closed on automatic routing infrastructure error", async () => {
    const { factories, addResource, getClient } = setup({
      routeFailure: new Error("embedding service HTTP 503"),
    });
    const tool = factories.get("add_resource")!({ agentId: "main" });
    const result = await tool.execute("call-1", {
      source: "/workspace/draft/file.md",
      summary: "Reference documentation explaining an HTTP API.",
    }) as { details?: Record<string, unknown>; content?: Array<{ text?: string }> };

    expect(result.details).toMatchObject({
      action: "resource_routing_failed",
      code: "routing_infrastructure_error",
    });
    expect(result.content?.[0]?.text).toContain("resource was not imported");
    expect(getClient).not.toHaveBeenCalled();
    expect(addResource).not.toHaveBeenCalled();
  });
});
