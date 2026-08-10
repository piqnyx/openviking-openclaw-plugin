import { describe, expect, it, vi } from "vitest";

import { parseResourceRoutingConfig } from "../resource-routing/config.js";
import { ResourceRoutingManager } from "../resource-routing/manager.js";
import { parseResourceTaxonomy } from "../resource-routing/taxonomy.js";

describe("resource routing fallback integrity", () => {
  it("rejects an agent taxonomy whose configured fallback category is missing before explicit category routing", async () => {
    const cfg = parseResourceRoutingConfig({
      enabled: true,
      fallbackCategory: "inbox",
      embedding: { dimensions: 2 },
    });
    const manager = new ResourceRoutingManager(
      cfg,
      { info: vi.fn(), warn: vi.fn() },
      {
        loadTaxonomy: async () => parseResourceTaxonomy({
          schemaVersion: 1,
          categories: {
            docs: {
              segment: "documents",
              description: "Documents.",
            },
          },
        }),
      },
    );

    await expect(manager.resolveCategory("main", "docs"))
      .rejects.toThrow(/fallback category does not exist/);
  });
});
