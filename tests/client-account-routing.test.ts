import { describe, expect, it, vi } from "vitest";

import { loadAgentKeys, SYSTEM_AGENT_ID } from "../agent-keys.js";
import type { HttpTransport } from "../adapters/http-transport.js";
import { createOpenVikingClientRuntime } from "../plugin/openviking-client-runtime.js";

const KEYS = ["main = ov-main-key", "igor = ov-igor-key"].join("\n");

function setup() {
  const sentKeys: Array<string | null> = [];
  const transport: HttpTransport = vi.fn(async (_url, init) => {
    const headers = new Headers(init.headers ?? {});
    sentKeys.push(headers.get("X-API-Key"));
    return new Response(JSON.stringify({ status: "ok", result: {} }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });

  const agentKeys = loadAgentKeys({
    filePath: "/etc/openviking/secrets.conf",
    systemApiKey: "ov-system-key",
    logger: { info: vi.fn(), warn: vi.fn() },
    readFile: () => KEYS,
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

  return { runtime, sentKeys };
}

describe("per-agent client routing", () => {
  it("sends each agent's own API key", async () => {
    const { runtime, sentKeys } = setup();

    await (await runtime.getClient("main")).read("viking://user/memories/a");
    await (await runtime.getClient("igor")).read("viking://user/memories/a");

    expect(sentKeys).toEqual(["ov-main-key", "ov-igor-key"]);
  });

  it("uses the system key when the agent is unknown or unresolved", async () => {
    const { runtime, sentKeys } = setup();

    await (await runtime.getClient(undefined)).read("viking://user/memories/a");
    await (await runtime.getClient(SYSTEM_AGENT_ID)).read("viking://user/memories/a");
    // Configured in OpenClaw but absent from the key file.
    await (await runtime.getClient("kate")).read("viking://user/memories/a");

    expect(sentKeys).toEqual(["ov-system-key", "ov-system-key", "ov-system-key"]);
  });

  it("never lets one agent's request carry another agent's key", async () => {
    const { runtime, sentKeys } = setup();

    await (await runtime.getClient("igor")).find("secret", { targetUri: "viking://user/memories" });

    expect(sentKeys).toEqual(["ov-igor-key"]);
    expect(sentKeys).not.toContain("ov-main-key");
  });

  it("passes the requested levels through to the find body", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const transport: HttpTransport = vi.fn(async (_url, init) => {
      bodies.push(JSON.parse(String(init.body ?? "{}")));
      return new Response(JSON.stringify({ status: "ok", result: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
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
      agentKeys: loadAgentKeys({
        filePath: "/etc/openviking/secrets.conf",
        systemApiKey: "ov-system-key",
        logger: { info: vi.fn(), warn: vi.fn() },
        readFile: () => KEYS,
        statMode: () => 0o600,
      }),
      logger: { info: vi.fn() },
      transport,
    });

    const client = await runtime.getClient("main");
    // Отзыв фактов просит только записи: L0/L1 — описания каталогов, они
    // обгоняют факты по тематическому запросу и вытесняют их из выдачи.
    await client.find("кот", { targetUri: "viking://user/memories", level: [2] });
    // Без явного уровня фильтра в теле быть не должно: обзор базы видит всё.
    await client.find("кот", { targetUri: "viking://user/memories" });

    expect(bodies[0].level).toEqual([2]);
    expect(bodies[1]).not.toHaveProperty("level");
  });

  it("reuses one client per account and keeps accounts apart", async () => {
    const { runtime } = setup();

    const [mainA, mainB, igor] = await Promise.all([
      runtime.getClient("main"),
      runtime.getClient("main"),
      runtime.getClient("igor"),
    ]);

    expect(mainA).toBe(mainB);
    expect(mainA).not.toBe(igor);
  });

  it("shares a single client across every agent that falls back to the system account", async () => {
    const { runtime } = setup();

    const unknownAgent = await runtime.getClient("kate");
    const noAgent = await runtime.getClient(undefined);

    expect(unknownAgent).toBe(noAgent);
  });
});
