import { describe, expect, it, vi } from "vitest";

import { loadAgentKeys, parseAgentKeysConf, SYSTEM_AGENT_ID } from "../agent-keys.js";

const silentLogger = () => ({ info: vi.fn(), warn: vi.fn() });

describe("parseAgentKeysConf", () => {
  it("reads agent = key pairs, ignoring comments, blanks and section headers", () => {
    const entries = parseAgentKeysConf(
      [
        "# openviking agent keys",
        "; another comment style",
        "[agents]",
        "",
        "main = ov-main-key",
        "  igor   =   ov-igor-key  ",
        'kate = "ov-kate-key"',
        "tina = 'ov-tina-key'",
      ].join("\n"),
      "secrets.conf",
    );

    expect([...entries.entries()]).toEqual([
      ["main", "ov-main-key"],
      ["igor", "ov-igor-key"],
      ["kate", "ov-kate-key"],
      ["tina", "ov-tina-key"],
    ]);
  });

  it("keeps `=` inside a key value", () => {
    const entries = parseAgentKeysConf("main = ov-key=with=equals", "secrets.conf");
    expect(entries.get("main")).toBe("ov-key=with=equals");
  });

  it.each([
    ["a line without a separator", "main ov-key", /expected "<agent> = <api key>"/],
    ["an empty value", "main =", /has an empty key/],
    ["a missing name", "= ov-key", /missing agent name/],
    ["an unusable agent name", "my agent = ov-key", /must match \[A-Za-z0-9_-\]\+/],
    ["the reserved sentinel", `${SYSTEM_AGENT_ID} = ov-key`, /reserved/],
    ["a duplicate agent", "main = ov-a\nmain = ov-b", /defined twice/],
  ])("rejects %s", (_label, text, expected) => {
    expect(() => parseAgentKeysConf(text, "secrets.conf")).toThrow(expected);
  });

  it("reports the offending line number", () => {
    expect(() => parseAgentKeysConf("# ok\nmain = ov-key\nbroken\n", "secrets.conf")).toThrow(
      /secrets\.conf:3/,
    );
  });
});

describe("loadAgentKeys", () => {
  const load = (text: string, systemApiKey = "ov-system-key", mode = 0o600) =>
    loadAgentKeys({
      filePath: "/etc/openviking/secrets.conf",
      systemApiKey,
      logger: silentLogger(),
      readFile: () => text,
      statMode: () => mode,
    });

  it("routes each agent to its own key", () => {
    const resolver = load("main = ov-main-key\nigor = ov-igor-key");

    expect(resolver.resolve("main")).toEqual({
      apiKey: "ov-main-key",
      account: "main",
      attributed: true,
    });
    expect(resolver.resolve("igor")).toEqual({
      apiKey: "ov-igor-key",
      account: "igor",
      attributed: true,
    });
    expect(resolver.agentNames).toEqual(["igor", "main"]);
  });

  it("sends unattributable traffic to the system account, never to another agent", () => {
    const resolver = load("main = ov-main-key");
    const system = { apiKey: "ov-system-key", account: SYSTEM_AGENT_ID, attributed: false };

    expect(resolver.resolve(undefined)).toEqual(system);
    expect(resolver.resolve("")).toEqual(system);
    expect(resolver.resolve(SYSTEM_AGENT_ID)).toEqual(system);
    // An agent that exists in OpenClaw but has no key yet.
    expect(resolver.resolve("kate")).toEqual(system);
  });

  it("refuses a map where two agents share one key", () => {
    expect(() => load("main = ov-same\nigor = ov-same")).toThrow(/share the\s+same API key/);
  });

  it("refuses an agent key that equals the system key", () => {
    expect(() => load("main = ov-system-key")).toThrow(/same API key as the system/);
  });

  it("refuses agent keys without a system fallback key", () => {
    expect(() => load("main = ov-main-key", "")).toThrow(/system fallback account\) is empty/);
  });

  it("warns when the secrets file is readable beyond its owner", () => {
    const logger = silentLogger();
    loadAgentKeys({
      filePath: "/etc/openviking/secrets.conf",
      systemApiKey: "ov-system-key",
      logger,
      readFile: () => "main = ov-main-key",
      statMode: () => 0o644,
    });

    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/chmod 600/));
  });

  it("surfaces the path when the file cannot be read", () => {
    expect(() =>
      loadAgentKeys({
        filePath: "/etc/openviking/missing.conf",
        systemApiKey: "ov-system-key",
        logger: silentLogger(),
        readFile: () => {
          throw new Error("ENOENT");
        },
      }),
    ).toThrow(/cannot read agentKeysFile \/etc\/openviking\/missing\.conf/);
  });

  it("falls back to a single shared account when no file is configured", () => {
    const logger = silentLogger();
    const resolver = loadAgentKeys({ systemApiKey: "ov-system-key", logger });

    expect(resolver.resolve("main")).toEqual({
      apiKey: "ov-system-key",
      account: SYSTEM_AGENT_ID,
      attributed: false,
    });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/no isolation/));
  });
});
