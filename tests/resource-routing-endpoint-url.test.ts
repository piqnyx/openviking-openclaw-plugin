import { describe, expect, it } from "vitest";

import { parseResourceRoutingConfig } from "../resource-routing/config.js";

describe("resource routing endpoint URLs", () => {
  it("allows http/https endpoints with an optional path prefix", () => {
    expect(parseResourceRoutingConfig({
      embedding: { baseUrl: "https://ml.example.test/api/" },
    }).embedding.baseUrl).toBe("https://ml.example.test/api");
  });

  it.each([
    "https://user:pass@ml.example.test",
    "https://ml.example.test/api?token=x",
    "https://ml.example.test/api#fragment",
    "ftp://ml.example.test",
  ])("rejects ambiguous or secret-bearing baseUrl %s", (baseUrl) => {
    expect(() => parseResourceRoutingConfig({ embedding: { baseUrl } })).toThrow(/baseUrl/);
  });

  it.each([
    "v1/embeddings",
    "//other-host/v1/embeddings",
    "/v1/../secret",
    "/v1/embeddings?x=1",
    "/v1/embeddings#x",
    "/v1\\embeddings",
  ])("rejects unsafe endpointPath %s", (endpointPath) => {
    expect(() => parseResourceRoutingConfig({ embedding: { endpointPath } })).toThrow(/endpointPath/);
  });
});
