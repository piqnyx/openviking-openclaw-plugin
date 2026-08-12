import { describe, expect, it, vi } from "vitest";

import {
  isRussianSemanticSummary,
  registerOpenVikingImportTools,
} from "../plugin/openviking-import-tools.js";

type ToolFactory = (ctx: Record<string, unknown>) => {
  name: string;
  description: string;
  parameters: { properties?: Record<string, unknown> };
  execute: (id: string, params: Record<string, unknown>) => Promise<unknown>;
};

function makeCategory(key: string, path: string) {
  const uri = `viking://resources/${path}`;
  const segments = path.split("/");
  const description = `${key} category`;
  return {
    key,
    segment: segments.at(-1) ?? key,
    description,
    distinguishFrom: [],
    routeable: true,
    uri,
    path,
    embeddingText: `description: ${description}\npath: ${path}`,
    rerankText: `description: ${description}\npath: ${path}`,
    parentKey: null,
    depth: segments.length,
  };
}

function setup(options: {
  routingEnabled?: boolean;
  routeFailure?: Error;
  explicitFallback?: boolean;
  summaryLanguage?: "any" | "ru";
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
  const resolveCategoryOrFallback = vi.fn((_agentId: string, selector: string) => {
    if (options.explicitFallback) {
      return {
        requested: selector,
        category: makeCategory("inbox", "_INBOX"),
        matchedBy: "fallback" as const,
        fallback: true,
        fallbackReason: "unknown_category" as const,
      };
    }
    return {
      requested: selector,
      category: makeCategory("code-source-javascript", "code/source/javascript"),
      matchedBy: selector.includes("/") ? "path" as const : "key" as const,
      fallback: false,
    };
  });
  const routeAutomatic = options.routeFailure
    ? vi.fn(async () => { throw options.routeFailure; })
    : vi.fn(async () => ({
      category: makeCategory("docs-guides-howtos", "docs/guides/howtos"),
      semanticInput: "Практическое руководство по настройке OpenClaw.",
      decision: {
        categoryKey: "docs-guides-howtos",
        uri: "viking://resources/docs/guides/howtos",
        fallback: false,
        embeddingCandidates: [
          { key: "docs-guides-howtos", path: "docs/guides/howtos", embeddingText: "Практические инструкции", rerankText: "Практические инструкции", score: 0.82 },
          { key: "docs-guides-tutorials", path: "docs/guides/tutorials", embeddingText: "Учебные руководства", rerankText: "Учебные руководства", score: 0.79 },
        ],
        rerankerUsed: true,
        rerankerScores: [
          { key: "docs-guides-howtos", path: "docs/guides/howtos", score: 0.91 },
          { key: "docs-guides-tutorials", path: "docs/guides/tutorials", score: 0.72 },
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
      summaryLanguage: options.summaryLanguage ?? "ru",
      resolveCategoryOrFallback,
      routeAutomatic,
    },
  });

  return {
    factories,
    addResource,
    getClient,
    resolveCategoryOrFallback,
    routeAutomatic,
  };
}

describe("Russian automatic-routing summary validation", () => {
  it("accepts Russian semantic text containing technical Latin identifiers", () => {
    expect(isRussianSemanticSummary(
      "Практическое руководство по настройке OpenClaw API и JavaScript-клиента.",
    )).toBe(true);
  });

  it("rejects English-only and token-Cyrillic summaries", () => {
    expect(isRussianSemanticSummary("A practical setup guide for OpenClaw API.")).toBe(false);
    expect(isRussianSemanticSummary("JavaScript deployment guide а")).toBe(false);
  });
});

describe("add_resource routing tool", () => {
  it("publishes only the minimal deterministic agent contract", () => {
    const tool = setup().factories.get("add_resource")!({});
    expect(Object.keys(tool.parameters.properties ?? {})).toEqual([
      "source",
      "summary",
      "category",
    ]);
  });

  it("requires summary for automatic routing before touching models or OpenViking", async () => {
    const { factories, routeAutomatic, getClient } = setup();
    const result = await factories.get("add_resource")!({}).execute("call", {
      source: "/workspace/guide.md",
    }) as { details?: { action?: string } };
    expect(result.details?.action).toBe("rejected");
    expect(routeAutomatic).not.toHaveBeenCalled();
    expect(getClient).not.toHaveBeenCalled();
  });

  it("rejects English-only and token-Cyrillic automatic summaries before models", async () => {
    const { factories, routeAutomatic, getClient } = setup();
    for (const summary of [
      "A practical setup guide for configuring OpenClaw.",
      "JavaScript deployment guide а",
    ]) {
      const result = await factories.get("add_resource")!({}).execute("call", {
        source: "/workspace/guide.md",
        summary,
      }) as { details?: Record<string, unknown> };
      expect(result.details).toMatchObject({ action: "rejected", summaryLanguage: "ru" });
    }
    expect(routeAutomatic).not.toHaveBeenCalled();
    expect(getClient).not.toHaveBeenCalled();
  });

  it("allows an unrestricted-language taxonomy to route a non-Russian summary", async () => {
    const { factories, routeAutomatic } = setup({ summaryLanguage: "any" });
    const summary = "A practical guide to configuring OpenClaw services.";
    await factories.get("add_resource")!({}).execute("call", {
      source: "/workspace/guide.md",
      summary,
    });
    expect(routeAutomatic).toHaveBeenCalledWith(expect.objectContaining({ summary }));
  });

  it("publishes provenance guidance for categories where source form is semantic", () => {
    const tool = setup().factories.get("add_resource")!({});
    expect(tool.description).toContain("batch scraping or crawling result");
    expect(tool.description).toContain("exported chat or forum history");
    expect(tool.description).toContain("database dump");
  });

  it("routes a Russian summary automatically and forwards only a trusted parent", async () => {
    const { factories, routeAutomatic, addResource } = setup();
    const summary = "Практическое руководство по настройке OpenClaw и его основных параметров.";
    const result = await factories.get("add_resource")!({}).execute("call", {
      source: "/workspace/draft/guide.md",
      summary,
    }) as { details?: Record<string, unknown> };

    expect(routeAutomatic).toHaveBeenCalledWith(expect.objectContaining({
      agentId: "main",
      source: "/workspace/draft/guide.md",
      sourceKind: "local_path",
      filename: "guide.md",
      extension: "md",
      summary,
    }));
    expect(addResource).toHaveBeenCalledWith({
      pathOrUrl: "/workspace/draft/guide.md",
      parent: "viking://resources/docs/guides/howtos",
      createParent: true,
      wait: false,
    }, "main_peer");
    expect(result.details).toMatchObject({
      action: "resource_import_accepted",
      processing: "asynchronous",
      task_id: "task-resource-1",
      routing: {
        mode: "automatic",
        category: "docs-guides-howtos",
        categoryPath: "docs/guides/howtos",
        fallback: false,
        rerankerUsed: true,
      },
    });
  });

  it("resolves an explicit full taxonomy path without invoking automatic models", async () => {
    const { factories, resolveCategoryOrFallback, routeAutomatic, addResource } = setup();
    const result = await factories.get("add_resource")!({}).execute("call", {
      source: "/workspace/main.js",
      category: "code/source/javascript",
    }) as { details?: Record<string, unknown> };

    expect(resolveCategoryOrFallback).toHaveBeenCalledWith("main", "code/source/javascript");
    expect(routeAutomatic).not.toHaveBeenCalled();
    expect(addResource).toHaveBeenCalledWith({
      pathOrUrl: "/workspace/main.js",
      parent: "viking://resources/code/source/javascript",
      createParent: true,
      wait: false,
    }, "main_peer");
    expect(result.details?.routing).toMatchObject({
      mode: "explicit_category",
      requestedCategory: "code/source/javascript",
      matchedBy: "path",
      categoryPath: "code/source/javascript",
      fallback: false,
    });
  });

  it("imports an unknown explicit category into fallback inbox instead of losing the resource", async () => {
    const { factories, resolveCategoryOrFallback, routeAutomatic, addResource } = setup({
      explicitFallback: true,
    });
    const result = await factories.get("add_resource")!({}).execute("call", {
      source: "/workspace/unknown.md",
      category: "code/source/javascrpit",
    }) as { details?: Record<string, unknown> };

    expect(resolveCategoryOrFallback).toHaveBeenCalledWith("main", "code/source/javascrpit");
    expect(routeAutomatic).not.toHaveBeenCalled();
    expect(addResource).toHaveBeenCalledWith({
      pathOrUrl: "/workspace/unknown.md",
      parent: "viking://resources/_INBOX",
      createParent: true,
      wait: false,
    }, "main_peer");
    expect(result.details?.routing).toMatchObject({
      mode: "explicit_category",
      requestedCategory: "code/source/javascrpit",
      matchedBy: "fallback",
      category: "inbox",
      categoryPath: "_INBOX",
      fallback: true,
      fallbackReason: "unknown_category",
    });
  });

  it("returns outcome unknown instead of encouraging an automatic retry after transport failure", async () => {
    const { factories, addResource } = setup();
    addResource.mockRejectedValueOnce(
      Object.assign(new Error("The operation was aborted"), { name: "AbortError" }),
    );
    const result = await factories.get("add_resource")!({}).execute("call", {
      source: "/workspace/guide.md",
      summary: "Практическое руководство по настройке программного сервиса.",
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
      summary: "Практическое руководство по настройке программного сервиса.",
    }) as { details?: { action?: string }; content?: Array<{ text?: string }> };
    expect(result.details?.action).toBe("routing_failed");
    expect(result.content?.[0]?.text).toContain("resource was NOT imported");
    expect(result.content?.[0]?.text).toContain("embedder HTTP 503");
    expect(getClient).not.toHaveBeenCalled();
  });

  it("keeps legacy source-only import when resource routing is disabled", async () => {
    const { factories, routeAutomatic, addResource } = setup({ routingEnabled: false });
    await factories.get("add_resource")!({}).execute("call", {
      source: "/workspace/legacy.md",
    });
    expect(routeAutomatic).not.toHaveBeenCalled();
    expect(addResource).toHaveBeenCalledWith({
      pathOrUrl: "/workspace/legacy.md",
      parent: undefined,
      createParent: undefined,
      wait: false,
    }, "main_peer");
  });

  it("rejects an explicit category while semantic routing is disabled", async () => {
    const { factories, getClient } = setup({ routingEnabled: false });
    const result = await factories.get("add_resource")!({}).execute("call", {
      source: "/workspace/a.md",
      category: "docs/guides/howtos",
    }) as { details?: { action?: string } };
    expect(result.details?.action).toBe("rejected");
    expect(getClient).not.toHaveBeenCalled();
  });
});
