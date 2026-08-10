import { describe, expect, it, vi } from "vitest";

import { OpenVikingClient } from "../client.js";
import type { HttpTransport } from "../adapters/http-transport.js";

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

describe("OpenVikingClient addResource create_parent parity", () => {
  it("forwards create_parent=true with parent to the OpenViking resources API", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const transport: HttpTransport = vi.fn(async (url, init) => {
      if (url.endsWith("/api/v1/resources")) {
        requestBody = JSON.parse(String(init.body));
        return new Response(JSON.stringify({
          status: "ok",
          result: { status: "success", root_uri: "viking://resources/documents/file.md" },
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`unexpected URL: ${url}`);
    });

    await makeClient(transport).addResource({
      pathOrUrl: "https://example.test/file.md",
      parent: "viking://resources/documents",
      createParent: true,
      wait: true,
    }, "main_peer");

    expect(requestBody).toMatchObject({
      path: "https://example.test/file.md",
      parent: "viking://resources/documents",
      create_parent: true,
      wait: true,
    });
  });

  it("rejects createParent=true without parent before making a request", async () => {
    const transport: HttpTransport = vi.fn(async () => {
      throw new Error("transport should not be called");
    });
    await expect(makeClient(transport).addResource({
      pathOrUrl: "https://example.test/file.md",
      createParent: true,
    })).rejects.toThrow("'createParent' requires 'parent'");
    expect(transport).not.toHaveBeenCalled();
  });
});
