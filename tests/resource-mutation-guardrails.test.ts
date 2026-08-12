import { describe, expect, it, vi } from "vitest";

import { registerOpenVikingImportTools } from "../plugin/openviking-import-tools.js";

type ToolFactory = (ctx: Record<string, unknown>) => {
  name: string;
  parameters: { properties?: Record<string, unknown> };
  execute: (id: string, params: Record<string, unknown>) => Promise<unknown>;
};

function category(key: string, path: string, routeable = true) {
  return {
    key,
    segment: path.split("/").at(-1) ?? key,
    description: key,
    distinguishFrom: [],
    routeable,
    uri: `viking://resources/${path}`,
    path,
    embeddingText: key,
    rerankText: key,
    parentKey: null,
    depth: path.split("/").length,
  };
}

function setup() {
  const factories = new Map<string, ToolFactory>();
  const removeResource = vi.fn(async () => ({
    uri: "viking://resources/docs/guides/howtos/postgres",
    estimated_deleted_count: 1,
    semantic_status: "queued",
  }));
  const resolveCategoryOrFallback = vi.fn((_agentId: string, selector: string) => {
    if (selector === "docs/guides/howtos") {
      return {
        requested: selector,
        category: category("docs-guides-howtos", selector),
        matchedBy: "path" as const,
        fallback: false,
      };
    }
    if (selector === "docs") {
      return {
        requested: selector,
        category: category("inbox", "_INBOX"),
        matchedBy: "fallback" as const,
        fallback: true,
        fallbackReason: "organizational_category" as const,
      };
    }
    return {
      requested: selector,
      category: category("inbox", "_INBOX"),
      matchedBy: "fallback" as const,
      fallback: true,
      fallbackReason: "unknown_category" as const,
    };
  });

  registerOpenVikingImportTools({
    registerTool: (factory, meta) => factories.set(meta.name, factory as ToolFactory),
    getClient: vi.fn(async () => ({
      addResource: vi.fn(),
      addSkill: vi.fn(),
      removeResource,
    })),
    resolvePluginSessionRouting: () => ({ agentId: "main", actorPeerId: "main_peer" }),
    isBypassedSession: () => false,
    makeBypassedToolResult: vi.fn(),
    enableAddResourceTool: false,
    enableRemoveResourceTool: true,
    resourceRouting: {
      enabled: true,
      summaryLanguage: "ru",
      resolveCategoryOrFallback,
      routeAutomatic: vi.fn(async () => { throw new Error("not used"); }),
    },
  });

  return { factories, removeResource };
}

describe("agent resource mutation guardrails", () => {
  it.each([
    "viking://resources/docs/guides/howtos",
    "viking://resources/docs",
  ])("rejects exact taxonomy category/container URI %s", async (uri) => {
    const { factories, removeResource } = setup();
    const result = await factories.get("remove_resource")!({}).execute("call", { uri }) as {
      details?: Record<string, unknown>;
    };
    expect(result.details).toMatchObject({ action: "rejected", protectedCategory: true });
    expect(removeResource).not.toHaveBeenCalled();
  });

  it("allows a specific imported resource below a protected category", async () => {
    const { factories, removeResource } = setup();
    await factories.get("remove_resource")!({}).execute("call", {
      uri: "viking://resources/docs/guides/howtos/postgres",
      recursive: true,
    });
    expect(removeResource).toHaveBeenCalledWith({
      uri: "viking://resources/docs/guides/howtos/postgres",
      recursive: false,
      wait: false,
    }, "main_peer");
  });
});
