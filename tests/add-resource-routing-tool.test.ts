import { describe, expect, it, vi } from "vitest";

import { registerOpenVikingImportTools } from "../plugin/openviking-import-tools.js";

type ToolFactory = (ctx: Record<string, unknown>) => {
  name: string;
  parameters: { properties?: Record<string, unknown> };
  execute: (id: string, params: Record<string, unknown>) => Promise<unknown>;
};

function makeCategory(key: string, uri: string) {
  const segments = uri.split("/");
  const path = uri.replace(/^viking:\/\/resources\/?/, "");
  const description = `${key} category`;
  return {
    key,
    segment: segments.at(-1) ?? key,
    description,
    routeable: true,
    uri,
    path,
    routingText: `description: ${description}\npath: ${path}`,
    parentKey: null,
    depth: 1,
  };
}

function setup(options: {
  routingEnabled?: boolean;
  routeFailure?: Error;
} = {}) {
  const factories = new Map<string, ToolFactory>();
  const addResource = vi.fn(async () => ({
    status: "success",
    root_uri: "viking://resources/result",
    task_id: "task-resource-1",
  }));
  const getClient = vi.fn(async () => ({
    addResource,
    removeResource: vi.fn(),
    addSkill: vi.fn(),
  }));
  const resolveCategory = vi.fn((_agentId: string, key: string) =>
    makeCategory(key, `viking://resources/${key}`));
  const routeAutomatic = options.routeFailure
    ? vi.fn(async () => { throw options.routeFailure; })
    : vi.fn(async () => ({
      category: makeCategory("documents_guides", "viking://resources/documents/guides"),
      semanticInput: "A setup guide for configuring OpenClaw.",
      decision: {
        categoryKey: "documents_guides",
        uri: "viking://resources/documents/guides",
        fallback: false,
        embeddingCandidates: [
          { key: "documents_guides", path: "documents/guides", routingText: "Guides", score: 0.82 },
          { key: "documents", path: "documents", routingText: "Documents", score: 0.79 },
        ],
        rerankerUsed: true,
        rerankerScores: [
          { key: "documents_guides", path: "documents/guides", score: 0.91 },
          { key: "documents", path: "documents", score: 0.72 },
        ],
        timing: {
          embeddingMs: 82,
          rerankerMs: 374,
          totalMs: 460,
        },
      },
    }));

  registerOpenVikingImportTools({
    registerTool: (factory, meta) => factories.set(meta.name, factory as ToolFactory),
    getClient,
    resolvePluginSessionRouting: () => ({
      agentId: "main",
      actorPeerId: "main_peer",
    }),
    isBypassedSession: () => false,
    makeBypassedToolResult: vi.fn(),
    enableAddResourceTool: true,
    enableRemoveResourceTool: false,
    resourceRouting: {
      enabled: options.routingEnabled ?? true,
      resolveCategory,
      routeAutomatic,
    },
  });

  return { factories, addResource, getClient, resolveCategory, routeAutomatic };
}

