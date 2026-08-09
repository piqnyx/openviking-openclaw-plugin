import { describe, expect, it, vi } from "vitest";

import { SYSTEM_AGENT_ID } from "../agent-keys.js";
import { createOpenVikingSessionRoutingRuntime } from "../plugin/openviking-session-routing-runtime.js";

const makeRuntime = () => {
  const logger = { info: vi.fn(), warn: vi.fn() };
  const runtime = createOpenVikingSessionRoutingRuntime({
    peerRole: "none",
    peerPrefix: "",
    logFindRequests: false,
    logger,
  });
  return { runtime, logger };
};

describe("session → agent attribution", () => {
  it("takes the agent from an OpenClaw session key", () => {
    const { runtime } = makeRuntime();

    expect(runtime.resolveAgentId("session-1", "agent:igor:telegram:42")).toBe("igor");
  });

  it("remembers the agent a hook reported and reuses it for later calls", () => {
    const { runtime } = makeRuntime();

    runtime.rememberSessionAgentId({
      agentId: "willi",
      sessionId: "11111111-2222-3333-4444-555555555555",
    });

    expect(runtime.resolveAgentId("11111111-2222-3333-4444-555555555555")).toBe("willi");
  });

  it("falls back to the system sentinel instead of guessing main", () => {
    const { runtime } = makeRuntime();

    // Upstream answers "main" here, which under per-agent accounts would file
    // unattributable data in the main agent's OpenViking account.
    expect(runtime.resolveAgentId("unknown-session")).toBe(SYSTEM_AGENT_ID);
    expect(runtime.resolveAgentId(undefined, undefined, undefined)).toBe(SYSTEM_AGENT_ID);
  });

  it("warns once per session about unattributed traffic", () => {
    const { runtime, logger } = makeRuntime();

    runtime.resolveAgentId("unknown-session");
    runtime.resolveAgentId("unknown-session");
    runtime.resolveAgentId("other-unknown-session");

    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/system\s+OpenViking account/));
  });

  it('emits no peer identity while peer_role is "none"', () => {
    const { runtime } = makeRuntime();

    const session = runtime.resolvePluginSessionRouting({
      agentId: "igor",
      sessionId: "session-1",
      sessionKey: "agent:igor:telegram:42",
      senderId: "telegram:42",
    });

    expect(session.agentId).toBe("igor");
    expect(session.actorPeerId).toBeUndefined();
  });
});

describe("отбор записей по уровню", () => {
  // Регресс: было `!m.level || m.level === 2`. У описаний каталогов level = 0,
  // а `!0` в JS истинно, поэтому L0 проскакивал сквозь фильтр и вытеснял
  // настоящие записи из выдачи memory_recall.
  const leafOnly = <T extends { level?: number }>(items: T[]): T[] =>
    items.filter((m) => m.level === undefined || m.level === 2);

  it("отбрасывает описания каталогов и оставляет записи", () => {
    const items = [
      { uri: "a/.abstract.md", level: 0 },
      { uri: "b/.overview.md", level: 1 },
      { uri: "c/fact.md", level: 2 },
      { uri: "d/unknown.md" },
    ];

    expect(leafOnly(items).map((i) => i.uri)).toEqual(["c/fact.md", "d/unknown.md"]);
  });
});

describe("explicitly stated agent ids", () => {
  it("attributes a context that names its agent but has no session identity yet", () => {
    const { runtime, logger } = makeRuntime();

    const session = runtime.resolvePluginSessionRouting({ agentId: "kate" });

    expect(session.agentId).toBe("kate");
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("sanitizes stated ids the same way remembered ones are sanitized", () => {
    const { runtime } = makeRuntime();

    expect(runtime.resolvePluginSessionRouting({ agentId: "agent:kate" }).agentId).toBe(
      "agent_kate",
    );
  });
});
