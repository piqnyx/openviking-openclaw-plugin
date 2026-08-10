import { describe, expect, it, vi } from "vitest";

import type { HttpTransport } from "../adapters/http-transport.js";
import { OpenVikingClient } from "../client.js";
import { memoryOpenVikingConfigSchema } from "../config.js";
import { registerOpenVikingImportTools } from "../plugin/openviking-import-tools.js";

function makeClient(transport: HttpTransport) {
  return new OpenVikingClient(
    "http://127.0.0.1:1933",
    "ov-main-key",
    "main",
    5_000,
    "",
    "",
    undefined,
    { transport },
  );
}

describe("OpenVikingClient.removeResource", () => {
  it("forwards the full filesystem remove API surface", async () => {
    const calls: Array<{ url: string; method?: string; actor?: string | null }> = [];
    const transport: HttpTransport = vi.fn(async (url, init) => {
      calls.push({
        url,
        method: init.method,
        actor: new Headers(init.headers ?? {}).get("X-OpenViking-Actor-Peer"),
      });
      return new Response(JSON.stringify({
        status: "ok",
        result: {
          uri: "viking://resources/workspace",
          estimated_deleted_count: 6,
          semantic_status: "complete",
          queue_status: { Semantic: { processed: 1 } },
        },
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const result = await makeClient(transport).removeResource({
      uri: "viking://resources/workspace",
      recursive: true,
      wait: true,
      timeout: 4,
    }, "main_peer");

    expect(calls).toHaveLength(1);
    const requestUrl = new URL(calls[0].url);
    expect(requestUrl.pathname).toBe("/api/v1/fs");
    expect(requestUrl.searchParams.get("uri")).toBe("viking://resources/workspace");
    expect(requestUrl.searchParams.get("recursive")).toBe("true");
    expect(requestUrl.searchParams.get("wait")).toBe("true");
    expect(requestUrl.searchParams.get("timeout")).toBe("4");
    expect(calls[0].method).toBe("DELETE");
    expect(calls[0].actor).toBe("main_peer");
    expect(result).toMatchObject({
      uri: "viking://resources/workspace",
      estimated_deleted_count: 6,
      semantic_status: "complete",
    });
  });

  it("omits timeout when the caller does not provide it", async () => {
    let url = "";
    const transport: HttpTransport = vi.fn(async (requestUrl) => {
      url = requestUrl;
      return new Response(JSON.stringify({ status: "ok", result: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    await makeClient(transport).removeResource({ uri: "viking://resources/a" });
    const requestUrl = new URL(url);
    expect(requestUrl.searchParams.get("recursive")).toBe("false");
    expect(requestUrl.searchParams.get("wait")).toBe("false");
    expect(requestUrl.searchParams.has("timeout")).toBe(false);
  });
});

type ToolFactory = (ctx: Record<string, unknown>) => {
  name: string;
  parameters: { properties?: Record<string, unknown> };
  execute: (id: string, params: Record<string, unknown>) => Promise<unknown>;
};

function setupTools(options: { enableRemoveResourceTool: boolean }) {
  const factories = new Map<string, ToolFactory>();
  const removeResource = vi.fn(async () => ({
    uri: "viking://resources/workspace",
    estimated_deleted_count: 6,
    semantic_status: "complete",
  }));
  const getClient = vi.fn(async () => ({
    addResource: vi.fn(),
    addSkill: vi.fn(),
    removeResource,
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
    enableAddResourceTool: false,
    enableRemoveResourceTool: options.enableRemoveResourceTool,
  });

  return { factories, getClient, removeResource };
}

describe("remove_resource agent tool", () => {
  it("is not registered unless enableRemoveResourceTool is true", () => {
    expect(setupTools({ enableRemoveResourceTool: false }).factories.has("remove_resource")).toBe(false);
    expect(setupTools({ enableRemoveResourceTool: true }).factories.has("remove_resource")).toBe(true);
  });

  it("publishes uri, recursive, wait, and timeout parameters", () => {
    const { factories } = setupTools({ enableRemoveResourceTool: true });
    const tool = factories.get("remove_resource")!({});
    expect(Object.keys(tool.parameters.properties ?? {})).toEqual([
      "uri",
      "recursive",
      "wait",
      "timeout",
    ]);
  });

  it.each([
    ["viking://user/memories/a", "non-resource"],
    ["viking://agent/skills/a", "non-resource"],
    ["viking://resources", "resources root"],
    ["viking://resources/../user/memories/a", "unsafe"],
  ])("rejects %s before calling the server (%s)", async (uri) => {
    const { factories, getClient, removeResource } = setupTools({ enableRemoveResourceTool: true });
    const tool = factories.get("remove_resource")!({});
    const result = await tool.execute("call-1", { uri }) as {
      details?: { action?: string };
    };
    expect(result.details?.action).toBe("rejected");
    expect(getClient).not.toHaveBeenCalled();
    expect(removeResource).not.toHaveBeenCalled();
  });

  it("routes a valid removal through the current agent account and preserves all parameters", async () => {
    const { factories, getClient, removeResource } = setupTools({ enableRemoveResourceTool: true });
    const tool = factories.get("remove_resource")!({ agentId: "main" });
    const result = await tool.execute("call-1", {
      uri: "viking://resources/workspace/",
      recursive: true,
      wait: true,
      timeout: 900,
    }) as {
      details?: Record<string, unknown>;
      content?: Array<{ text?: string }>;
    };

    expect(getClient).toHaveBeenCalledWith("main");
    expect(removeResource).toHaveBeenCalledWith({
      uri: "viking://resources/workspace",
      recursive: true,
      wait: true,
      timeout: 900,
    }, "main_peer");
    expect(result.details).toMatchObject({
      action: "resource_removed",
      uri: "viking://resources/workspace",
      estimated_deleted_count: 6,
      semantic_status: "complete",
    });
    expect(result.content?.[0]?.text).toContain("Removed OpenViking resource");
  });
});

describe("remove_resource config gating", () => {
  it("stays disabled even under enabledTools=all unless its explicit flag is enabled", () => {
    const cfg = memoryOpenVikingConfigSchema.parse({ enabledTools: "all" });
    expect(cfg.enableRemoveResourceTool).toBe(false);
    expect(cfg.enabledTools).not.toContain("remove_resource");
  });

  it("joins enabledTools=all when enableRemoveResourceTool=true", () => {
    const cfg = memoryOpenVikingConfigSchema.parse({
      enableRemoveResourceTool: true,
      enabledTools: "all",
    });
    expect(cfg.enableRemoveResourceTool).toBe(true);
    expect(cfg.enabledTools).toContain("remove_resource");
  });
});
