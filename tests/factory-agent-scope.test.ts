import { describe, expect, it, vi } from "vitest";

import { SYSTEM_AGENT_ID } from "../agent-keys.js";
import { agentIdFromFactoryContext } from "../routing/factory-agent-id.js";
import { registerOpenVikingContextEngine } from "../plugin/openviking-context-engine-registration.js";

describe("agentIdFromFactoryContext", () => {
  it("reads the agent id out of agentDir", () => {
    expect(
      agentIdFromFactoryContext({ agentDir: "/home/openclaw/.openclaw/agents/test1/agent" }),
    ).toBe("test1");
  });

  it("falls back to the per-agent workspace layout", () => {
    expect(
      agentIdFromFactoryContext({ workspaceDir: "/home/openclaw/.openclaw/workspace/igor" }),
    ).toBe("igor");
  });

  it("prefers agentDir when both are present", () => {
    expect(
      agentIdFromFactoryContext({
        agentDir: "/home/openclaw/.openclaw/agents/kate/agent",
        workspaceDir: "/srv/projects/shared-checkout",
      }),
    ).toBe("kate");
  });

  it("ignores a workspace that is not the per-agent layout", () => {
    // A project checkout shared by several agents must not be read as an id.
    expect(agentIdFromFactoryContext({ workspaceDir: "/srv/projects/shared-checkout" })).toBe(
      undefined,
    );
  });

  it.each([
    ["no context", undefined],
    ["empty object", {}],
    ["blank strings", { agentDir: "   ", workspaceDir: "" }],
    ["non-strings", { agentDir: 42, workspaceDir: null }],
  ])("returns undefined for %s", (_label, ctx) => {
    expect(agentIdFromFactoryContext(ctx as never)).toBe(undefined);
  });

  it("sanitizes ids the same way peer headers are sanitized", () => {
    expect(agentIdFromFactoryContext({ agentDir: "/x/agents/my agent/agent" })).toBe("my_agent");
  });
});

type Registered = (ctx?: { agentDir?: string; workspaceDir?: string }) => unknown;

function setupRegistration(sessionResolves: string) {
  let registered: Registered | undefined;
  const rememberSessionAgentId = vi.fn();
  const createContextEngine = vi.fn((params: { resolveAgentId: unknown }) => params);

  registerOpenVikingContextEngine({
    api: {
      registerContextEngine: (_id, factory) => {
        registered = factory as Registered;
      },
    },
    plugin: { id: "openviking", name: "OpenViking" },
    version: "test",
    cfg: {},
    logger: { info: vi.fn(), warn: vi.fn() },
    getClient: async () => ({}),
    resolveAgentId: () => sessionResolves,
    rememberSessionAgentId,
    queryConfigStore: {},
    traceRecorder: {},
    createContextEngine: createContextEngine as never,
    setContextEngineRef: vi.fn(),
  });

  expect(registered).toBeTypeOf("function");
  return { registered: registered as Registered, rememberSessionAgentId, createContextEngine };
}

describe("context engine scoped to its agent", () => {
  it("uses the factory's agent when the session cannot be resolved", () => {
    const { registered, rememberSessionAgentId } = setupRegistration(SYSTEM_AGENT_ID);

    const engine = registered({ agentDir: "/home/openclaw/.openclaw/agents/test1/agent" }) as {
      resolveAgentId: (a?: string, b?: string, c?: string) => string;
    };

    expect(engine.resolveAgentId("session-uuid")).toBe("test1");
    expect(rememberSessionAgentId).toHaveBeenCalledWith({
      agentId: "test1",
      sessionId: "session-uuid",
      sessionKey: undefined,
      ovSessionId: undefined,
    });
  });

  it("keeps a session-resolved agent over the factory's", () => {
    const { registered, rememberSessionAgentId } = setupRegistration("igor");

    const engine = registered({ agentDir: "/home/openclaw/.openclaw/agents/test1/agent" }) as {
      resolveAgentId: (a?: string) => string;
    };

    expect(engine.resolveAgentId("session-uuid")).toBe("igor");
    expect(rememberSessionAgentId).not.toHaveBeenCalled();
  });

  it("still falls back to the system account when the factory has no agent either", () => {
    const { registered } = setupRegistration(SYSTEM_AGENT_ID);

    const engine = registered({}) as { resolveAgentId: (a?: string) => string };

    expect(engine.resolveAgentId("session-uuid")).toBe(SYSTEM_AGENT_ID);
  });
});
