import { describe, expect, it, vi } from "vitest";

import type { HttpTransport } from "../adapters/http-transport.js";
import type { ResourcePackager } from "../adapters/resource-packager.js";
import { OpenVikingClient } from "../client.js";

function makeClient(transport: HttpTransport) {
  const resourcePackager: ResourcePackager = {
    prepareResourceSource: vi.fn(async (source: string) => ({
      kind: "remote" as const,
      path: source,
    })),
    prepareLocalUploadSource: vi.fn(),
    createTempUploadBody: vi.fn(),
    cleanup: vi.fn(async () => undefined),
  };
  return new OpenVikingClient(
    "http://127.0.0.1:1933",
    "ov-key",
    "main",
    5_000,
    "",
    "",
    undefined,
    { transport, resourcePackager },
  );
}

describe("OpenVikingClient.addResource create_parent parity", () => {
  it("forwards create_parent with parent to the OpenViking resource API", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const transport: HttpTransport = vi.fn(async (_url, init) => {
      requestBody = JSON.parse(String(init.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        status: "ok",
        result: { status: "success", root_uri: "viking://resources/docs/item" },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });

    await makeClient(transport).addResource({
      pathOrUrl: "https://example.test/item.md",
      parent: "viking://resources/docs",
      createParent: true,
      wait: true,
    }, "main_peer");

    expect(requestBody).toMatchObject({
      parent: "viking://resources/docs",
      create_parent: true,
      path: "https://example.test/item.md",
      wait: true,
    });
  });

  it("rejects createParent without parent before making any HTTP request", async () => {
    const transport: HttpTransport = vi.fn(async () => {
      throw new Error("must not be called");
    });

    await expect(makeClient(transport).addResource({
      pathOrUrl: "https://example.test/item.md",
      createParent: true,
    })).rejects.toThrow(/createParent.*requires.*parent/);
    expect(transport).not.toHaveBeenCalled();
  });
});
