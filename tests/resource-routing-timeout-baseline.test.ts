import { describe, expect, it } from "vitest";

import { parseResourceRoutingConfig } from "../resource-routing/config.js";

describe("resource routing timeout baseline", () => {
  it("allows enough time for first-run batch category embedding", () => {
    const cfg = parseResourceRoutingConfig(undefined);
    expect(cfg.embedding.timeoutMs).toBe(30_000);
    expect(cfg.reranker.timeoutMs).toBe(3_000);
  });
});
