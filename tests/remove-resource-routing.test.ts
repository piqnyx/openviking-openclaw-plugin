import { describe, expect, it, vi } from "vitest";

import type { HttpTransport } from "../adapters/http-transport.js";
import { loadAgentKeys } from "../agent-keys.js";
import { createOpenVikingClientRuntime } from "../plugin/openviking-client-runtime.js";
import { registerOpenVikingImportTools } from "../plugin/openviking-import-tools.js";

type ToolFactory = (ctx?: { agentId?: string }) => {
  execute: (id: string, params: Record<string, unknown>) => Promise<unknown>;
};

function setup() {
  const calls: Array<{ key: string | null; wait: string | null; uri: string | null }> = [];
  const transport: HttpTransport = vi.fn(async (url, init) => {
    const parsed = new URL(url);
    const wait = parsed.searchParams.get("wait");
    calls.push({
      key: new Headers(init.headers ?? {}).get("X-API-Key"),
      wait,
      uri: parsed.searchParams.get("uri"),
    });
    return new Response(JSON.stringify({
      status: "ok",
      result: {
        uri: parsed.searchParams.get("uri"),
        estimated_deleted_count: 1,
        semantic_root_uri: "viking://resources",
        semantic_status: wait === "true" ? "complete" : "queued",
        queue_status: wait === "true" ? { Semantic: { error_count: 0 } } : undefined,
      },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  });

  const agentKeys = loadAgentKeys({
    filePath: "/etc/openviking/secrets.conf",
    systemApiKey: "ov-system-key",
    logger: { info: vi.fn(), warn: vi.fn() },
    readFile: () => "main = ov-main-key\nigor = ov-igor-key\n",
    statMode: () => 0o600,
  });
  const runtime = createOpenVikingClientRuntime({
    cfg: {
      baseUrl: "http://127.0.0.1:1933",
      apiKey: "ov-system-key",
      peer_role: "none",
      peer_prefix: "",
      timeoutMs: 5_000,
      logFindRequests: false,
    },
    rawPeerPrefix: undefined,
    agentKeys,
    logger: { info: vi.fn() },
    transport,
  });

  const factories = new Map<string, ToolFactory>();
  registerOpenVikingImportTools({
    registerTool: (factory, meta) => factories.set(meta.name, factory as ToolFactory),
    getClient: runtime.getClient,
    resolvePluginSessionRouting: (ctx) => ({ agentId: ctx?.agentId ?? "__system__" }),
    isBypassedSession: () => false,
    makeBypassedToolResult: vi.fn(),
    enableAddResourceTool: false,
    enableRemoveResourceTool: true,
  });
  return { calls, tool: factories.get("remove_resource")! };
}

describe("remove_resource end-to-end plugin routing", () => {
  it("uses the current agent account and returns after deletion without waiting for semantic refresh", async () => {
    const { calls, tool } = setup();
    const result = await tool({ agentId: "main" }).execute("call-main", {
      uri: "viking://resources/workspace",
      recursive: true,
    }) as { details?: Record<string, unknown>; content?: Array<{ text?: string }> };
    expect(calls).toEqual([{ key: "ov-main-key", wait: "false", uri: "viking://resources/workspace" }]);
    expect(result.details).toMatchObject({ action: "resource_removed", processing: "semantic_refresh_queued", semantic_status: "queued" });
    expect(result.content?.[0]?.text).toContain("continues asynchronously");
  });

  it("keeps agent accounts isolated while semantic cleanup remains asynchronous", async () => {
    const { calls, tool } = setup();
    const result = await tool({ agentId: "igor" }).execute("call-igor", {
      uri: "viking://resources/workspace",
      wait: false,
    }) as { details?: Record<string, unknown>; content?: Array<{ text?: string }> };
    expect(calls).toEqual([{ key: "ov-igor-key", wait: "false", uri: "viking://resources/workspace" }]);
    expect(result.details).toMatchObject({ action: "resource_removed", semantic_status: "queued" });
    expect(result.content?.[0]?.text).toContain("continues asynchronously");
  });
});