describe("add_resource routing tool", () => {
  it("publishes summary, semantic category, and create_parent instructions to the agent", () => {
    const tool = setup().factories.get("add_resource")!({});
    expect(Object.keys(tool.parameters.properties ?? {})).toEqual([
      "source",
      "summary",
      "to",
      "parent",
      "category",
      "create_parent",
      "reason",
      "instruction",
    ]);
  });

  it("requires summary for automatic routing before touching models or OpenViking", async () => {
    const { factories, routeAutomatic, getClient } = setup();
    const result = await factories.get("add_resource")!({}).execute("call", {
      source: "/workspace/guide.md",
    }) as { details?: { action?: string }; content?: Array<{ text?: string }> };
    expect(result.details?.action).toBe("rejected");
    expect(result.content?.[0]?.text).toMatch(/requires `summary`/);
    expect(routeAutomatic).not.toHaveBeenCalled();
    expect(getClient).not.toHaveBeenCalled();
  });

  it("keeps explicit to above automatic routing", async () => {
    const { factories, routeAutomatic, addResource } = setup();
    await factories.get("add_resource")!({}).execute("call", {
      source: "/workspace/guide.md",
      to: "viking://resources/manual-target",
    });
    expect(routeAutomatic).not.toHaveBeenCalled();
    expect(addResource).toHaveBeenCalledWith(expect.objectContaining({
      pathOrUrl: "/workspace/guide.md",
      to: "viking://resources/manual-target",
      parent: undefined,
    }), "main_peer");
  });

  it("resolves explicit semantic category without invoking automatic models", async () => {
    const { factories, resolveCategory, routeAutomatic, addResource } = setup();
    await factories.get("add_resource")!({}).execute("call", {
      source: "/workspace/guide.md",
      category: "documents_guides",
    });
    expect(resolveCategory).toHaveBeenCalledWith("main", "documents_guides");
    expect(routeAutomatic).not.toHaveBeenCalled();
    expect(addResource).toHaveBeenCalledWith(expect.objectContaining({
      parent: "viking://resources/documents_guides",
      createParent: true,
    }), "main_peer");
  });

  it("routes summary automatically and forwards only the trusted parent URI", async () => {
    const { factories, routeAutomatic, addResource } = setup();
    const result = await factories.get("add_resource")!({}).execute("call", {
      source: "/workspace/draft/guide.md",
      summary: "A setup guide for configuring OpenClaw.",
      wait: true,
      timeout: 1,
    }) as { details?: Record<string, unknown> };
    expect(routeAutomatic).toHaveBeenCalledWith(expect.objectContaining({
      agentId: "main",
      source: "/workspace/draft/guide.md",
      sourceKind: "local_path",
      filename: "guide.md",
      extension: "md",
      summary: "A setup guide for configuring OpenClaw.",
    }));
    expect(addResource).toHaveBeenCalledWith(expect.objectContaining({
      pathOrUrl: "/workspace/draft/guide.md",
      to: undefined,
      parent: "viking://resources/documents/guides",
      createParent: true,
      wait: false,
    }), "main_peer");
    expect(result.details).toMatchObject({
      action: "resource_import_accepted",
      processing: "asynchronous",
      task_id: "task-resource-1",
    });
    expect(result.details?.routing).toMatchObject({
      mode: "automatic",
      category: "documents_guides",
      fallback: false,
      rerankerUsed: true,
    });
  });

  it("returns outcome unknown instead of encouraging an automatic retry after transport failure", async () => {
    const { factories, addResource } = setup();
    addResource.mockRejectedValueOnce(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
    const result = await factories.get("add_resource")!({}).execute("call", {
      source: "/workspace/guide.md",
      summary: "A setup guide.",
    }) as { details?: Record<string, unknown>; content?: Array<{ text?: string }> };
    expect(result.details).toMatchObject({
      action: "resource_import_outcome_unknown",
      outcome: "unknown",
      retry_safe: false,
    });
    expect(result.content?.[0]?.text).toContain("Do not submit the same import again automatically");
  });

  it("does not import when automatic-routing infrastructure fails", async () => {
    const { factories, getClient } = setup({ routeFailure: new Error("embedder HTTP 503") });
    const result = await factories.get("add_resource")!({}).execute("call", {
      source: "/workspace/guide.md",
      summary: "A setup guide.",
    }) as { details?: { action?: string }; content?: Array<{ text?: string }> };
    expect(result.details?.action).toBe("routing_failed");
    expect(result.content?.[0]?.text).toContain("resource was NOT imported");
    expect(result.content?.[0]?.text).toContain("embedder HTTP 503");
    expect(getClient).not.toHaveBeenCalled();
  });

  it("preserves legacy add_resource behavior when routing is disabled", async () => {
    const { factories, routeAutomatic, addResource } = setup({ routingEnabled: false });
    await factories.get("add_resource")!({}).execute("call", {
      source: "/workspace/legacy.md",
    });
    expect(routeAutomatic).not.toHaveBeenCalled();
    expect(addResource).toHaveBeenCalledWith(expect.objectContaining({
      pathOrUrl: "/workspace/legacy.md",
      to: undefined,
      parent: undefined,
      createParent: undefined,
    }), "main_peer");
  });

  it("rejects conflicting explicit destinations instead of silently choosing one", async () => {
    const { factories, getClient } = setup();
    const result = await factories.get("add_resource")!({}).execute("call", {
      source: "/workspace/a.md",
      parent: "viking://resources/docs",
      category: "docs",
    }) as { details?: { action?: string } };
    expect(result.details?.action).toBe("rejected");
    expect(getClient).not.toHaveBeenCalled();
  });
});
