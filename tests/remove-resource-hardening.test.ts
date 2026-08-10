import { describe, expect, it, vi } from "vitest";

import type { HttpTransport } from "../adapters/http-transport.js";
import { OpenVikingClient, validateRemovableResourceUri } from "../client.js";
import { memoryOpenVikingConfigSchema } from "../config.js";

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

const refusedUris = [
  "viking://user/memories/a",
  "viking://user/sessions/a",
  "viking://agent/skills/a",
  "viking://resources",
  "viking://resources/",
  "viking://resources/../user/memories/a",
  "viking://resources/./a",
  "viking://resources/a//b",
  "viking://resources/a\\b",
  "viking://resources/a?ignored=suffix",
] as const;

describe("remove_resource resource boundary", () => {
  it.each(refusedUris)("rejects %s", (uri) => {
    expect(validateRemovableResourceUri(uri).ok).toBe(false);
  });

  it("accepts a normal resource descendant and normalizes trailing slashes", () => {
    expect(validateRemovableResourceUri("  viking://resources/workspace/docs///  ")).toEqual({
      ok: true,
      uri: "viking://resources/workspace/docs",
    });
  });

  it.each([
    "viking://resources/%2e%2e",
    "viking://resources/a%2Fb",
    "viking://resources/a%5Cb",
    "viking://resources/100%",
  ])("does not invent percent-decoding semantics for %s", (uri) => {
    expect(validateRemovableResourceUri(uri)).toEqual({ ok: true, uri });
  });

  it.each(refusedUris)("enforces the same boundary in OpenVikingClient.removeResource for %s", async (uri) => {
    const transport: HttpTransport = vi.fn(async () => {
      throw new Error("transport must not be reached");
    });
    const client = makeClient(transport);
    await expect(client.removeResource({ uri })).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
  });

  it("passes a literal percent-encoded segment through as data", async () => {
    let requestUrl = "";
    const transport: HttpTransport = vi.fn(async (url) => {
      requestUrl = url;
      return new Response(JSON.stringify({ status: "ok", result: { uri: "viking://resources/%2e%2e" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    await makeClient(transport).removeResource({ uri: "viking://resources/%2e%2e" });
    expect(new URL(requestUrl).searchParams.get("uri")).toBe("viking://resources/%2e%2e");
  });
});

describe("remove_resource fail-closed configuration", () => {
  it("does not enable remove_resource merely because it is explicitly selected", () => {
    const cfg = memoryOpenVikingConfigSchema.parse({ enabledTools: ["remove_resource"] });
    expect(cfg.enableRemoveResourceTool).toBe(false);
    expect(cfg.enabledTools).not.toContain("remove_resource");
  });

  it("lets disabledTools win even when the explicit safety flag is enabled", () => {
    const cfg = memoryOpenVikingConfigSchema.parse({
      enableRemoveResourceTool: true,
      enabledTools: "all",
      disabledTools: ["remove_resource"],
    });
    expect(cfg.enableRemoveResourceTool).toBe(true);
    expect(cfg.enabledTools).not.toContain("remove_resource");
    expect(cfg.disabledTools).toContain("remove_resource");
  });
});
