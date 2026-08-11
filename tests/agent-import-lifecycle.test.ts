import { describe, expect, it, vi } from "vitest";

import { registerOpenVikingImportTools } from "../plugin/openviking-import-tools.js";

type ToolFactory = (ctx: Record<string, unknown>) => {
  name: string;
  parameters: { properties?: Record<string, unknown> };
  execute: (id: string, params: Record<string, unknown>) => Promise<unknown>;
};

function setup() {
  const factories = new Map<string, ToolFactory>();
  const addSkill = vi.fn(async () => ({
    status: "success",
    uri: "viking://agent/skills/demo",
    task_id: "task-skill-1",
  }));
  registerOpenVikingImportTools({
    registerTool: (factory, meta) => factories.set(meta.name, factory as ToolFactory),
    getClient: vi.fn(async () => ({
      addResource: vi.fn(),
      removeResource: vi.fn(),
      addSkill,
    })),
    resolvePluginSessionRouting: () => ({ agentId: "main", actorPeerId: "main_peer" }),
    isBypassedSession: () => false,
    makeBypassedToolResult: vi.fn(),
    enableAddResourceTool: false,
    enableRemoveResourceTool: false,
  });
  return { factories, addSkill };
}

describe("agent-facing asynchronous import lifecycle", () => {
  it("keeps add_skill wait/timeout out of the schema and forces wait=false", async () => {
    const { factories, addSkill } = setup();
    const tool = factories.get("add_skill")!({ agentId: "main" });
    expect(Object.keys(tool.parameters.properties ?? {})).toEqual(["source", "data"]);
    const result = await tool.execute("call", {
      source: "/workspace/SKILL.md",
      wait: true,
      timeout: 1,
    }) as { details?: Record<string, unknown>; content?: Array<{ text?: string }> };
    expect(addSkill).toHaveBeenCalledWith({
      path: "/workspace/SKILL.md",
      data: undefined,
      wait: false,
    }, "main_peer");
    expect(result.details).toMatchObject({
      action: "skill_import_accepted",
      processing: "asynchronous",
      task_id: "task-skill-1",
    });
    expect(result.content?.[0]?.text).toContain("asynchronous processing");
  });

  it("reports an unknown outcome instead of silently retrying a skill mutation", async () => {
    const { factories, addSkill } = setup();
    addSkill.mockRejectedValueOnce(Object.assign(new Error("fetch failed: ECONNRESET"), { name: "TypeError" }));
    const result = await factories.get("add_skill")!({}).execute("call", { data: { name: "demo" } }) as {
      details?: Record<string, unknown>;
    };
    expect(addSkill).toHaveBeenCalledTimes(1);
    expect(result.details).toMatchObject({
      action: "skill_import_outcome_unknown",
      outcome: "unknown",
      retry_safe: false,
    });
  });
});
